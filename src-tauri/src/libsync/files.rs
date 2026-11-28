//! Where each song's file is and whether the library still has it, as ops.
//!
//! A `file` is one audio (`audio_fp`), with a `path` below the library folder and a `present`
//! flag. This device writes an op when its own library changed since it last looked
//! (`file_local` remembers what it had): a song moved or renamed, a song back after it was
//! removed, a song removed. What the library simply has, and no device has said anything about
//! yet, is written with an early clock (`write::stamp_early`), so it never beats an edit.
//!
//! Removed means on purpose: deleted in the app ([`deleted_here`]), or missing below the library
//! folder for the whole grace period, or its file written over with other audio (a re-encode: the
//! new audio takes its place). A song that is only missing (a drive that is unplugged, a
//! library folder that was switched) is not removed.
//!
//! Nothing here touches a file. Songs without an `audio_fp` are left out, and of several copies
//! of one audio only one path is written.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::clock;
use super::ops::{F_PATH, F_PRESENT};
use super::recent;
use super::write::{self, Field, active};
use crate::db::FileState;
use crate::error::Error;

pub const E_FILE: &str = "file";

/// The file's size in bytes, its length, its bit rate and its sample rate: what the song list
/// shows of a song a device streams and has never read. The first device to write one is kept
/// (they are not edits), so a size goes stale after a tag edit somewhere.
pub const F_SIZE: &str = "size";
pub const F_DURATION_MS: &str = "duration_ms";
pub const F_BITRATE: &str = "bitrate";
pub const F_SAMPLE_RATE: &str = "sample_rate";

/// File size in bytes.
pub type Bytes = i64;
/// Length in milliseconds.
pub type Millis = i64;
/// Bit rate in kbit/s.
pub type Kbps = i64;
/// Sample rate in Hz.
pub type Hertz = i64;

/// What a song's file is like, as the device that has it read it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Details {
    pub size: Option<Bytes>,
    pub duration_ms: Option<Millis>,
    pub bitrate: Option<Kbps>,
    pub sample_rate: Option<Hertz>,
}

impl Details {
    fn fields(self) -> [(&'static str, Option<i64>); 4] {
        [
            (F_SIZE, self.size),
            (F_DURATION_MS, self.duration_ms),
            (F_BITRATE, self.bitrate),
            (F_SAMPLE_RATE, self.sample_rate),
        ]
    }

    /// The details the shared library has of one audio; a value that is not a whole number
    /// above zero is left out.
    pub(super) fn of(registers: &HashMap<(String, String), Value>, fp: &str) -> Self {
        let get = |f: &str| {
            registers
                .get(&(fp.to_owned(), f.to_owned()))
                .and_then(Value::as_i64)
                .filter(|v| *v > 0)
        };
        Self {
            size: get(F_SIZE),
            duration_ms: get(F_DURATION_MS),
            bitrate: get(F_BITRATE),
            sample_rate: get(F_SAMPLE_RATE),
        }
    }
}

/// Unix time in seconds, UTC.
pub type UnixSeconds = i64;

/// A file's place below the library folder: the folder names and the file name, in order.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(transparent)]
pub struct RelPath(Vec<String>);

impl RelPath {
    /// `path` as seen from `root`; `None` when it is not below it or has a name that is not text.
    pub fn below(root: &Path, path: &Path) -> Option<Self> {
        let parts: Option<Vec<String>> = path
            .strip_prefix(root)
            .ok()?
            .iter()
            .map(|part| part.to_str().map(str::to_owned))
            .collect();
        parts.filter(|parts| !parts.is_empty()).map(Self)
    }

    /// A path another device wrote, when every name in it is one a folder or file can have
    /// below the library folder: nothing that climbs out of it or names a place of its own.
    pub fn from_value(val: &Value) -> Option<Self> {
        let parts: Vec<String> = serde_json::from_value(val.clone()).ok()?;
        let plain = |part: &String| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.contains(['/', '\\', '\0'])
                // A drive letter or an alternate stream on Windows; an ordinary character on a Mac.
                && !(cfg!(windows) && part.contains(':'))
        };
        let own_folder = parts
            .first()
            .is_some_and(|first| first.eq_ignore_ascii_case(super::remote::DIR));
        (!parts.is_empty()
            && parts.iter().all(plain)
            && !parts.iter().any(|part| is_windows_device_name(part))
            && !own_folder)
            .then_some(Self(parts))
    }

