use std::path::Path;

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::error::Error;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub path: String,
    pub artist: String,
    pub album: String,
    pub title: String,
    pub size: i64,
    pub tags: Vec<String>,
    /// Number of sync targets that currently hold an up-to-date copy.
    pub synced_count: i64,
}

pub struct NewTrack {
    pub path: String,
    pub artist: String,
    pub album: String,
    pub title: String,
    pub size: i64,
}

pub fn open(path: &Path) -> Result<Connection, Error> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS tracks (
             id     INTEGER PRIMARY KEY,
             path   TEXT NOT NULL UNIQUE,
             artist TEXT NOT NULL,
             album  TEXT NOT NULL,
             title  TEXT NOT NULL,
             size   INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS playlists (
             id   INTEGER PRIMARY KEY,
             name TEXT NOT NULL UNIQUE
         );
         CREATE TABLE IF NOT EXISTS playlist_tracks (
             playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
             track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
             position    INTEGER NOT NULL,
             PRIMARY KEY (playlist_id, track_id)
         );
         CREATE TABLE IF NOT EXISTS settings (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS sync_targets (
             id      INTEGER PRIMARY KEY,
             tailnet TEXT NOT NULL,
             machine TEXT NOT NULL,
             path    TEXT NOT NULL,
             UNIQUE (tailnet, machine, path)
         );
         CREATE TABLE IF NOT EXISTS synced_files (
             target_id INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
             track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
             size      INTEGER NOT NULL,
             synced_at INTEGER NOT NULL,
             PRIMARY KEY (target_id, track_id)
         );
         CREATE TABLE IF NOT EXISTS sync_runs (
             id          INTEGER PRIMARY KEY,
             target_id   INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
             started_at  INTEGER NOT NULL,
             finished_at INTEGER NOT NULL,
             uploaded    INTEGER NOT NULL,
             skipped     INTEGER NOT NULL,
             failed      INTEGER NOT NULL,
             first_error TEXT
         );
         CREATE TABLE IF NOT EXISTS tags (
             id   INTEGER PRIMARY KEY,
             name TEXT NOT NULL UNIQUE COLLATE NOCASE
         );
         CREATE TABLE IF NOT EXISTS track_tags (
             track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
             tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
             PRIMARY KEY (track_id, tag_id)
         );",
    )?;
    Ok(conn)
}

pub fn upsert(conn: &mut Connection, tracks: &[NewTrack]) -> Result<(), Error> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO tracks (path, artist, album, title, size)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET
                 artist = excluded.artist,
                 album = excluded.album,
                 title = excluded.title,
                 size = excluded.size",
        )?;
        for t in tracks {
            stmt.execute(params![t.path, t.artist, t.album, t.title, t.size])?;
        }
    }
    tx.commit()?;
    Ok(())
}

const TRACK_COLS: &str = "t.id, t.path, t.artist, t.album, t.title, t.size,
    (SELECT group_concat(g.name, char(31)) FROM track_tags tt
     JOIN tags g ON g.id = tt.tag_id WHERE tt.track_id = t.id),
    (SELECT COUNT(*) FROM synced_files sf WHERE sf.track_id = t.id AND sf.size = t.size)";

fn track_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Track> {
    let tags: Option<String> = r.get(6)?;
    Ok(Track {
        id: r.get(0)?,
        path: r.get(1)?,
        artist: r.get(2)?,
        album: r.get(3)?,
        title: r.get(4)?,
        size: r.get(5)?,
        tags: tags
            .map(|s| s.split('\u{1f}').map(str::to_owned).collect())
            .unwrap_or_default(),
        synced_count: r.get(7)?,
    })
}

pub fn list(conn: &Connection) -> Result<Vec<Track>, Error> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TRACK_COLS} FROM tracks t ORDER BY t.artist, t.album, t.path"
    ))?;
    let rows = stmt.query_map([], track_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub track_count: i64,
}

