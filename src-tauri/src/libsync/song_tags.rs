//! The tags written in each song's file (title, artist, genre, ...), as ops, one field at a time.
//!
//! A `song_tags` entity is one audio (`audio_fp`); each of its fields is a tag field
//! (`tags::is_field`) and holds the text the file has there, or `""` when it has none. This
//! device writes an op when a file's tags changed here since it last looked (`song_tags_local`
//! remembers what they were), and an early one (`write::stamp_early`) for what a file simply has
//! and no device has written about. A field another device wrote, and that was not changed
//! here, is to be written into the file ([`wanted`]).
//!
//! The front cover is one more field, `cover`: the name of the picture (the hash of its bytes,
//! `tags::CoverBackupName`), or `""` for none. The pictures themselves are files on the
//! destination (`covers.rs`).
//!
//! BPM and key are left out: the analysis is shared on its own, and each device writes it into
//! its files the way it is set to.
//!
//! Reading a file's tags takes a while, so what was read is kept (`tags_read`) and a file is read
//! again only when it changed ([`unread`], [`store`]). Only [`TagWrite::carry_out`] touches a
//! file, and it saves a copy first. Of several copies of one audio only the one `files.rs`
//! writes about is looked at.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::files::{self, Pending, RelPath};
use super::write::active;
use crate::error::Error;
use crate::tags::CoverBackupName;

pub const E_SONG_TAGS: &str = "song_tags";

/// The field that names a song's front cover.
pub const COVER: &str = "cover";

/// Tag fields the analysis decides, so they are not shared as tags.
const LEFT_OUT: &[&str] = &["bpm", "key"];

/// The longest text a field from another device may hold, in bytes.
const LONGEST_VALUE: usize = 64 * 1024;

/// A file's tag fields by their id (`tags::field_values`) and its front cover under [`COVER`];
/// a field it lacks is left out.
pub type Fields = BTreeMap<String, String>;

fn shared_field(field: &str) -> bool {
    field == COVER || (crate::tags::is_field(field) && !LEFT_OUT.contains(&field))
}

/// The cover a `cover` field names; `None` for no cover and for text that names none.
pub fn cover_named(text: &str) -> Option<CoverBackupName> {
    CoverBackupName::try_from(text.to_owned()).ok()
}

/// The text another device wrote for `field`, when it is one that can go into a file's tags.
pub fn shared_value<'a>(field: &str, val: &'a Value) -> Option<&'a str> {
    val.as_str().filter(|text| {
        if field == COVER {
            text.is_empty() || cover_named(text).is_some()
        } else {
            shared_field(field) && text.len() <= LONGEST_VALUE && !text.contains('\0')
        }
    })
}

/// What the file at `path` says, or `None` when its tags cannot be read.
pub fn read_file(path: &Path) -> Option<Fields> {
    let tags = crate::tags::file_tags(path)?;
    let mut fields = tags.fields;
    if let Some(cover) = tags.cover {
        fields.insert(COVER.to_owned(), cover.as_str().to_owned());
    }
    Some(fields)
}

/// A song file whose tags have not been read since it last changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unread {
    pub track_id: i64,
    pub path: String,
    /// The file's modification time and size when it was found unread, to tell later whether it
    /// changed again.
    pub mtime_ms: Option<i64>,
    pub size: i64,
}

