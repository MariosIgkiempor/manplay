//! rekordbox's newer USB library, `OneLibrary` (formerly `Device Library Plus`):
//! `PIONEER/rekordbox/exportLibrary.db`, read by the CDJ-3000X, OPUS-QUAD, XDJ-AZ and OMNIS-DUO.
//!
//! It is an SQLite database encrypted with `SQLCipher` 4 (default settings) under one passphrase
//! shared by every drive. Layout and key from pyrekordbox (`pyrekordbox/onelibrary`); notes in
//! `docs/onelibrary.md`. Tracks, playlists and artwork map onto the same [`Library`] as
//! `export.pdb`, with the same ids, so both files can be written from one list.

use crate::pdb::{Library, Playlist, Track};
use rusqlite::Connection;
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
    let dir = Scratch::new()?;
    let conn = open(&dir.copy_of(path)?)?;
    read_conn(&conn).map_err(|e| e.to_string())
}

/// A temporary folder, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, String> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("manplay-onelib-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(Self(dir))
    }

    fn db(&self) -> PathBuf {
        self.0.join("exportLibrary.db")
    }

    /// Copies a database and its `-wal` in.
    fn copy_of(&self, path: &Path) -> Result<PathBuf, String> {
        let copy = self.db();
        fs::copy(path, &copy).map_err(|e| e.to_string())?;
        let wal = sibling(path, "-wal");
        if wal.is_file() {
            fs::copy(&wal, sibling(&copy, "-wal")).map_err(|e| e.to_string())?;
        }
        Ok(copy)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
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
                analysisDataFilePath, dateCreated, length, bpmx100, bitrate, samplingRate, fileSize,
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
                // export.pdb's "date added" is rekordbox's `dateCreated` (when the song joined
                // the collection); `dateAdded` is when it went onto this drive.
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

/// Adds what only the drive's `OneLibrary` has to `lib` (read from `export.pdb`): tracks whose id
/// and path are both new, top-level playlists with a new name (given new ids), and artwork.
/// rekordbox uses the same track ids in both files, so a playlist keeps a track only when the id
/// means the same song in both.
pub fn merge(lib: &mut Library, one: Library) {
    let paths: std::collections::HashSet<String> =
        lib.tracks.iter().map(|t| t.path.to_lowercase()).collect();
    let mut same: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for t in one.tracks {
        match lib.tracks.iter().find(|k| k.id == t.id) {
            Some(k) => {
                if k.path.eq_ignore_ascii_case(&t.path) {
                    same.insert(t.id);
                }
            }
            None if !paths.contains(&t.path.to_lowercase()) => {
                same.insert(t.id);
                lib.tracks.push(t);
            }
            None => {}
        }
    }
    let mut next_id = lib.playlists.iter().map(|p| p.id).max().unwrap_or(0) + 1;
    let mut next_sort = lib
        .playlists
        .iter()
        .filter(|p| p.parent_id == 0)
        .map(|p| p.sort_order + 1)
        .max()
        .unwrap_or(0);
    for p in one.playlists {
        let taken = lib
            .playlists
            .iter()
            .any(|k| k.parent_id == 0 && k.name == p.name);
        if p.parent_id != 0 || p.is_folder || taken {
            continue;
        }
        lib.playlists.push(Playlist {
            id: next_id,
            sort_order: next_sort,
            track_ids: p
                .track_ids
                .into_iter()
                .filter(|id| same.contains(id))
                .collect(),
            ..p
        });
        next_id += 1;
        next_sort += 1;
    }
    for (id, path) in one.artwork {
        if !lib.artwork.iter().any(|(k, _)| *k == id) {
            lib.artwork.push((id, path));
        }
    }
}

/// The `OneLibrary` for `lib`, as the bytes of one database file (no `-wal`/`-shm` needed).
///
/// Built from a copy of `existing` (the drive's current file) when it has tracks, so rekordbox's
/// cues, history, My Tags and menu settings stay; otherwise from rekordbox's empty export. Rows
/// are then made to match `lib`: the same tracks (by id and path), playlists and artwork as the
/// `export.pdb` written from it. All work happens in a temporary folder, not on the drive.
pub fn build(existing: Option<&Path>, lib: &Library, today: &str) -> Result<Vec<u8>, String> {
    let dir = Scratch::new()?;
    let kept = existing.and_then(|path| {
        let copy = dir.copy_of(path).ok()?;
        let conn = open(&copy).ok()?;
        let tracks: i64 = conn
            .query_row("select count(*) from content", [], |r| r.get(0))
            .ok()?;
        (tracks > 0).then_some(conn)
    });
    let mut conn = if let Some(conn) = kept {
        conn
    } else {
        for suffix in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(sibling(&dir.db(), suffix));
        }
        let conn = open(&dir.db())?;
        conn.execute_batch(include_str!("template.sql"))
            .map_err(|e| e.to_string())?;
        conn
    };
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    apply(&mut conn, lib, today).map_err(|e| format!("writing the OneLibrary: {e}"))?;
    // Closing the last connection folds the WAL into the file and deletes it.
    conn.close().map_err(|(_, e)| e.to_string())?;
    if sibling(&dir.db(), "-wal").exists() {
        return Err("the OneLibrary's journal was not folded in".to_owned());
    }
    fs::read(dir.db()).map_err(|e| e.to_string())
}

