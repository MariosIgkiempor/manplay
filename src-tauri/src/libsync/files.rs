//! Where each song's file is and whether the library still has it, as ops.
//!
//! A `file` is one audio (`audio_fp`), with a `path` below the library folder and a `present`
//! flag. This device writes an op when its own library changed since it last looked
//! (`file_local` remembers what it had): a song moved or renamed, a song back after it was
//! removed, a song removed. What the library simply has, and no device has said anything about
//! yet, is written with an early clock (`write::stamp_early`), so it never beats an edit.
//!
//! Removed means on purpose: deleted in the app ([`deleted_here`]), or missing below the library
//! folder for the whole grace period. A song that is only missing (a drive that is unplugged, a
//! library folder that was switched) is not removed.
//!
//! Nothing here touches a file. Songs without an `audio_fp` are left out, and of several copies
//! of one audio only one path is written.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::ops::{F_PATH, F_PRESENT};
use super::write::{self, Field, active};
use crate::error::Error;

pub const E_FILE: &str = "file";

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
        "SELECT audio_fp, path, missing_since FROM tracks
         WHERE audio_fp IS NOT NULL AND audio_fp <> ''",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<UnixSeconds>>(2)?,
        ))
    })?;
    let mut out: BTreeMap<String, Copies> = BTreeMap::new();
    for row in rows {
        let (fp, path, missing_since) = row?;
        let rel = RelPath::below(root, Path::new(&path));
        let of = out.entry(fp).or_default();
        match (missing_since, rel) {
            (None, Some(rel)) => of.here.push(rel),
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

fn remember(conn: &Connection, fp: &str, had: &Had) -> Result<(), Error> {
    conn.prepare_cached(
        "INSERT INTO file_local (audio_fp, path, present) VALUES (?1, ?2, ?3)
         ON CONFLICT(audio_fp) DO UPDATE SET path = excluded.path, present = excluded.present",
    )?
    .execute(params![fp, had.path.stored(), had.present])?;
    Ok(())
}

/// The value every device agrees on for each field of each file: `(audio_fp, field)`.
fn registers(conn: &Connection) -> Result<HashMap<(String, String), Value>, Error> {
    let mut stmt = conn.prepare("SELECT id, f, val FROM op_state WHERE e = ?1")?;
    let rows = stmt.query_map(params![E_FILE], |r| {
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

/// The ops one look at the library gives rise to.
#[derive(Default)]
struct Pending {
    /// What changed here since the last look.
    edits: Vec<Field>,
    /// What the library has that no device has written about.
    early: Vec<Field>,
}

impl Pending {
    /// Decides about one field: nothing when everyone already has `val`, an edit when it
    /// `changed` here, an early op when nobody has written the field at all. A value another
    /// device wrote that differs from an unchanged library is left alone.
    fn field(
        &mut self,
        registers: &HashMap<(String, String), Value>,
        fp: &str,
        f: &'static str,
        val: Value,
        changed: bool,
    ) {
        let known = registers.get(&(fp.to_owned(), f.to_owned()));
        if known == Some(&val) {
            return;
        }
        let field = Field {
            e: E_FILE.to_owned(),
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

    fn write(self, conn: &Connection) -> Result<usize, Error> {
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
    let registers = registers(&tx)?;
    let mut pending = Pending::default();
    for (fp, of) in &copies {
        let before = had.get(fp);
        // The copy written about stays the one, while it is there.
        let kept = before.and_then(|b| of.here.iter().find(|p| **p == b.path));
        if let Some(path) = kept.or_else(|| of.here.first()) {
            let moved = before.is_some_and(|b| b.path != *path);
            let back = before.is_some_and(|b| !b.present);
            pending.field(&registers, fp, F_PATH, path.value(), moved);
            pending.field(&registers, fp, F_PRESENT, json!(true), back);
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
    // A song whose record is gone without this device seeing it removed says nothing.
    for fp in had.keys().filter(|fp| !copies.contains_key(*fp)) {
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
    let registers = registers(&tx)?;
    let mut pending = Pending::default();
    for (fp, path) in gone {
        let copy_left: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM tracks WHERE audio_fp = ?1 AND missing_since IS NULL)",
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