    /// The file at this path in the library folder `root`.
    pub fn under(&self, root: &Path) -> PathBuf {
        self.0
            .iter()
            .fold(root.to_path_buf(), |at, part| at.join(part))
    }

    /// The same place to a file system that ignores case and the Unicode form of names.
    fn folded(&self) -> Vec<String> {
        crate::sync::folded(&self.0)
    }

    fn value(&self) -> Value {
        json!(self.0)
    }

    fn stored(&self) -> String {
        self.value().to_string()
    }

    fn from_stored(raw: &str) -> Option<Self> {
        serde_json::from_str(raw).ok().map(Self)
    }
}

/// Whether `name` is one Windows keeps for a device (`CON`, `NUL`, `COM1`, ...), with or without
/// an extension: a file called that cannot be made there, and any device may read the path.
fn is_windows_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    let stem = stem.to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix)
                .is_some_and(|n| matches!(n.as_bytes(), [b'1'..=b'9']))
        })
}

/// What the library has of one audio.
#[derive(Debug, Default)]
struct Copies {
    /// The copies that are there, below the library folder.
    here: Vec<RelPath>,
    /// A copy is there, but not below the library folder.
    elsewhere: bool,
    /// A copy is missing and may still come back: its grace period is not over, or it was never
    /// below the library folder.
    awaited: bool,
    /// The song is streamed here: having no file is not removing it.
    streamed: bool,
    /// What the first copy here is like.
    details: Details,
}

/// What this device had of one audio when it last wrote ops.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Had {
    path: RelPath,
    present: bool,
}

fn copies(
    conn: &Connection,
    root: &Path,
    expired_before: UnixSeconds,
) -> Result<BTreeMap<String, Copies>, Error> {
    let mut stmt = conn.prepare(
        "SELECT audio_fp, path, missing_since, file_state, size, duration_ms, bitrate, sample_rate
         FROM tracks WHERE audio_fp IS NOT NULL AND audio_fp <> '' ORDER BY path",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<UnixSeconds>>(2)?,
            r.get::<_, FileState>(3)?,
            Details {
                size: r.get(4)?,
                duration_ms: r.get(5)?,
                bitrate: r.get(6)?,
                sample_rate: r.get(7)?,
            },
        ))
    })?;
    let mut out: BTreeMap<String, Copies> = BTreeMap::new();
    for row in rows {
        let (fp, path, missing_since, file_state, details) = row?;
        let rel = RelPath::below(root, Path::new(&path));
        let of = out.entry(fp).or_default();
        if file_state == FileState::Streamed {
            of.streamed = true;
            continue;
        }
        match (missing_since, rel) {
            (None, Some(rel)) => {
                if of.here.is_empty() {
                    of.details = details;
                }
                of.here.push(rel);
            }
            (None, None) => of.elsewhere = true,
            (Some(since), Some(_)) if since <= expired_before => {}
            (Some(_), _) => of.awaited = true,
        }
    }
    for of in out.values_mut() {
        of.here.sort();
    }
    Ok(out)
}

fn had(conn: &Connection) -> Result<HashMap<String, Had>, Error> {
    let mut stmt = conn.prepare("SELECT audio_fp, path, present FROM file_local")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, bool>(2)?,
        ))
    })?;
    let mut out = HashMap::new();
    for row in rows {
        let (fp, path, present) = row?;
        if let Some(path) = RelPath::from_stored(&path) {
            out.insert(fp, Had { path, present });
        }
    }
    Ok(out)
}

/// Where the copy of each audio that is written about was when this device last looked, for
/// the audio it had then.
pub(super) fn tracked_paths(conn: &Connection) -> Result<HashMap<String, RelPath>, Error> {
    Ok(had(conn)?
        .into_iter()
        .filter(|(_, had)| had.present)
        .map(|(fp, had)| (fp, had.path))
        .collect())
}

fn remember(conn: &Connection, fp: &str, had: &Had) -> Result<(), Error> {
    conn.prepare_cached(
        "INSERT INTO file_local (audio_fp, path, present) VALUES (?1, ?2, ?3)
         ON CONFLICT(audio_fp) DO UPDATE SET path = excluded.path, present = excluded.present",
    )?
    .execute(params![fp, had.path.stored(), had.present])?;
    Ok(())
}

