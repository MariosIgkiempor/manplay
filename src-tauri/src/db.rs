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

#[derive(Default)]
pub struct NewTrack {
    pub path: String,
    pub artist: String,
    pub album: String,
    pub title: String,
    pub size: i64,
    /// See `scan::fingerprint`; `None` when the file could not be sampled.
    pub fingerprint: Option<String>,
    pub duration_ms: Option<i64>,
    pub bitrate: Option<i64>,
    pub sample_rate: Option<i64>,
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
    add_column(&conn, "tracks", "missing_since", "INTEGER")?;
    add_column(&conn, "tracks", "fingerprint", "TEXT")?;
    add_column(&conn, "tracks", "duration_ms", "INTEGER")?;
    add_column(&conn, "tracks", "bitrate", "INTEGER")?;
    add_column(&conn, "tracks", "sample_rate", "INTEGER")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS tracks_fingerprint ON tracks(fingerprint);
         CREATE TABLE IF NOT EXISTS stale_remote (
             target_id INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
             track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
             rel       TEXT NOT NULL,
             PRIMARY KEY (target_id, track_id, rel)
         );",
    )?;
    add_column(&conn, "sync_runs", "deleted", "INTEGER NOT NULL DEFAULT 0")?;
    Ok(conn)
}

fn add_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<(), Error> {
    let exists = conn
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|name| name == column);
    if !exists {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
            [],
        )?;
    }
    Ok(())
}

pub fn upsert(conn: &mut Connection, tracks: &[NewTrack]) -> Result<(), Error> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO tracks (path, artist, album, title, size, fingerprint,
                                 duration_ms, bitrate, sample_rate)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(path) DO UPDATE SET
                 artist = excluded.artist,
                 album = excluded.album,
                 title = excluded.title,
                 size = excluded.size,
                 fingerprint = COALESCE(excluded.fingerprint, fingerprint),
                 duration_ms = COALESCE(excluded.duration_ms, duration_ms),
                 bitrate = COALESCE(excluded.bitrate, bitrate),
                 sample_rate = COALESCE(excluded.sample_rate, sample_rate),
                 missing_since = NULL",
        )?;
        for t in tracks {
            stmt.execute(params![
                t.path,
                t.artist,
                t.album,
                t.title,
                t.size,
                t.fingerprint,
                t.duration_ms,
                t.bitrate,
                t.sample_rate
            ])?;
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
        "SELECT {TRACK_COLS} FROM tracks t WHERE t.missing_since IS NULL
         ORDER BY t.artist, t.album, t.path"
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
        "SELECT p.id, p.name, COUNT(t.id)
         FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
         LEFT JOIN tracks t ON t.id = pt.track_id AND t.missing_since IS NULL
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
         WHERE pt.playlist_id = ?1 AND t.missing_since IS NULL ORDER BY pt.position"
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
        "SELECT g.id, g.name, COUNT(t.id)
         FROM tags g LEFT JOIN track_tags tt ON tt.tag_id = g.id
         LEFT JOIN tracks t ON t.id = tt.track_id AND t.missing_since IS NULL
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
    let mut stmt =
        conn.prepare("SELECT id, path FROM tracks WHERE missing_since IS NULL ORDER BY path")?;
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
                 WHERE sf.target_id = st.id AND sf.size = t.size AND t.missing_since IS NULL)
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
    pub deleted: usize,
    pub first_error: Option<String>,
}

