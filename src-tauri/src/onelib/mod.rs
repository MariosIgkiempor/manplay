//! rekordbox's newer USB library, `OneLibrary` (formerly `Device Library Plus`):
//! `PIONEER/rekordbox/exportLibrary.db`, read by the CDJ-3000X, OPUS-QUAD, XDJ-AZ and OMNIS-DUO.
//!
//! It is an SQLite database encrypted with `SQLCipher` 4 (default settings) under one passphrase
//! shared by every drive. Layout and key from pyrekordbox (`pyrekordbox/onelibrary`); notes in
//! `docs/onelibrary.md`. Tracks, playlists and artwork map onto the same [`Library`] as
//! `export.pdb`, with the same ids, so both files can be written from one list.

use crate::pdb::{Library, Playlist, Track};
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// The passphrase, `XOR`ed with [`MASK`] so it does not sit in the binary as plain text
/// (pyrekordbox keeps it obfuscated too).
const MASKED_KEY: [u8; 64] = [
    0x44, 0x0d, 0x50, 0x02, 0x50, 0x56, 0x14, 0x0c, 0x5f, 0x5b, 0x00, 0x04, 0x0f, 0x50, 0x53, 0x50,
    0x44, 0x03, 0x54, 0x17, 0x4e, 0x5a, 0x0d, 0x53, 0x04, 0x06, 0x58, 0x05, 0x46, 0x1a, 0x17, 0x5c,
    0x54, 0x06, 0x43, 0x14, 0x56, 0x5a, 0x1e, 0x00, 0x04, 0x56, 0x5e, 0x5e, 0x00, 0x57, 0x15, 0x54,
    0x4c, 0x03, 0x03, 0x0f, 0x01, 0x57, 0x5e, 0x5e, 0x5a, 0x11, 0x45, 0x41, 0x4e, 0x12, 0x0f, 0x42,
];
const MASK: &[u8; 16] = b"657f48f84c437cc1";

fn key() -> String {
    MASKED_KEY
        .iter()
        .enumerate()
        .map(|(i, b)| char::from(b ^ MASK[i % MASK.len()]))
        .collect()
}

/// Opens an `exportLibrary.db` for reading or writing.
pub(crate) fn open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "key", key())
        .map_err(|e| e.to_string())?;
    // A wrong key or a file that is not a database only fails on the first read.
    conn.query_row("select count(*) from sqlite_master", [], |_| Ok(()))
        .map_err(|e| format!("not a OneLibrary database: {e}"))?;
    Ok(conn)
}

/// Reads the `OneLibrary` at `path`. The file (and its `-wal`, which rekordbox leaves behind) is
/// copied to a temporary folder first, so reading never writes to the drive.
pub fn read(path: &Path) -> Result<Library, String> {
    let dir = std::env::temp_dir().join(format!(
        "manplay-onelib-{}-{}",
        std::process::id(),
        unique()
    ));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let result = copy_and_read(path, &dir);
    let _ = fs::remove_dir_all(&dir);
    result
}

fn unique() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

fn copy_and_read(path: &Path, dir: &Path) -> Result<Library, String> {
    let copy = dir.join("exportLibrary.db");
    fs::copy(path, &copy).map_err(|e| e.to_string())?;
    let wal = sibling(path, "-wal");
    if wal.is_file() {
        fs::copy(&wal, sibling(&copy, "-wal")).map_err(|e| e.to_string())?;
    }
    let conn = open(&copy)?;
    read_conn(&conn).map_err(|e| e.to_string())
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn names(conn: &Connection, table: &str) -> rusqlite::Result<HashMap<i64, String>> {
    let mut stmt = conn.prepare(&format!("select {table}_id, name from {table}"))?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, Option<String>>(1)?.unwrap_or_default(),
        ))
    })?;
    rows.collect()
}

/// A nullable integer column as `u32`: NULL, negative or too large values become 0.
fn num<T: TryFrom<i64> + Default>(v: Option<i64>) -> T {
    v.and_then(|v| T::try_from(v).ok()).unwrap_or_default()
}