/// Finds or adds a name in a lookup table (`artist`, `genre`, ...); `None` for an empty name.
struct Lookup {
    table: &'static str,
    ids: HashMap<String, i64>,
}

impl Lookup {
    fn new(conn: &Connection, table: &'static str) -> rusqlite::Result<Self> {
        let ids = names(conn, table)?
            .into_iter()
            .map(|(id, name)| (name, id))
            .collect();
        Ok(Self { table, ids })
    }

    fn id(&mut self, conn: &Connection, name: &str) -> rusqlite::Result<Option<i64>> {
        if name.is_empty() {
            return Ok(None);
        }
        if let Some(id) = self.ids.get(name) {
            return Ok(Some(*id));
        }
        let t = self.table;
        let id: i64 = conn.query_row(
            &format!("select coalesce(max({t}_id), 0) + 1 from {t}"),
            [],
            |r| r.get(0),
        )?;
        conn.execute(
            &format!("insert into {t} ({t}_id, name) values (?1, ?2)"),
            (id, name),
        )?;
        self.ids.insert(name.to_owned(), id);
        Ok(Some(id))
    }
}

/// Values rekordbox 7 writes for an analysed track; their meaning is not known.
const ANALYSED_BITS: i64 = 41;
const CONTENT_LINK: i64 = 0xC_0700;