/// Stores the run and marks every confirmed-present track as synced.
pub fn record_run(
    conn: &mut Connection,
    run: &RunRecord,
    synced: &[(i64, i64)],
    deleted_tracks: &[i64],
) -> Result<(), Error> {
    let tx = conn.transaction()?;
    for track_id in deleted_tracks {
        tx.execute(
            "DELETE FROM synced_files WHERE target_id = ?1 AND track_id = ?2",
            params![run.target_id, track_id],
        )?;
    }
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
             (target_id, started_at, finished_at, uploaded, skipped, failed, deleted, first_error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            run.target_id,
            run.started_at,
            run.finished_at,
            i64::try_from(run.uploaded).unwrap_or(i64::MAX),
            i64::try_from(run.skipped).unwrap_or(i64::MAX),
            i64::try_from(run.failed).unwrap_or(i64::MAX),
            i64::try_from(run.deleted).unwrap_or(i64::MAX),
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
    pub deleted: i64,
    pub first_error: Option<String>,
}

pub fn history(conn: &Connection, limit: i64) -> Result<Vec<RunView>, Error> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.target_id, st.machine, st.path, r.started_at, r.finished_at,
                r.uploaded, r.skipped, r.failed, r.first_error, r.deleted
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
            deleted: r.get(10)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

// ---- missing files: soft delete, grace period, backups ---------------------

/// `(id, path)` of every track that is currently present (not marked missing).
pub fn present_tracks(conn: &Connection) -> Result<Vec<(i64, String)>, Error> {
    let mut stmt = conn.prepare("SELECT id, path FROM tracks WHERE missing_since IS NULL")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn mark_missing(conn: &mut Connection, ids: &[i64], now: i64) -> Result<(), Error> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE tracks SET missing_since = ?2 WHERE id = ?1")?;
        for id in ids {
            stmt.execute(params![id, now])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn missing_count(conn: &Connection) -> Result<i64, Error> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM tracks WHERE missing_since IS NOT NULL",
        [],
        |r| r.get(0),
    )?)
}

/// Treats every missing track as past its grace period (the user asked to remove them now).
pub fn expire_missing_now(conn: &Connection) -> Result<(), Error> {
    conn.execute(
        "UPDATE tracks SET missing_since = 0 WHERE missing_since IS NOT NULL",
        [],
    )?;
    Ok(())
}

/// Synced copies of tracks that have been missing since `cutoff` or earlier.
pub fn expired_synced(
    conn: &Connection,
    target_id: i64,
    cutoff: i64,
) -> Result<Vec<(i64, String)>, Error> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.path FROM synced_files sf JOIN tracks t ON t.id = sf.track_id
         WHERE sf.target_id = ?1 AND t.missing_since IS NOT NULL AND t.missing_since <= ?2",
    )?;
    let rows = stmt.query_map(params![target_id, cutoff], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

const PURGEABLE: &str = "missing_since IS NOT NULL AND missing_since <= ?1
    AND NOT EXISTS (SELECT 1 FROM synced_files sf WHERE sf.track_id = tracks.id)";

/// Expired missing tracks with no remaining remote copies; removing them also drops
/// their playlist entries and tags.
pub fn purgeable_count(conn: &Connection, cutoff: i64) -> Result<i64, Error> {
    Ok(conn.query_row(
        &format!("SELECT COUNT(*) FROM tracks WHERE {PURGEABLE}"),
        params![cutoff],
        |r| r.get(0),
    )?)
}

pub fn purge_expired(conn: &Connection, cutoff: i64) -> Result<usize, Error> {
    Ok(conn.execute(
        &format!("DELETE FROM tracks WHERE {PURGEABLE}"),
        params![cutoff],
    )?)
}

/// Copies the database to `dir/library-<stamp>-<n>.db` and keeps only the newest `keep` copies.
pub fn backup(conn: &Connection, dir: &Path, stamp: i64, keep: usize) -> Result<(), Error> {
    std::fs::create_dir_all(dir)?;
    // Several backups can happen within one second (a move, then a purge), so never reuse a name.
    let target = (0_u32..1000)
        .map(|n| dir.join(format!("library-{stamp:012}-{n:03}.db")))
        .find(|p| !p.exists())
        .ok_or_else(|| {
            Error::Msg("no free backup file name (1000 backups in one second?)".to_owned())
        })?;
    conn.execute("VACUUM INTO ?1", params![target.to_string_lossy()])?;

    let mut backups: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("library-"))
        })
        .collect();
    backups.sort();
    let excess = backups.len().saturating_sub(keep);
    for old in backups.into_iter().take(excess) {
        // Pruning old backups is best-effort.
        let _ = std::fs::remove_file(old);
    }
    Ok(())
}

// ---- moves and renames ------------------------------------------------------

pub struct Known {
    pub id: i64,
    pub path: String,
    pub fingerprint: Option<String>,
}