pub fn list_playlists(conn: &Connection) -> Result<Vec<Playlist>, Error> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, COUNT(pt.track_id)
         FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
         GROUP BY p.id ORDER BY p.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Playlist {
            id: r.get(0)?,
            name: r.get(1)?,
            track_count: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn create_playlist(conn: &Connection, name: &str) -> Result<i64, Error> {
    conn.execute("INSERT INTO playlists (name) VALUES (?1)", params![name])?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_playlist(conn: &Connection, id: i64, name: &str) -> Result<(), Error> {
    conn.execute(
        "UPDATE playlists SET name = ?2 WHERE id = ?1",
        params![id, name],
    )?;
    Ok(())
}

pub fn delete_playlist(conn: &Connection, id: i64) -> Result<(), Error> {
    conn.execute("DELETE FROM playlists WHERE id = ?1", params![id])?;
    Ok(())
}

/// Appends tracks to the end; tracks already in the playlist are skipped.
pub fn add_to_playlist(
    conn: &mut Connection,
    playlist_id: i64,
    track_ids: &[i64],
) -> Result<(), Error> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
             VALUES (?1, ?2, (SELECT COALESCE(MAX(position), -1) + 1
                              FROM playlist_tracks WHERE playlist_id = ?1))",
        )?;
        for id in track_ids {
            stmt.execute(params![playlist_id, id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn remove_from_playlist(
    conn: &Connection,
    playlist_id: i64,
    track_id: i64,
) -> Result<(), Error> {
    conn.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
        params![playlist_id, track_id],
    )?;
    Ok(())
}

pub fn playlist_tracks(conn: &Connection, playlist_id: i64) -> Result<Vec<Track>, Error> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TRACK_COLS} FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
         WHERE pt.playlist_id = ?1 ORDER BY pt.position"
    ))?;
    let rows = stmt.query_map(params![playlist_id], track_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub track_count: i64,
}