#[allow(clippy::too_many_lines)] // one pass over the tables, in order
fn apply(conn: &mut Connection, lib: &Library, today: &str) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    let on_disk: HashMap<u32, String> = {
        let mut stmt = tx.prepare("select content_id, path from content")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                num(r.get(0)?),
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            ))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let wanted: HashMap<u32, &Track> = lib.tracks.iter().map(|t| (t.id, t)).collect();

    // Rows for songs no longer in the library, or for a different song under the same id.
    for (id, path) in &on_disk {
        let keep = wanted
            .get(id)
            .is_some_and(|t| t.path.eq_ignore_ascii_case(path));
        if !keep {
            for sql in [
                "delete from content where content_id = ?1",
                "delete from cue where content_id = ?1",
                "delete from history_content where content_id = ?1",
                "delete from myTag_content where content_id = ?1",
                "delete from recommendedLike where content_id_1 = ?1 or content_id_2 = ?1",
            ] {
                tx.execute(sql, [id])?;
            }
        }
    }

    let mut artists = Lookup::new(&tx, "artist")?;
    let mut genres = Lookup::new(&tx, "genre")?;
    let mut keys = Lookup::new(&tx, "key")?;
    let mut albums: HashMap<(String, Option<i64>), i64> = {
        let mut stmt = tx.prepare("select album_id, name, artist_id from album")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                (
                    r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    r.get::<_, Option<i64>>(2)?,
                ),
                r.get::<_, i64>(0)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let images: std::collections::HashSet<u32> = lib.artwork.iter().map(|(id, _)| *id).collect();

    for t in &lib.tracks {
        let kept = on_disk
            .get(&t.id)
            .is_some_and(|p| p.eq_ignore_ascii_case(&t.path));
        let key = keys.id(&tx, &t.key)?;
        let analysis = (!t.analyze_path.is_empty()).then_some(t.analyze_path.as_str());
        if kept {
            // rekordbox's row: keep it, but take a beat grid, tempo or key manplay added.
            tx.execute(
                "update content set
                   analysisDataFilePath = coalesce(?2, analysisDataFilePath),
                   analysedBits = case when ?2 is null then analysedBits
                                       else coalesce(nullif(analysedBits, 0), ?5) end,
                   bpmx100 = case when ?3 > 0 then ?3 else bpmx100 end,
                   key_id = coalesce(?4, key_id)
                 where content_id = ?1",
                (t.id, analysis, t.tempo, key, ANALYSED_BITS),
            )?;
            continue;
        }
        let artist = artists.id(&tx, &t.artist)?;
        let genre = genres.id(&tx, &t.genre)?;
        let album = if t.album.is_empty() {
            None
        } else if let Some(id) = albums.get(&(t.album.clone(), artist)) {
            Some(*id)
        } else {
            let id: i64 = tx.query_row(
                "select coalesce(max(album_id), 0) + 1 from album",
                [],
                |r| r.get(0),
            )?;
            tx.execute(
                "insert into album (album_id, name, artist_id, image_id, isComplation, nameForSearch)
                 values (?1, ?2, ?3, null, 0, '')",
                (id, &t.album, artist),
            )?;
            albums.insert((t.album.clone(), artist), id);
            Some(id)
        };
        let image = (t.artwork_id != 0 && images.contains(&t.artwork_id)).then_some(t.artwork_id);
        let file_name = t.path.rsplit('/').next().unwrap_or_default();
        tx.execute(
            "insert into content (
               content_id, title, titleForSearch, subtitle, bpmx100, length, trackNo, discNo,
               artist_id_artist, artist_id_lyricist, album_id, genre_id, key_id, color_id,
               image_id, djComment, rating, releaseYear, releaseDate, dateCreated, dateAdded,
               path, fileName, fileSize, fileType, bitrate, bitDepth, samplingRate, isrc,
               djPlayCount, isHotCueAutoLoadOn, isKuvoDeliverStatusOn, kuvoDeliveryComment,
               masterDbId, masterContentId, analysisDataFilePath, analysedBits, contentLink,
               hasModified)
             values (
               ?1, ?2, '', '', ?3, ?4, ?5, 0,
               ?6, 0, ?7, ?8, ?9, 0,
               ?10, ?11, 0, ?12, '', ?14, ?13,
               ?15, ?16, ?17, ?18, ?19, 16, ?20, '',
               0, 1, 1, '',
               0, ?1, ?21, ?22, ?23,
               0)",
            rusqlite::params![
                t.id,
                t.title,
                t.tempo,
                t.duration_secs,
                t.track_number,
                artist,
                album,
                genre,
                key,
                image,
                t.comment,
                t.year,
                today,
                t.date_added,
                t.path,
                file_name,
                t.file_size,
                t.file_type,
                t.bitrate,
                t.sample_rate,
                analysis,
                if analysis.is_some() { ANALYSED_BITS } else { 0 },
                CONTENT_LINK,
            ],
        )?;
    }

    for (id, path) in &lib.artwork {
        tx.execute(
            "insert into image (image_id, path) values (?1, ?2)
             on conflict(image_id) do update set path = excluded.path",
            (id, path),
        )?;
    }

    // Playlists are rewritten whole: `lib` already holds rekordbox's as well as manplay's.
    tx.execute("delete from playlist_content", [])?;
    tx.execute("delete from playlist", [])?;
    for p in &lib.playlists {
        tx.execute(
            "insert into playlist (playlist_id, sequenceNo, name, image_id, attribute,
                                   playlist_id_parent)
             values (?1, ?2, ?3, null, ?4, ?5)",
            (
                p.id,
                p.sort_order,
                &p.name,
                i64::from(p.is_folder),
                p.parent_id,
            ),
        )?;
        for (n, track) in p.track_ids.iter().enumerate() {
            if wanted.contains_key(track) {
                tx.execute(
                    "insert into playlist_content (playlist_id, content_id, sequenceNo)
                     values (?1, ?2, ?3)",
                    (p.id, track, i64::try_from(n + 1).unwrap_or(i64::MAX)),
                )?;
            }
        }
    }

    let count: i64 = tx.query_row("select count(*) from content", [], |r| r.get(0))?;
    tx.execute(
        "update property set numberOfContents = ?1, dbVersion = '1000',
           createdDate = case when coalesce(createdDate, '') = '' then ?2 else createdDate end",
        (count, today),
    )?;
    tx.commit()
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
        assert_eq!(first.date_added, "2026-11-13");
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

    fn written(name: &str, bytes: &[u8]) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("manplay-onelib-test-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("exportLibrary.db");
        fs::write(&path, bytes).expect("write");
        path
    }

    fn song(id: u32, path: &str) -> Track {
        Track {
            id,
            title: format!("Song {id}"),
            artist: "Burial".into(),
            album: "Untrue".into(),
            genre: "Garage".into(),
            key: "8A".into(),
            path: path.into(),
            analyze_path: format!("/PIONEER/USBANLZ/P001/{id:08X}/ANLZ0000.DAT"),
            date_added: "2026-11-15".into(),
            duration_secs: 200,
            tempo: 13_950,
            bitrate: 320,
            sample_rate: 44_100,
            file_size: 1000 + id,
            year: 2007,
            track_number: id,
            file_type: 1,
            ..Track::default()
        }
    }

    #[test]
    fn rebuilding_rekordbox_export_changes_nothing_read_back() {
        let path = fixture("rebuild");
        let lib = read(&path).expect("reads");
        let bytes = build(Some(&path), &lib, "2026-11-16").expect("builds");
        let out = written("rebuild-out", &bytes);
        assert_eq!(read(&out).expect("reads back"), lib);
        // rekordbox's own values stay on its rows.
        let conn = open(&out).expect("opens");
        let master: i64 = conn
            .query_row(
                "select masterDbId from content where content_id = 1",
                [],
                |r| r.get(0),
            )
            .expect("row");
        assert_eq!(master, 1_914_851_955);
        let tags: i64 = conn
            .query_row("select count(*) from myTag", [], |r| r.get(0))
            .expect("tags");
        assert_eq!(tags, 28);
        let _ = fs::remove_dir_all(path.parent().expect("dir"));
        let _ = fs::remove_dir_all(out.parent().expect("dir"));
    }

    #[test]
    fn builds_a_new_library_from_the_template() {
        let lib = Library {
            tracks: vec![song(1, "/Contents/Burial/Untrue/a.mp3"), {
                let mut t = song(2, "/Contents/UnknownArtist/UnknownAlbum/b.wav");
                t.artist = String::new();
                t.album = String::new();
                t.genre = String::new();
                t.analyze_path = String::new();
                t.artwork_id = 3;
                t
            }],
            playlists: vec![
                Playlist {
                    id: 1,
                    name: "Sets".into(),
                    is_folder: true,
                    ..Playlist::default()
                },
                Playlist {
                    id: 2,
                    parent_id: 1,
                    name: "Warm up".into(),
                    sort_order: 0,
                    track_ids: vec![2, 1],
                    ..Playlist::default()
                },
            ],
            artwork: vec![(3, "/PIONEER/Artwork/00001/a3.jpg".into())],
        };
        let bytes = build(None, &lib, "2026-11-15").expect("builds");
        assert_ne!(&bytes[..16], b"SQLite format 3\0", "encrypted");
        let out = written("new", &bytes);
        assert_eq!(read(&out).expect("reads back"), lib);

        let conn = open(&out).expect("opens");
        let menus: i64 = conn
            .query_row("select count(*) from menuItem", [], |r| r.get(0))
            .expect("menus");
        assert_eq!(menus, 27);
        let (count, version): (i64, String) = conn
            .query_row(
                "select numberOfContents, dbVersion from property",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("property");
        assert_eq!((count, version.as_str()), (2, "1000"));
        let (artist, lyricist, bits): (Option<i64>, i64, i64) = conn
            .query_row(
                "select artist_id_artist, artist_id_lyricist, analysedBits from content where content_id = 2",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("row");
        assert_eq!((artist, lyricist, bits), (None, 0, 0));
        let mode: String = conn
            .query_row("pragma journal_mode", [], |r| r.get(0))
            .expect("mode");
        assert_eq!(mode, "wal", "rekordbox's journal mode");
        let _ = fs::remove_dir_all(out.parent().expect("dir"));
    }

    #[test]
    fn updates_rekordbox_export_to_match_the_library() {
        let path = fixture("update");
        let mut lib = read(&path).expect("reads");
        lib.tracks.retain(|t| t.id != 2);
        // A different song under id 3 replaces rekordbox's row; id 42 is new.
        if let Some(t) = lib.tracks.iter_mut().find(|t| t.id == 3) {
            *t = song(3, "/Contents/Other/x.mp3");
        }
        lib.tracks.push(song(42, "/Contents/Burial/Untrue/new.mp3"));
        lib.playlists.retain(|p| p.name != "Grime");
        lib.playlists[0].track_ids = vec![42, 1, 2, 3];
        let bytes = build(Some(&path), &lib, "2026-11-16").expect("builds");
        let out = written("update-out", &bytes);
        let back = read(&out).expect("reads back");

        assert_eq!(back.tracks.len(), 41);
        let mut expected = lib.tracks.clone();
        expected.sort_by_key(|t| t.id);
        assert_eq!(back.tracks, expected);
        let ukg = back
            .playlists
            .iter()
            .find(|p| p.name == "UKG")
            .expect("playlist");
        assert_eq!(ukg.track_ids, [42, 1, 3], "the removed song is left out");
        assert!(back.playlists.iter().all(|p| p.name != "Grime"));
        let conn = open(&out).expect("opens");
        let master: Option<i64> = conn
            .query_row(
                "select masterDbId from content where content_id = 3",
                [],
                |r| r.get(0),
            )
            .expect("row");
        assert_eq!(master, Some(0), "id 3 is manplay's row now");
        let _ = fs::remove_dir_all(path.parent().expect("dir"));
        let _ = fs::remove_dir_all(out.parent().expect("dir"));
    }

    #[test]
    fn merges_what_only_the_one_library_has() {
        let path = fixture("merge");
        let one = read(&path).expect("reads");
        // export.pdb as on NOCTURN: the same 41 tracks but only the "Analyse" playlist, as id 1.
        let mut lib = Library {
            tracks: one.tracks.clone(),
            playlists: vec![Playlist {
                id: 1,
                name: "Analyse".into(),
                track_ids: (34..=41).collect(),
                ..Playlist::default()
            }],
            artwork: one.artwork.clone(),
        };
        // One id that means another song in export.pdb.
        lib.tracks[0].path = "/Contents/Else/else.mp3".into();
        merge(&mut lib, one);

        assert_eq!(lib.tracks.len(), 41);
        let names: Vec<_> = lib
            .playlists
            .iter()
            .map(|p| (p.id, p.name.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                (1, "Analyse"),
                (2, "UKG"),
                (3, "Jungle / DnB"),
                (4, "Grime"),
                (5, "Dubstep")
            ]
        );
        assert_eq!(
            lib.playlists[1].track_ids,
            (2..=16).collect::<Vec<_>>(),
            "not track 1"
        );
        assert_eq!(lib.playlists[1].sort_order, 1);
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
