//! Which songs of the shared library this device keeps on disk instead of streaming: a song (by
//! its audio, so the rule survives renames) or a playlist (by its uid, so songs added to it later
//! are kept too). Local to this device; never shared.
//!
//! The rules only say what is wanted; the download is `fetch_shared_songs` in `lib.rs`, and the
//! row becomes kept when the scan finds the file at its path (`db::upsert`).

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use super::files::RelPath;
use crate::error::Error;

/// What a rule keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeepKind {
    /// One song, by `audio_fp`.
    Song,
    /// Every song in a playlist, by the playlist's uid.
    Playlist,
}

impl KeepKind {
    fn as_sql(self) -> &'static str {
        match self {
            Self::Song => "song",
            Self::Playlist => "playlist",
        }
    }
}

/// One thing this device keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeepRule {
    pub kind: KeepKind,
    pub id: String,
}

pub fn create(conn: &Connection) -> Result<(), Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS keep_rules (
             kind TEXT NOT NULL CHECK (kind IN ('song', 'playlist')),
             id   TEXT NOT NULL,
             PRIMARY KEY (kind, id)
         );",
    )?;
    Ok(())
}

pub fn add(conn: &Connection, rules: &[KeepRule]) -> Result<(), Error> {
    let mut stmt =
        conn.prepare_cached("INSERT OR IGNORE INTO keep_rules (kind, id) VALUES (?1, ?2)")?;
    for rule in rules {
        stmt.execute(params![rule.kind.as_sql(), rule.id])?;
    }
    Ok(())
}

pub fn remove(conn: &Connection, rules: &[KeepRule]) -> Result<(), Error> {
    let mut stmt = conn.prepare_cached("DELETE FROM keep_rules WHERE kind = ?1 AND id = ?2")?;
    for rule in rules {
        stmt.execute(params![rule.kind.as_sql(), rule.id])?;
    }
    Ok(())
}

/// Whether a rule keeps the song in row `track_id`, by its playlists only (a song rule is what
/// "Stream only" takes away, so it does not count here).
pub fn kept_by_playlist(conn: &Connection, track_id: i64) -> Result<bool, Error> {
    Ok(conn.query_row(
        "SELECT EXISTS (
             SELECT 1 FROM keep_rules k
             JOIN playlists p ON p.uid = k.id
             JOIN playlist_tracks pt ON pt.playlist_id = p.id
             WHERE k.kind = 'playlist' AND pt.track_id = ?1)",
        params![track_id],
        |r| r.get(0),
    )?)
}

/// The streamed songs some rule keeps, by their path below `root`: the files to download.
pub fn to_download(conn: &Connection, root: &std::path::Path) -> Result<Vec<RelPath>, Error> {
    let mut stmt = conn.prepare(
        "SELECT t.path FROM tracks t
         WHERE t.file_state = 'streamed' AND (
             EXISTS (SELECT 1 FROM keep_rules k WHERE k.kind = 'song' AND k.id = t.audio_fp)
             OR EXISTS (
                 SELECT 1 FROM keep_rules k
                 JOIN playlists p ON p.uid = k.id
                 JOIN playlist_tracks pt ON pt.playlist_id = p.id
                 WHERE k.kind = 'playlist' AND pt.track_id = t.id))
         ORDER BY t.path",
    )?;
    let paths = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for path in paths {
        if let Some(rel) = RelPath::below(root, std::path::Path::new(&path?)) {
            out.push(rel);
        }
    }
    Ok(out)
}