/// Every track row, present or soft-deleted.
pub fn all_known(conn: &Connection) -> Result<Vec<Known>, Error> {
    let mut stmt = conn.prepare("SELECT id, path, fingerprint FROM tracks")?;
    let rows = stmt.query_map([], |r| {
        Ok(Known {
            id: r.get(0)?,
            path: r.get(1)?,
            fingerprint: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Points an existing track at its new file. Tags and playlists stay because the row (and id)
/// is kept. Remote copies at the old location are queued for deletion, and the track is marked
/// not-yet-synced so the next sync uploads it to the new location first.
pub fn apply_move(
    conn: &mut Connection,
    id: i64,
    new: &NewTrack,
    old_rel: Option<&[String]>,
) -> Result<(), Error> {
    let tx = conn.transaction()?;
    if let Some(rel) = old_rel {
        let rel_json = serde_json::to_string(rel).map_err(|e| Error::Msg(e.to_string()))?;
        tx.execute(
            "INSERT OR IGNORE INTO stale_remote (target_id, track_id, rel)
             SELECT target_id, track_id, ?2 FROM synced_files WHERE track_id = ?1",
            params![id, rel_json],
        )?;
    }
    tx.execute("DELETE FROM synced_files WHERE track_id = ?1", params![id])?;
    tx.execute(
        "UPDATE tracks SET path = ?2, artist = ?3, album = ?4, title = ?5, size = ?6,
                fingerprint = ?7, missing_since = NULL,
                duration_ms = COALESCE(?8, duration_ms), bitrate = COALESCE(?9, bitrate),
                sample_rate = COALESCE(?10, sample_rate)
         WHERE id = ?1",
        params![
            id,
            new.path,
            new.artist,
            new.album,
            new.title,
            new.size,
            new.fingerprint,
            new.duration_ms,
            new.bitrate,
            new.sample_rate
        ],
    )?;
    tx.commit()?;
    Ok(())
}

/// Old remote locations (from moved tracks) waiting for deletion on `target_id`.
pub fn stale_for(conn: &Connection, target_id: i64) -> Result<Vec<(i64, Vec<String>)>, Error> {
    let mut stmt = conn.prepare("SELECT track_id, rel FROM stale_remote WHERE target_id = ?1")?;
    let rows = stmt.query_map(params![target_id], |r| {
        let raw: String = r.get(1)?;
        Ok((r.get(0)?, parse_path(&raw)))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn clear_stale(
    conn: &Connection,
    target_id: i64,
    done: &[(i64, Vec<String>)],
) -> Result<(), Error> {
    for (track_id, rel) in done {
        let rel_json = serde_json::to_string(rel).map_err(|e| Error::Msg(e.to_string()))?;
        conn.execute(
            "DELETE FROM stale_remote WHERE target_id = ?1 AND track_id = ?2 AND rel = ?3",
            params![target_id, track_id, rel_json],
        )?;
    }
    Ok(())
}

// ---- rekordbox export -------------------------------------------------------

pub struct ExportTrack {
    pub id: i64,
    pub path: String,
    pub artist: String,
    pub album: String,
    pub title: String,
    pub size: i64,
    pub duration_ms: Option<i64>,
    pub bitrate: Option<i64>,
    pub sample_rate: Option<i64>,
}

pub struct ExportPlaylist {
    pub name: String,
    pub track_ids: Vec<i64>,
}

/// Everything the rekordbox export needs: present tracks and playlists in their saved order.
pub fn export_data(conn: &Connection) -> Result<(Vec<ExportTrack>, Vec<ExportPlaylist>), Error> {
    let mut stmt = conn.prepare(
        "SELECT id, path, artist, album, title, size, duration_ms, bitrate, sample_rate
         FROM tracks WHERE missing_since IS NULL ORDER BY artist, album, path",
    )?;
    let tracks = stmt
        .query_map([], |r| {
            Ok(ExportTrack {
                id: r.get(0)?,
                path: r.get(1)?,
                artist: r.get(2)?,
                album: r.get(3)?,
                title: r.get(4)?,
                size: r.get(5)?,
                duration_ms: r.get(6)?,
                bitrate: r.get(7)?,
                sample_rate: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut pl_stmt =
        conn.prepare("SELECT id, name FROM playlists ORDER BY name COLLATE NOCASE")?;
    let heads = pl_stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut member_stmt = conn.prepare(
        "SELECT pt.track_id FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
         WHERE pt.playlist_id = ?1 AND t.missing_since IS NULL ORDER BY pt.position",
    )?;
    let mut playlists = Vec::new();
    for (id, name) in heads {
        let track_ids = member_stmt
            .query_map(params![id], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        playlists.push(ExportPlaylist { name, track_ids });
    }
    Ok((tracks, playlists))
}
