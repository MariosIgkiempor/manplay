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
     JOIN tags g ON g.id = tt.tag_id WHERE tt.track_id = t.id)";

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

pub fn all_paths(conn: &Connection) -> Result<Vec<String>, Error> {
    let mut stmt = conn.prepare("SELECT path FROM tracks ORDER BY path")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}