/// Up to `limit` song files to read the tags of; none while library data is not shared.
pub fn unread(conn: &Connection, limit: usize) -> Result<Vec<Unread>, Error> {
    if !active(conn)? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT t.id, t.path, t.mtime_ms, t.size FROM tracks t
         LEFT JOIN tags_read r ON r.track_id = t.id
         WHERE t.missing_since IS NULL AND t.audio_fp IS NOT NULL AND t.audio_fp <> ''
           AND (r.track_id IS NULL OR r.size <> t.size OR r.mtime_ms IS NOT t.mtime_ms)
         ORDER BY t.id LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![i64::try_from(limit).unwrap_or(i64::MAX)], |r| {
        Ok(Unread {
            track_id: r.get(0)?,
            path: r.get(1)?,
            mtime_ms: r.get(2)?,
            size: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Keeps what was read from each file (`None`: its tags cannot be read), and forgets files the
/// library no longer has.
pub fn store(conn: &Connection, read: &[(Unread, Option<Fields>)]) -> Result<(), Error> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut insert = tx.prepare_cached(
            "INSERT INTO tags_read (track_id, mtime_ms, size, fields) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(track_id) DO UPDATE SET
                 mtime_ms = excluded.mtime_ms, size = excluded.size, fields = excluded.fields",
        )?;
        for (file, fields) in read {
            let fields = fields
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|e| Error::Msg(e.to_string()))?;
            insert.execute(params![file.track_id, file.mtime_ms, file.size, fields])?;
        }
    }
    tx.execute(
        "DELETE FROM tags_read WHERE track_id NOT IN (SELECT id FROM tracks)",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

/// The copy of one audio whose tags are written about, with its tags as last read.
pub(super) struct Tracked {
    pub(super) path: PathBuf,
    rel: RelPath,
    pub(super) fields: Fields,
}

/// For each audio, the copy `files.rs` writes about (or, when it has not written yet, the first
/// one below the library folder), when its tags were read since the file last changed.
pub(super) fn tracked(conn: &Connection, root: &Path) -> Result<BTreeMap<String, Tracked>, Error> {
    let written_about = files::tracked_paths(conn)?;
    let mut stmt = conn.prepare(
        "SELECT t.audio_fp, t.path, r.fields FROM tracks t
         JOIN tags_read r ON r.track_id = t.id
         WHERE t.missing_since IS NULL AND t.audio_fp IS NOT NULL AND t.audio_fp <> ''
           AND r.fields IS NOT NULL AND r.size = t.size AND r.mtime_ms IS t.mtime_ms",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut out: BTreeMap<String, Tracked> = BTreeMap::new();
    for row in rows {
        let (fp, path, fields) = row?;
        let path = PathBuf::from(path);
        let Some(rel) = RelPath::below(root, &path) else {
            continue;
        };
        let Ok(fields) = serde_json::from_str::<Fields>(&fields) else {
            continue;
        };
        let is_the_one = match written_about.get(&fp) {
            Some(the_one) => *the_one == rel,
            None => out.get(&fp).is_none_or(|other| rel < other.rel),
        };
        if is_the_one {
            out.insert(fp, Tracked { path, rel, fields });
        }
    }
    Ok(out)
}

/// The tags each audio's file had when this device last wrote ops about them.
fn had(conn: &Connection) -> Result<HashMap<String, Fields>, Error> {
    let mut stmt = conn.prepare("SELECT audio_fp, fields FROM song_tags_local")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = HashMap::new();
    for row in rows {
        let (fp, fields) = row?;
        if let Ok(fields) = serde_json::from_str(&fields) {
            out.insert(fp, fields);
        }
    }
    Ok(out)
}

fn text<'a>(fields: &'a Fields, field: &str) -> &'a str {
    fields.get(field).map_or("", String::as_str)
}

/// Looks at the tags read from the library's files and writes an op for every field that
/// changed here since the last look, or that no device has written about. Returns how many ops
/// it wrote. Does nothing while library data is not shared.
pub fn record(conn: &Connection, root: &Path) -> Result<usize, Error> {
    if !active(conn)? {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction()?;
    let tracked = tracked(&tx, root)?;
    let had = had(&tx)?;
    let registers = files::registers(&tx, E_SONG_TAGS)?;
    let mut pending = Pending::of(E_SONG_TAGS);
    for (fp, now) in &tracked {
        let before = had.get(fp);
        let names: BTreeSet<&str> = now
            .fields
            .keys()
            .chain(before.into_iter().flat_map(Fields::keys))
            .map(String::as_str)
            .filter(|field| shared_field(field))
            .collect();
        for field in names {
            let value = text(&now.fields, field);
            let changed = before.is_some_and(|before| text(before, field) != value);
            // A field the file never had says nothing.
            if changed || !value.is_empty() {
                pending.field(&registers, fp, field, json!(value), changed);
            }
            // Another device wrote this field before this file was first looked at: its edit
            // was listed as filling an empty field. What the file has is what taking the edit
            // back must restore.
            let overruled = registers
                .get(&(fp.clone(), field.to_owned()))
                .is_some_and(|known| known.as_str() != Some(value));
            if before.is_none() && !value.is_empty() && overruled {
                tx.prepare_cached(
                    "UPDATE op_journal SET prev = ?4
                     WHERE e = ?1 AND id = ?2 AND f = ?3 AND prev IS NULL AND undone = 0",
                )?
                .execute(params![
                    E_SONG_TAGS,
                    fp,
                    field,
                    json!(value).to_string()
                ])?;
            }
        }
        if before != Some(&now.fields) {
            let fields =
                serde_json::to_string(&now.fields).map_err(|e| Error::Msg(e.to_string()))?;
            tx.prepare_cached(
                "INSERT INTO song_tags_local (audio_fp, fields) VALUES (?1, ?2)
                 ON CONFLICT(audio_fp) DO UPDATE SET fields = excluded.fields",
            )?
            .execute(params![fp, fields])?;
        }
    }
    let written = pending.write(&tx)?;
    tx.commit()?;
    Ok(written)
}

/// Tags another device wrote that one of this library's files does not have yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagWrite {
    pub audio_fp: String,
    pub path: PathBuf,
    /// The file's place below the library folder.
    pub rel: RelPath,
    /// The fields to write; an empty text clears the field.
    pub edits: Fields,
}

impl TagWrite {
    /// The cover picture this write puts in, when it puts one in.
    pub fn cover(&self) -> Option<CoverBackupName> {
        self.edits.get(COVER).and_then(|name| cover_named(name))
    }

    /// The write without its new cover, for while the picture is not here yet; `None` when
    /// nothing else is left to write.
    pub fn without_cover(mut self) -> Option<Self> {
        self.edits.remove(COVER);
        (!self.edits.is_empty()).then_some(self)
    }

    /// Writes the fields into the file, after saving the file as it was under `backups` at the
    /// same place it has below the library folder. A new cover is the picture of that name in
    /// `covers`, and the cover it replaces is saved there, so taking the change back has the
    /// picture to put back. A file that cannot be written is left as far as it got, and its copy is kept
    /// only when something was written.
    pub fn carry_out(&self, backups: &Path, covers: &Path) -> Result<(), Error> {
        let mut text = self.edits.clone();
        let cover = text.remove(COVER);
        let picture = match self.cover() {
            Some(name) => Some(std::fs::read(covers.join(name.as_str()))?),
            None => None,
        };
        let copy = self.rel.under(backups);
        if let Some(folder) = copy.parent() {
            std::fs::create_dir_all(folder)?;
        }
        // A copy already there is the file from before an earlier write: it stays.
        let copied = !copy.exists();
        if copied {
            std::fs::copy(&self.path, &copy)?;
        }
        let written = crate::tags::write_file(&self.path, &text);
        if written.is_err() {
            if copied {
                let _ = std::fs::remove_file(&copy);
            }
            return written;
        }
        if cover.is_some() {
            crate::tags::back_up_cover(&self.path, covers)?;
            crate::tags::set_cover(&self.path, picture.as_deref())?;
        }
        Ok(())
    }
}

/// What other devices wrote about the tags of songs this library has, where the file says
/// something else and was not changed here since the last [`record`]. Call it after `record`,
/// so what changed here went out first. Nothing while library data is not shared.
pub fn wanted(conn: &Connection, root: &Path) -> Result<Vec<TagWrite>, Error> {
    if !active(conn)? {
        return Ok(Vec::new());
    }
    let tracked = tracked(conn, root)?;
    let had = had(conn)?;
    let mut edits: BTreeMap<String, Fields> = BTreeMap::new();
    for ((fp, field), val) in files::registers(conn, E_SONG_TAGS)? {
        let (Some(now), Some(before)) = (tracked.get(&fp), had.get(&fp)) else {
            continue;
        };
        let Some(value) = shared_value(&field, &val) else {
            continue;
        };
        let here = text(&now.fields, &field);
        if here != value && text(before, &field) == here {
            edits.entry(fp).or_default().insert(field, value.to_owned());
        }
    }
    Ok(edits
        .into_iter()
        .filter_map(|(audio_fp, edits)| {
            let file = tracked.get(&audio_fp)?;
            Some(TagWrite {
                path: file.path.clone(),
                rel: file.rel.clone(),
                audio_fp,
                edits,
            })
        })
        .collect())
}