/// The value every device agrees on for each field of each `entity`: `(id, field)`.
pub(super) fn registers(
    conn: &Connection,
    entity: &str,
) -> Result<HashMap<(String, String), Value>, Error> {
    let mut stmt = conn.prepare("SELECT id, f, val FROM op_state WHERE e = ?1")?;
    let rows = stmt.query_map(params![entity], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut out = HashMap::new();
    for row in rows {
        let (fp, field, raw) = row?;
        if let Ok(val) = serde_json::from_str(&raw) {
            out.insert((fp, field), val);
        }
    }
    Ok(out)
}

/// The ops one look at the library gives rise to, about one kind of entity.
pub(super) struct Pending {
    entity: &'static str,
    /// What changed here since the last look.
    edits: Vec<Field>,
    /// What the library has that no device has written about.
    early: Vec<Field>,
}

impl Pending {
    pub(super) fn of(entity: &'static str) -> Self {
        Self {
            entity,
            edits: Vec::new(),
            early: Vec::new(),
        }
    }

    /// Decides about one field: nothing when everyone already has `val`, an edit when it
    /// `changed` here, an early op when nobody has written the field at all. A value another
    /// device wrote that differs from an unchanged library is left alone.
    pub(super) fn field(
        &mut self,
        registers: &HashMap<(String, String), Value>,
        fp: &str,
        f: &str,
        val: Value,
        changed: bool,
    ) {
        let known = registers.get(&(fp.to_owned(), f.to_owned()));
        if known == Some(&val) {
            return;
        }
        let field = Field {
            e: self.entity.to_owned(),
            id: fp.to_owned(),
            f: f.to_owned(),
            val,
        };
        if changed {
            self.edits.push(field);
        } else if known.is_none() {
            self.early.push(field);
        }
    }

    pub(super) fn write(self, conn: &Connection) -> Result<usize, Error> {
        let written = self.edits.len() + self.early.len();
        if !self.early.is_empty() {
            write::stamp_early(conn, &self.early)?;
        }
        if !self.edits.is_empty() {
            write::stamp(conn, &self.edits)?;
        }
        Ok(written)
    }
}

/// Looks at the library and writes an op for every file that is somewhere else than this device
/// last saw it, is back, or is removed: missing since `expired_before` or earlier. Returns how
/// many ops it wrote. Does nothing while library data is not shared.
pub fn record(conn: &Connection, root: &Path, expired_before: UnixSeconds) -> Result<usize, Error> {
    if !active(conn)? {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction()?;
    let copies = copies(&tx, root, expired_before)?;
    let had = had(&tx)?;
    let registers = registers(&tx, E_FILE)?;
    let mut pending = Pending::of(E_FILE);
    for (fp, of) in &copies {
        let before = had.get(fp);
        // The copy written about stays the one, while it is there.
        let kept = before.and_then(|b| of.here.iter().find(|p| **p == b.path));
        if let Some(path) = kept.or_else(|| of.here.first()) {
            let moved = before.is_some_and(|b| b.path != *path);
            let back = before.is_some_and(|b| !b.present);
            pending.field(&registers, fp, F_PATH, path.value(), moved);
            pending.field(&registers, fp, F_PRESENT, json!(true), back);
            for (f, val) in of.details.fields() {
                if let Some(val) = val.filter(|v| *v > 0) {
                    pending.field(&registers, fp, f, json!(val), false);
                }
            }
            let now = Had {
                path: path.clone(),
                present: true,
            };
            if before != Some(&now) {
                remember(&tx, fp, &now)?;
            }
        } else if let Some(before) = before.filter(|b| b.present)
            && !of.elsewhere
            && !of.awaited
            && !of.streamed
        {
            pending.field(&registers, fp, F_PRESENT, json!(false), true);
            remember(
                &tx,
                fp,
                &Had {
                    path: before.path.clone(),
                    present: false,
                },
            )?;
        }
    }
    // A song whose record is gone without this device seeing it removed says nothing, unless
    // its file was written over with other audio: then the old audio was replaced, and is removed.
    for (fp, before) in had.iter().filter(|(fp, _)| !copies.contains_key(*fp)) {
        let replaced: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM audio_changes WHERE old_fp = ?1)",
            params![fp],
            |r| r.get(0),
        )?;
        if replaced && before.present {
            pending.field(&registers, fp, F_PRESENT, json!(false), true);
        }
        tx.execute("DELETE FROM file_local WHERE audio_fp = ?1", params![fp])?;
    }
    let written = pending.write(&tx)?;
    tx.commit()?;
    Ok(written)
}