pub fn list_tags(conn: &Connection) -> Result<Vec<Tag>, Error> {
    let mut stmt = conn.prepare(
        "SELECT g.id, g.name, COUNT(tt.track_id)
         FROM tags g LEFT JOIN track_tags tt ON tt.tag_id = g.id
         GROUP BY g.id ORDER BY g.name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Tag {
            id: r.get(0)?,
            name: r.get(1)?,
            track_count: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Creates the tag if needed and attaches it to every given track.
pub fn tag_tracks(conn: &mut Connection, name: &str, track_ids: &[i64]) -> Result<(), Error> {
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT OR IGNORE INTO tags (name) VALUES (?1)",
        params![name],
    )?;
    let tag_id: i64 = tx.query_row("SELECT id FROM tags WHERE name = ?1", params![name], |r| {
        r.get(0)
    })?;
    {
        let mut stmt =
            tx.prepare("INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?1, ?2)")?;
        for id in track_ids {
            stmt.execute(params![id, tag_id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn untag_track(conn: &Connection, name: &str, track_id: i64) -> Result<(), Error> {
    conn.execute(
        "DELETE FROM track_tags WHERE track_id = ?1
         AND tag_id = (SELECT id FROM tags WHERE name = ?2)",
        params![track_id, name],
    )?;
    Ok(())
}

pub fn delete_tag(conn: &Connection, id: i64) -> Result<(), Error> {
    conn.execute("DELETE FROM tags WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, Error> {
    match conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    ) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn set_setting(conn: &Connection, key: &str, value: Option<&str>) -> Result<(), Error> {
    match value {
        Some(v) => conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, v],
        )?,
        None => conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?,
    };
    Ok(())
}

pub struct TrackFile {
    pub id: i64,
    pub path: String,
}

pub fn all_files(conn: &Connection) -> Result<Vec<TrackFile>, Error> {
    let mut stmt = conn.prepare("SELECT id, path FROM tracks ORDER BY path")?;
    let rows = stmt.query_map([], |r| {
        Ok(TrackFile {
            id: r.get(0)?,
            path: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn track_path(conn: &Connection, id: i64) -> Result<Option<String>, Error> {
    match conn.query_row("SELECT path FROM tracks WHERE id = ?1", params![id], |r| {
        r.get(0)
    }) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTarget {
    pub tailnet: String,
    pub machine: String,
    /// First segment is the Taildrive share name.
    pub path: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTarget {
    pub id: i64,
    pub tailnet: String,
    pub machine: String,
    pub path: Vec<String>,
    pub synced_tracks: i64,
}

fn parse_path(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

pub fn add_target(conn: &Connection, t: &NewTarget) -> Result<i64, Error> {
    let path = serde_json::to_string(&t.path).map_err(|e| Error::Msg(e.to_string()))?;
    conn.execute(
        "INSERT OR IGNORE INTO sync_targets (tailnet, machine, path) VALUES (?1, ?2, ?3)",
        params![t.tailnet, t.machine, path],
    )?;
    Ok(conn.query_row(
        "SELECT id FROM sync_targets WHERE tailnet = ?1 AND machine = ?2 AND path = ?3",
        params![t.tailnet, t.machine, path],
        |r| r.get(0),
    )?)
}

pub fn remove_target(conn: &Connection, id: i64) -> Result<(), Error> {
    conn.execute("DELETE FROM sync_targets WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn list_targets(conn: &Connection) -> Result<Vec<SyncTarget>, Error> {
    let mut stmt = conn.prepare(
        "SELECT st.id, st.tailnet, st.machine, st.path,
                (SELECT COUNT(*) FROM synced_files sf JOIN tracks t ON t.id = sf.track_id
                 WHERE sf.target_id = st.id AND sf.size = t.size)
         FROM sync_targets st ORDER BY st.machine COLLATE NOCASE, st.path",
    )?;
    let rows = stmt.query_map([], |r| {
        let raw: String = r.get(3)?;
        Ok(SyncTarget {
            id: r.get(0)?,
            tailnet: r.get(1)?,
            machine: r.get(2)?,
            path: parse_path(&raw),
            synced_tracks: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get_targets(conn: &Connection, only: Option<i64>) -> Result<Vec<SyncTarget>, Error> {
    Ok(list_targets(conn)?
        .into_iter()
        .filter(|t| only.is_none_or(|id| id == t.id))
        .collect())
}

pub struct RunRecord {
    pub target_id: i64,
    pub started_at: i64,
    pub finished_at: i64,
    pub uploaded: usize,
    pub skipped: usize,
    pub failed: usize,
    pub first_error: Option<String>,
}

/// Stores the run and marks every confirmed-present track as synced.
pub fn record_run(
    conn: &mut Connection,
    run: &RunRecord,
    synced: &[(i64, i64)],
) -> Result<(), Error> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO synced_files (target_id, track_id, size, synced_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(target_id, track_id) DO UPDATE SET
                 size = excluded.size, synced_at = excluded.synced_at",
        )?;
        for (track_id, size) in synced {
            stmt.execute(params![run.target_id, track_id, size, run.finished_at])?;
        }
    }
    tx.execute(
        "INSERT INTO sync_runs
             (target_id, started_at, finished_at, uploaded, skipped, failed, first_error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            run.target_id,
            run.started_at,
            run.finished_at,
            i64::try_from(run.uploaded).unwrap_or(i64::MAX),
            i64::try_from(run.skipped).unwrap_or(i64::MAX),
            i64::try_from(run.failed).unwrap_or(i64::MAX),
            run.first_error
        ],
    )?;
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    pub id: i64,
    pub target_id: i64,
    pub machine: String,
    pub path: Vec<String>,
    pub started_at: i64,
    pub finished_at: i64,
    pub uploaded: i64,
    pub skipped: i64,
    pub failed: i64,
    pub first_error: Option<String>,
}

pub fn history(conn: &Connection, limit: i64) -> Result<Vec<RunView>, Error> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.target_id, st.machine, st.path, r.started_at, r.finished_at,
                r.uploaded, r.skipped, r.failed, r.first_error
         FROM sync_runs r JOIN sync_targets st ON st.id = r.target_id
         ORDER BY r.id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| {
        let raw: String = r.get(3)?;
        Ok(RunView {
            id: r.get(0)?,
            target_id: r.get(1)?,
            machine: r.get(2)?,
            path: parse_path(&raw),
            started_at: r.get(4)?,
            finished_at: r.get(5)?,
            uploaded: r.get(6)?,
            skipped: r.get(7)?,
            failed: r.get(8)?,
            first_error: r.get(9)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}
