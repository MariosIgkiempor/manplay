//! The songs of the shared library this device streams instead of keeping.
//!
//! A streamed song is a `tracks` row with `file_state = 'streamed'` and no file: its `path` is
//! where the file would be in the library folder, and everything else comes from the log (the
//! `file` entity for where it is and what it is like, `song_tags` for its tags). Playlists, tags
//! and the analysis then find it like any other song.
//!
//! [`refresh`] keeps these rows the same as the log after every sync of a shared library kept on a
//! destination: it adds a row for each song the shared library has and this library has no file
//! of (when new songs are set to stream, [`NewSongs`]), follows renames and tag edits, and drops
//! the row of a song that was removed, is kept here now, or is no longer in a shared library.
//! Nothing here touches a file.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::apply;
use super::files::{self, Details, E_FILE, RelPath};
use super::membership::{self, Home};
use super::ops::{F_PATH, F_PRESENT};
use super::song_tags::E_SONG_TAGS;
use crate::db;
use crate::error::Error;

/// What becomes of a song another device adds to the shared library.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NewSongs {
    /// Listed and played from the destination; its file is downloaded only when kept.
    #[default]
    Stream,
    /// Downloaded into the library folder.
    Download,
}

const SETTING_NEW_SONGS: &str = "new_shared_songs";

impl NewSongs {
    fn as_setting(self) -> &'static str {
        match self {
            Self::Stream => "stream",
            Self::Download => "download",
        }
    }

    pub fn get(conn: &Connection) -> Result<Self, Error> {
        Ok(match db::get_setting(conn, SETTING_NEW_SONGS)?.as_deref() {
            Some("download") => Self::Download,
            _ => Self::Stream,
        })
    }

    pub fn set(self, conn: &Connection) -> Result<(), Error> {
        db::set_setting(conn, SETTING_NEW_SONGS, Some(self.as_setting()))
    }
}

/// What one [`refresh`] changed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Refreshed {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
}

impl Refreshed {
    pub fn changed(self) -> bool {
        self.added + self.updated + self.removed > 0
    }
}

/// A song's row as the log describes it.
#[derive(Debug, Clone, PartialEq)]
struct Described {
    path: String,
    artist: String,
    album: String,
    title: String,
    details: Details,
    /// The list fields as the scan stores them (`db::NewTrack::fields`).
    fields: String,
}

/// Makes the library's streamed songs what the shared library says, in `root`, the library
/// folder. Removes them all when the shared library is not kept on a destination: in a folder
/// every song's file is already here, and outside a shared library there is nothing to stream.
pub fn refresh(conn: &Connection, root: &Path) -> Result<Refreshed, Error> {
    let tx = conn.unchecked_transaction()?;
    let on_destination = matches!(membership::home(&tx)?, Some(Home::Target(_)));
    let wanted = if on_destination {
        described(&tx, root)?
    } else {
        HashMap::new()
    };
    let adding = NewSongs::get(&tx)? == NewSongs::Stream;
    let mut out = Refreshed::default();
    let mut streamed = streamed_rows(&tx)?;
    let kept = kept_audio(&tx)?;
    for (fp, song) in &wanted {
        if kept.contains(fp) {
            continue;
        }
        match streamed.remove(fp) {
            Some(id) => {
                if update(&tx, id, song)? {
                    out.updated += 1;
                }
            }
            None if adding && insert(&tx, fp, song)? => out.added += 1,
            None => {}
        }
    }
    // Rows the log no longer wants, and the rows of songs kept here now.
    for id in streamed.into_values() {
        tx.execute("DELETE FROM tracks WHERE id = ?1", params![id])?;
        out.removed += 1;
    }
    if out.added > 0 {
        // Shared tags, playlists and analysis that were waiting for these songs.
        apply::materialize_pending_in(&tx)?;
    }
    tx.commit()?;
    Ok(out)
}

/// Every song the shared library has, by `audio_fp`, with a path a file can have below `root`.
fn described(conn: &Connection, root: &Path) -> Result<HashMap<String, Described>, Error> {
    let file = files::registers(conn, E_FILE)?;
    let tags = files::registers(conn, E_SONG_TAGS)?;
    let mut out = HashMap::new();
    for ((fp, f), val) in &file {
        if f != F_PRESENT || *val != Value::Bool(true) {
            continue;
        }
        let Some(rel) = file
            .get(&(fp.clone(), F_PATH.to_owned()))
            .and_then(RelPath::from_value)
        else {
            continue;
        };
        out.insert(fp.clone(), describe(root, &rel, &tags, &file, fp));
    }
    Ok(out)
}