/// The user deleted these songs in the app and their files are gone: they are marked missing
/// now, and each audio that has no copy left is removed for everyone at the next sync. Returns
/// how many ops it wrote.
pub fn deleted_here(
    conn: &Connection,
    root: &Path,
    track_ids: &[i64],
    now: UnixSeconds,
) -> Result<usize, Error> {
    let tx = conn.unchecked_transaction()?;
    let mut gone: BTreeMap<String, Option<RelPath>> = BTreeMap::new();
    for id in track_ids {
        let changed = tx.execute(
            "UPDATE tracks SET missing_since = ?2 WHERE id = ?1 AND missing_since IS NULL",
            params![id, now],
        )?;
        if changed == 0 {
            continue;
        }
        let (fp, path): (Option<String>, String) = tx.query_row(
            "SELECT audio_fp, path FROM tracks WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if let Some(fp) = fp.filter(|fp| !fp.is_empty()) {
            gone.insert(fp, RelPath::below(root, Path::new(&path)));
        }
    }
    if !active(&tx)? {
        tx.commit()?;
        return Ok(0);
    }
    let had = had(&tx)?;
    let registers = registers(&tx, E_FILE)?;
    let mut pending = Pending::of(E_FILE);
    for (fp, path) in gone {
        let copy_left: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM tracks
                            WHERE audio_fp = ?1 AND missing_since IS NULL AND file_state = 'here')",
            params![fp],
            |r| r.get(0),
        )?;
        let Some(path) = had.get(&fp).map(|h| h.path.clone()).or(path) else {
            continue;
        };
        if copy_left {
            continue;
        }
        pending.field(&registers, &fp, F_PRESENT, json!(false), true);
        remember(
            &tx,
            &fp,
            &Had {
                path,
                present: false,
            },
        )?;
    }
    let written = pending.write(&tx)?;
    tx.commit()?;
    Ok(written)
}

/// A song another device moved or renamed, that is still where this device last saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Move {
    pub audio_fp: String,
    pub from: RelPath,
    pub to: RelPath,
}

/// The songs to move so the library has them where the shared library says they are. Call it
/// right after [`record`], so a move made here was written first and is not taken back. A song
/// that was removed elsewhere, or whose new path is not one a file can have, stays.
pub fn moves_wanted(conn: &Connection) -> Result<Vec<Move>, Error> {
    if !active(conn)? {
        return Ok(Vec::new());
    }
    let registers = registers(conn, E_FILE)?;
    let mut has_file = conn.prepare_cached(
        "SELECT EXISTS (SELECT 1 FROM tracks WHERE audio_fp = ?1 AND file_state = 'here')",
    )?;
    let mut out = Vec::new();
    for (fp, had) in had(conn)? {
        let field = |f: &str| registers.get(&(fp.clone(), f.to_owned()));
        if !had.present || field(F_PRESENT) == Some(&json!(false)) {
            continue;
        }
        // A streamed song has no file to move; its row follows the log (`streamed.rs`).
        if !has_file.query_row(params![fp], |r| r.get::<_, bool>(0))? {
            continue;
        }
        let Some(to) = field(F_PATH).and_then(RelPath::from_value) else {
            continue;
        };
        if to != had.path {
            out.push(Move {
                audio_fp: fp,
                from: had.path,
                to,
            });
        }
    }
    out.sort_by(|a, b| a.to.cmp(&b.to));
    Ok(out)
}

/// Where the shared library says the song with audio `fp` is, while it says the song is there.
pub fn shared_path(conn: &Connection, fp: &str) -> Result<Option<RelPath>, Error> {
    let get = |f: &str| super::state::get(conn, E_FILE, fp, f);
    if get(F_PRESENT)? != Some(json!(true)) {
        return Ok(None);
    }
    Ok(get(F_PATH)?.as_ref().and_then(RelPath::from_value))
}