fn read_conn(conn: &Connection) -> rusqlite::Result<Library> {
    let artists = names(conn, "artist")?;
    let albums = names(conn, "album")?;
    let genres = names(conn, "genre")?;
    let keys = names(conn, "key")?;
    let name = |map: &HashMap<i64, String>, id: Option<i64>| {
        id.and_then(|id| map.get(&id)).cloned().unwrap_or_default()
    };

    let mut stmt = conn.prepare(
        "select content_id, title, artist_id_artist, album_id, genre_id, key_id, djComment, path,
                analysisDataFilePath, dateAdded, length, bpmx100, bitrate, samplingRate, fileSize,
                releaseYear, trackNo, fileType, image_id
         from content order by content_id",
    )?;
    let tracks = stmt
        .query_map([], |r| {
            let text = |i: usize| -> rusqlite::Result<String> {
                Ok(r.get::<_, Option<String>>(i)?.unwrap_or_default())
            };
            let int = |i: usize| r.get::<_, Option<i64>>(i);
            Ok(Track {
                id: num(int(0)?),
                title: text(1)?,
                artist: name(&artists, int(2)?),
                album: name(&albums, int(3)?),
                genre: name(&genres, int(4)?),
                key: name(&keys, int(5)?),
                comment: text(6)?,
                path: text(7)?,
                analyze_path: text(8)?,
                date_added: text(9)?,
                duration_secs: num(int(10)?),
                tempo: num(int(11)?),
                bitrate: num(int(12)?),
                sample_rate: num(int(13)?),
                file_size: num(int(14)?),
                year: num(int(15)?),
                track_number: num(int(16)?),
                file_type: num(int(17)?),
                artwork_id: num(int(18)?),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut entries: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut stmt = conn.prepare(
        "select playlist_id, content_id from playlist_content order by playlist_id, sequenceNo",
    )?;
    for row in stmt.query_map([], |r| {
        Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?))
    })? {
        let (list, track) = row?;
        entries.entry(num(list)).or_default().push(num(track));
    }

    let mut stmt = conn.prepare(
        "select playlist_id, playlist_id_parent, name, attribute, sequenceNo
         from playlist order by playlist_id",
    )?;
    let playlists = stmt
        .query_map([], |r| {
            let id: u32 = num(r.get(0)?);
            Ok(Playlist {
                id,
                parent_id: num(r.get(1)?),
                name: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                // 0 for a playlist. Folders are assumed to be 1, as in rekordbox's master.db.
                is_folder: r.get::<_, Option<i64>>(3)?.unwrap_or(0) == 1,
                sort_order: num(r.get(4)?),
                track_ids: entries.remove(&id).unwrap_or_default(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut stmt = conn.prepare("select image_id, path from image order by image_id")?;
    let artwork = stmt
        .query_map([], |r| {
            Ok((
                num(r.get(0)?),
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Library {
        tracks,
        playlists,
        artwork,
    })
}

/// The `dbVersion` in the `property` row: "1000" in an export, "10000" in the empty library
/// rekordbox creates on a drive it has not exported to.
pub fn db_version(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row("select dbVersion from property", [], |r| r.get(0))
        .optional()
        .map(Option::flatten)
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    /// A real rekordbox 7 export of 41 tracks in 5 playlists, its WAL checkpointed into one file.
    const FIXTURE: &[u8] = include_bytes!("testdata/rekordbox7.db");

    fn fixture(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("manplay-onelib-test-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("exportLibrary.db");
        fs::write(&path, FIXTURE).expect("fixture");
        path
    }

    #[test]
    fn key_is_the_shared_passphrase() {
        let k = key();
        assert_eq!(k.len(), 64);
        assert!(k.starts_with("r8gd"));
    }

    #[test]
    fn reads_rekordbox_export() {
        let path = fixture("read");
        let lib = read(&path).expect("reads");
        assert_eq!(lib.tracks.len(), 41);

        let first = &lib.tracks[0];
        assert_eq!(first.id, 1);
        assert_eq!(first.title, "Untitled");
        assert_eq!(first.artist, "Burial");
        assert_eq!(first.album, "Untrue");
        assert_eq!(first.key, "11A");
        assert_eq!(first.tempo, 15490);
        assert_eq!(first.duration_secs, 46);
        assert_eq!(
            first.path,
            "/Contents/Burial/Untrue/Burial - Untrue - 01 Untitled.mp3"
        );
        assert_eq!(
            first.analyze_path,
            "/PIONEER/USBANLZ/P01B/00004BBD/ANLZ0000.DAT"
        );
        assert_eq!(first.date_added, "2026-11-15");
        assert_eq!(first.file_type, 1);
        assert_eq!(first.artwork_id, 1);

        let last = &lib.tracks[40];
        assert_eq!(last.id, 41);
        assert_eq!(last.genre, "Dubstep");
        assert_eq!(last.year, 2024);
        assert_eq!(last.track_number, 2);
        assert_eq!(last.artwork_id, 0);

        let names: Vec<_> = lib.playlists.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            ["UKG", "Jungle / DnB", "Grime", "Dubstep", "Analyse"]
        );
        let analyse = &lib.playlists[4];
        assert_eq!(analyse.track_ids, (34..=41).collect::<Vec<_>>());
        assert!(
            lib.playlists
                .iter()
                .all(|p| !p.is_folder && p.parent_id == 0)
        );

        assert_eq!(lib.artwork.len(), 35);
        assert_eq!(
            lib.artwork[0],
            (1, "/PIONEER/Artwork/00001/b1.jpg".to_owned())
        );
        let _ = fs::remove_dir_all(path.parent().expect("dir"));
    }

    #[test]
    fn reading_leaves_the_file_untouched() {
        let path = fixture("untouched");
        read(&path).expect("reads");
        assert_eq!(fs::read(&path).expect("file"), FIXTURE);
        let dir = path.parent().expect("dir");
        let files: Vec<_> = fs::read_dir(dir).expect("list").collect();
        assert_eq!(files.len(), 1, "no -wal or -shm next to the drive's file");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_changes_still_in_the_wal() {
        let path = fixture("wal");
        let conn = open(&path).expect("opens");
        conn.pragma_update(None, "journal_mode", "WAL")
            .expect("wal");
        conn.pragma_update(None, "wal_autocheckpoint", 0)
            .expect("no checkpoint");
        conn.execute(
            "insert into playlist values (6, 5, 'Pending', null, 0, 0)",
            [],
        )
        .expect("insert");
        // Copy while the connection is open, so the new row exists only in the -wal file.
        let drive =
            std::env::temp_dir().join(format!("manplay-onelib-test-drive-{}", std::process::id()));
        fs::create_dir_all(&drive).expect("dir");
        let copy = drive.join("exportLibrary.db");
        fs::copy(&path, &copy).expect("db");
        fs::copy(sibling(&path, "-wal"), sibling(&copy, "-wal")).expect("wal");
        drop(conn);

        let lib = read(&copy).expect("reads");
        assert_eq!(
            lib.playlists.last().map(|p| p.name.as_str()),
            Some("Pending")
        );
        let _ = fs::remove_dir_all(&drive);
        let _ = fs::remove_dir_all(path.parent().expect("dir"));
    }

    #[test]
    fn reports_the_export_version() {
        let path = fixture("version");
        let conn = open(&path).expect("opens");
        assert_eq!(db_version(&conn).expect("query").as_deref(), Some("1000"));
        drop(conn);
        let _ = fs::remove_dir_all(path.parent().expect("dir"));
    }

    #[test]
    fn rejects_a_file_that_is_not_one() {
        let dir =
            std::env::temp_dir().join(format!("manplay-onelib-test-bad-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("exportLibrary.db");
        fs::write(&path, [7u8; 8192]).expect("write");
        assert!(read(&path).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