/// A song's row from its path and what the log says of it, named the way a scan names a file
/// (`scan::read_track`): album artist, else artist, else the folder; album, else the folder;
/// title, else the file name.
fn describe(
    root: &Path,
    rel: &RelPath,
    tags: &HashMap<(String, String), Value>,
    file: &HashMap<(String, String), Value>,
    fp: &str,
) -> Described {
    let path = rel.under(root);
    let tag = |f: &str| {
        tags.get(&(fp.to_owned(), f.to_owned()))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let (folder_artist, folder_album) = crate::scan::folder_names(root, &path).unzip();
    let unknown = || "Unknown".to_owned();
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map_or_else(unknown, str::to_owned);
    let fields: std::collections::BTreeMap<&str, String> = crate::tags::LISTED
        .iter()
        .filter_map(|f| tag(f).map(|v| (*f, v)))
        .collect();
    Described {
        path: path.to_string_lossy().into_owned(),
        artist: tag("albumArtist")
            .or_else(|| tag("artist"))
            .or(folder_artist)
            .unwrap_or_else(unknown),
        album: tag("album").or(folder_album).unwrap_or_else(unknown),
        title: tag("title").unwrap_or(stem),
        details: Details::of(file, fp),
        fields: serde_json::to_string(&fields).unwrap_or_else(|_| "{}".to_owned()),
    }
}

/// The streamed rows by `audio_fp`.
fn streamed_rows(conn: &Connection) -> Result<HashMap<String, i64>, Error> {
    let mut stmt = conn.prepare(
        "SELECT audio_fp, id FROM tracks
         WHERE file_state = 'streamed' AND audio_fp IS NOT NULL AND audio_fp <> ''",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The audio of every song this library has a file of, or had one of not long ago (a missing
/// song may still come back, and its row holds the path).
fn kept_audio(conn: &Connection) -> Result<HashSet<String>, Error> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT audio_fp FROM tracks
         WHERE file_state = 'here' AND audio_fp IS NOT NULL AND audio_fp <> ''",
    )?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Whether another row holds `path` already.
fn path_taken(conn: &Connection, path: &str, except: Option<i64>) -> Result<bool, Error> {
    Ok(conn
        .query_row(
            "SELECT id FROM tracks WHERE path = ?1",
            params![path],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_some_and(|id| Some(id) != except))
}

/// Adds a streamed row; false when another song's row holds its path.
fn insert(conn: &Connection, fp: &str, song: &Described) -> Result<bool, Error> {
    if path_taken(conn, &song.path, None)? {
        log::info!(
            "a streamed song's place is taken by another song: {}",
            song.path
        );
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO tracks (path, artist, album, title, size, duration_ms, bitrate, sample_rate,
                             fields, audio_fp, file_state, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                 CAST(strftime('%s', 'now') AS INTEGER))",
        params![
            song.path,
            song.artist,
            song.album,
            song.title,
            song.details.size.unwrap_or(0),
            song.details.duration_ms,
            song.details.bitrate,
            song.details.sample_rate,
            song.fields,
            fp,
            db::FileState::Streamed,
        ],
    )?;
    Ok(true)
}

/// Brings a streamed row up to the log; true when something changed. A new path that another
/// song's row holds is not taken: the row stays where it was.
fn update(conn: &Connection, id: i64, song: &Described) -> Result<bool, Error> {
    let path_free = !path_taken(conn, &song.path, Some(id))?;
    let changed = conn.execute(
        "UPDATE tracks SET
             path = CASE WHEN ?2 THEN ?3 ELSE path END,
             artist = ?4, album = ?5, title = ?6,
             size = COALESCE(?7, size),
             duration_ms = COALESCE(?8, duration_ms),
             bitrate = COALESCE(?9, bitrate),
             sample_rate = COALESCE(?10, sample_rate),
             fields = ?11
         WHERE id = ?1 AND (
             (?2 AND path IS NOT ?3) OR artist IS NOT ?4 OR album IS NOT ?5 OR title IS NOT ?6
             OR (?7 IS NOT NULL AND size IS NOT ?7)
             OR (?8 IS NOT NULL AND duration_ms IS NOT ?8)
             OR (?9 IS NOT NULL AND bitrate IS NOT ?9)
             OR (?10 IS NOT NULL AND sample_rate IS NOT ?10)
             OR fields IS NOT ?11)",
        params![
            id,
            path_free,
            song.path,
            song.artist,
            song.album,
            song.title,
            song.details.size,
            song.details.duration_ms,
            song.details.bitrate,
            song.details.sample_rate,
            song.fields,
        ],
    )?;
    Ok(changed > 0)
}
