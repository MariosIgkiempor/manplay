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

pub fn list(conn: &Connection) -> Result<Vec<Track>, Error> {
    let mut stmt = conn.prepare(
        "SELECT id, path, artist, album, title, size FROM tracks
         ORDER BY artist, album, path",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Track {
            id: r.get(0)?,
            path: r.get(1)?,
            artist: r.get(2)?,
            album: r.get(3)?,
            title: r.get(4)?,
            size: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}