/// Where the shared library last said the song with audio `fp` was, whether or not it says the
/// song is there now. A song another device removed has no place by [`shared_path`], yet the
/// destination may still hold its file.
pub fn last_known_path(conn: &Connection, fp: &str) -> Result<Option<RelPath>, Error> {
    Ok(super::state::get(conn, E_FILE, fp, F_PATH)?
        .as_ref()
        .and_then(RelPath::from_value))
}

/// The removals waiting among `audio_fps`, and for each one this device only streams, the
/// place the destination last had its file: what keeping it has to check.
pub fn waiting_with_paths(
    conn: &Connection,
    root: &Path,
    audio_fps: &[String],
) -> Result<(Vec<Removal>, std::collections::HashMap<String, RelPath>), Error> {
    let asked: Vec<Removal> = removals_waiting(conn, root)?
        .into_iter()
        .filter(|w| audio_fps.contains(&w.audio_fp))
        .collect();
    let mut paths = std::collections::HashMap::new();
    for removal in asked.iter().filter(|w| w.streamed) {
        if let Some(rel) = last_known_path(conn, &removal.audio_fp)? {
            paths.insert(removal.audio_fp.clone(), rel);
        }
    }
    Ok((asked, paths))
}

/// A song the shared library has that this library does not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Arrival {
    pub audio_fp: String,
    pub path: RelPath,
}

impl RelPath {
    /// The folder names and the file name, in order.
    pub fn parts(&self) -> &[String] {
        &self.0
    }
}

/// The songs to fetch so the library has what the shared library has: present there, with a
/// path a file can have, and nothing of them here. A song this library has a record of is not
/// fetched while that record may still find its file (a drive that is unplugged), unless the
/// song was removed here and another device kept it.
pub fn arrivals_wanted(conn: &Connection) -> Result<Vec<Arrival>, Error> {
    if !active(conn)? {
        return Ok(Vec::new());
    }
    let registers = registers(conn, E_FILE)?;
    let had = had(conn)?;
    let mut known = conn.prepare_cached(
        "SELECT COUNT(*), COALESCE(SUM(missing_since IS NULL), 0) FROM tracks WHERE audio_fp = ?1",
    )?;
    let mut out = Vec::new();
    for ((fp, f), val) in &registers {
        if f != F_PRESENT || *val != json!(true) {
            continue;
        }
        let Some(path) = registers
            .get(&(fp.clone(), F_PATH.to_owned()))
            .and_then(RelPath::from_value)
        else {
            continue;
        };
        let (records, there): (i64, i64) =
            known.query_row(params![fp], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let removed_here = had.get(fp).is_some_and(|h| !h.present);
        if there == 0 && (records == 0 || removed_here) {
            out.push(Arrival {
                audio_fp: fp.clone(),
                path,
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Why a song was not moved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stayed {
    /// Its file is not where the library last saw it.
    NotThere,
    /// Another file is already at the new path.
    Taken,
    /// The file system refused (a name it does not allow, no permission).
    Refused,
}

impl Move {
    /// Moves the file within the library folder `root`. Never writes over another file.
    pub fn carry_out(&self, root: &Path) -> Result<(), Stayed> {
        let from = self.from.under(root);
        let to = self.to.under(root);
        if !from.is_file() {
            return Err(Stayed::NotThere);
        }
        // On a file system that ignores case, a new spelling of the same name "exists" already:
        // it is the file itself.
        let respelled = self.from.folded() == self.to.folded() && same_file(&from, &to);
        if !respelled && to.symlink_metadata().is_ok() {
            return Err(Stayed::Taken);
        }
        if let Some(folder) = to.parent() {
            std::fs::create_dir_all(folder).map_err(|_| Stayed::Refused)?;
        }
        if respelled {
            return std::fs::rename(&from, &to).map_err(|_| Stayed::Refused);
        }
        // Not a rename: that would replace a file that appeared since the look above.
        crate::fsops::move_to_free_place(&from, &to).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                Stayed::Taken
            } else {
                Stayed::Refused
            }
        })
    }
}

/// Whether two paths that differ only in spelling name one file.
#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (a.metadata(), b.metadata()) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

/// Windows folders ignore case but not every way of writing an accented letter, so two
/// spellings can be one file or two: they are one when both lead to the same real path.
#[cfg(not(unix))]
fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// A song this library has that another device removed: it waits for the user to remove it here
/// too or to keep it for everyone.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    pub audio_fp: String,
    /// One of the library's copies of it, to show.
    pub track_id: i64,
    pub title: String,
    pub artist: String,
    /// Where that copy is, below the library folder when it is there.
    pub path: String,
    /// The member who removed it, by name.
    pub by: String,
    /// Whether that member is this device: it took back a song another device added.
    pub here: bool,
    /// This device only streams it: removing it here takes the song out of the library but there
    /// is no file to trash, and keeping it needs the destination to still have the file.
    pub streamed: bool,
    /// When they did.
    pub at: UnixSeconds,
}

/// The songs another device removed that are still here, by path.
pub fn removals_waiting(conn: &Connection, root: &Path) -> Result<Vec<Removal>, Error> {
    if !active(conn)? {
        return Ok(Vec::new());
    }
    let removed: Vec<(String, String)> = conn
        .prepare("SELECT id, clock FROM op_state WHERE e = ?1 AND f = ?2 AND val = 'false'")?
        .query_map(params![E_FILE, F_PRESENT], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let had = had(conn)?;
    let me = write::device_id(conn)?;
    let mut out = Vec::new();
    for (fp, at_clock) in removed {
        // A kept copy first; else the row of a song this device streams (it has no record of
        // having had a file: it never did).
        let copy: Option<(i64, String, String, String, bool)> =
            if had.get(&fp).is_some_and(|h| h.present) {
                conn.prepare_cached(
                    "SELECT id, title, artist, path, 0 FROM tracks
                 WHERE audio_fp = ?1 AND missing_since IS NULL AND file_state = 'here'
                 ORDER BY path LIMIT 1",
                )?
                .query_map(params![fp], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })?
                .next()
                .transpose()?
            } else {
                None
            };
        let copy = match copy {
            Some(copy) => Some(copy),
            None => conn
                .prepare_cached(
                    "SELECT id, title, artist, path, 1 FROM tracks
                     WHERE audio_fp = ?1 AND file_state = 'streamed'
                       AND NOT EXISTS (SELECT 1 FROM tracks k
                                       WHERE k.audio_fp = ?1 AND k.file_state = 'here'
                                         AND k.missing_since IS NULL)
                     ORDER BY path LIMIT 1",
                )?
                .query_map(params![fp], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })?
                .next()
                .transpose()?,
        };
        let Some((track_id, title, artist, path, streamed)) = copy else {
            continue;
        };
        out.push(Removal {
            audio_fp: fp,
            track_id,
            title,
            artist,
            path: RelPath::below(root, Path::new(&path)).map_or(path, |rel| rel.0.join("/")),
            by: clock::device_of(&at_clock).map_or_else(
                || recent::ANOTHER_DEVICE.to_owned(),
                |dev| recent::member_name(conn, dev),
            ),
            here: clock::device_of(&at_clock) == Some(me.as_str()),
            streamed,
            at: clock::parse(&at_clock).map_or(0, |(ms, _)| ms / 1000),
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Keeps songs another device removed: they are present again for everyone, and a device that
/// no longer has one gets it back. Songs that are not waiting are left alone. Returns how many
/// were kept.
pub fn keep(conn: &Connection, root: &Path, audio_fps: &[String]) -> Result<usize, Error> {
    let tx = conn.unchecked_transaction()?;
    let waiting = removals_waiting(&tx, root)?;
    let fields: Vec<Field> = waiting
        .iter()
        .filter(|w| audio_fps.contains(&w.audio_fp))
        .map(|w| Field {
            e: E_FILE.to_owned(),
            id: w.audio_fp.clone(),
            f: F_PRESENT.to_owned(),
            val: json!(true),
        })
        .collect();
    write::stamp(&tx, &fields)?;
    tx.commit()?;
    Ok(fields.len())
}

/// Every copy this library has of the audio in `audio_fps`, as `(track id, file)`.
pub fn copies_here(conn: &Connection, audio_fps: &[String]) -> Result<Vec<(i64, PathBuf)>, Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, path FROM tracks
         WHERE audio_fp = ?1 AND missing_since IS NULL AND file_state = 'here'",
    )?;
    let mut out = Vec::new();
    for fp in audio_fps {
        let rows = stmt.query_map(params![fp], |r| {
            Ok((r.get::<_, i64>(0)?, PathBuf::from(r.get::<_, String>(1)?)))
        })?;
        for row in rows {
            out.push(row?);
        }
    }
    Ok(out)
}
