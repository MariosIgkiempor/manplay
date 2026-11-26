//! Cover pictures on the destination: files, not ops. A picture is named by the hash of its
//! bytes, so it is written once and never changes; a song's `cover` field says which one it has
//! (`song_tags.rs`).
//!
//! Path: `.manplay/covers/<name>`. Only pictures someone changed are sent on their own: the
//! cover a file simply had is in every device's copy of that file already. Where devices' copies
//! differed when they joined, the device that lacks the picture asks for it with a small
//! file at `.manplay/covers-wanted/<name>`, and a device that has it sends it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, params};

use super::journal;
use super::remote::ChunkStore;
use super::song_tags::{self, COVER, E_SONG_TAGS};
use super::write::{active, device_id, is_early};
use crate::error::Error;
use crate::tags::CoverBackupName;

/// Folder under `.manplay` that holds the cover pictures.
pub const DIR: &str = "covers";
/// Folder under `.manplay` that holds the requests for pictures: one file per picture, named
/// like the picture.
pub const WANTED_DIR: &str = "covers-wanted";
/// A picture larger than this is neither uploaded nor fetched.
pub const MAX_BYTES: usize = 10 * 1024 * 1024;
/// How long a picture no song has any more stays on the destination, UTC ms: as long as the
/// change that replaced it can be taken back.
pub const UNUSED_KEPT_MS: i64 = journal::KEEP_MS;

/// What a transfer of cover pictures did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Transfer {
    pub sent: usize,
    pub fetched: usize,
    /// Pictures this device waits for that are not on the destination, newly asked for.
    pub asked: usize,
}

/// A picture's path under `.manplay`.
fn place(name: &str) -> String {
    format!("{DIR}/{name}")
}

/// The path under `.manplay` of the request for a picture.
fn request(name: &str) -> String {
    format!("{WANTED_DIR}/{name}")
}

/// The files in a folder of `.manplay` that are named like a cover picture.
async fn listed<S: ChunkStore>(store: &S, dir: &str) -> Result<BTreeSet<String>, Error> {
    Ok(store
        .list_meta(dir)
        .await?
        .into_iter()
        .filter(|name| song_tags::cover_named(name).is_some())
        .collect())
}

fn lock(db: &Mutex<Connection>) -> Result<std::sync::MutexGuard<'_, Connection>, Error> {
    db.lock().map_err(|_| Error::Lock)
}

/// Where this device has a picture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Held {
    /// As the cover of this song file.
    InFile(PathBuf),
    /// As a file of its own among the pictures kept on this device.
    Kept(PathBuf),
}

impl Held {
    /// The picture, when it is still the one called `name`.
    fn read(&self, name: &CoverBackupName) -> Option<Vec<u8>> {
        match self {
            Self::InFile(file) => crate::tags::front_cover(file)
                .filter(|(found, _)| found == name)
                .map(|(_, bytes)| bytes),
            Self::Kept(file) => std::fs::read(file).ok().filter(|bytes| name.names(bytes)),
        }
    }
}

/// The pictures to send, each with where this device has it: covers someone set (not what a
/// file simply had) that are not known to be on the destination, and the pictures in `asked`
/// (another device waits for them). A picture no file here has any more is taken from `cache`.
pub fn to_send(
    conn: &Connection,
    root: &Path,
    cache: &Path,
    asked: &BTreeSet<String>,
) -> Result<Vec<(CoverBackupName, Held)>, Error> {
    if !active(conn)? {
        return Ok(Vec::new());
    }
    let tracked = song_tags::tracked(conn, root)?;
    let holders: BTreeMap<&str, &Path> = tracked
        .values()
        .filter_map(|file| Some((file.fields.get(COVER)?.as_str(), file.path.as_path())))
        .collect();
    let mut names: BTreeSet<String> = asked.clone();
    let mut stmt = conn.prepare(
        "SELECT val, clock FROM op_state
         WHERE e = ?1 AND f = ?2
           AND json_extract(val, '$') NOT IN (SELECT name FROM covers_pushed)",
    )?;
    let rows = stmt.query_map(params![E_SONG_TAGS, COVER], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (val, clock) = row?;
        if let Ok(name) = serde_json::from_str::<String>(&val)
            && !is_early(&clock)
        {
            names.insert(name);
        }
    }
    Ok(names
        .iter()
        .filter_map(|text| {
            let name = song_tags::cover_named(text)?;
            let held = match holders.get(text.as_str()) {
                Some(file) => Held::InFile(file.to_path_buf()),
                None => Some(cache.join(text))
                    .filter(|kept| kept.is_file())
                    .map(Held::Kept)?,
            };
            Some((name, held))
        })
        .collect())
}

/// The pictures to fetch: covers other devices set for songs of this library that are not in
/// `cache` yet.
pub fn to_fetch(
    conn: &Connection,
    root: &Path,
    cache: &Path,
) -> Result<Vec<CoverBackupName>, Error> {
    let names: BTreeSet<String> = song_tags::wanted(conn, root)?
        .iter()
        .filter_map(song_tags::TagWrite::cover)
        .map(|name| name.as_str().to_owned())
        .filter(|name| !cache.join(name).exists())
        .collect();
    Ok(names
        .iter()
        .filter_map(|name| song_tags::cover_named(name))
        .collect())
}

fn sent(db: &Mutex<Connection>, name: &CoverBackupName) -> Result<(), Error> {
    lock(db)?.execute(
        "INSERT OR IGNORE INTO covers_pushed (name) VALUES (?1)",
        params![name.as_str()],
    )?;
    Ok(())
}

/// Sends up to `limit` pictures the destination lacks and fetches up to `limit` it has that
/// this device waits for, into `cache`. A picture this device waits for that is not there is
/// asked for; one that is too big or is not the picture its name says is left out. What is left
/// goes after the next sync.
pub async fn transfer<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    root: &Path,
    cache: &Path,
    limit: usize,
) -> Result<Transfer, Error> {
    let asked = listed(store, WANTED_DIR).await?;
    let (send, fetch) = {
        let conn = lock(db)?;
        back_in_use(&conn)?;
        (
            to_send(&conn, root, cache, &asked)?,
            to_fetch(&conn, root, cache)?,
        )
    };
    let mut out = Transfer::default();
    if send.is_empty() && fetch.is_empty() && asked.is_empty() {
        return Ok(out);
    }
    let mut there = listed(store, DIR).await?;
    for (name, held) in send.into_iter().take(limit) {
        if there.contains(name.as_str()) {
            sent(db, &name)?;
            continue;
        }
        let wanted = name.clone();
        let read = tokio::task::spawn_blocking(move || held.read(&wanted))
            .await
            .map_err(|e| Error::Msg(e.to_string()))?;
        // The file changed since it was read: its new cover goes after the next look at it.
        let Some(bytes) = read else {
            continue;
        };
        if bytes.len() <= MAX_BYTES && crate::tags::is_cover(&bytes) {
            store.write_meta(&place(name.as_str()), bytes).await?;
            there.insert(name.as_str().to_owned());
            out.sent += 1;
        }
        sent(db, &name)?;
    }
    for name in asked.intersection(&there) {
        store.delete_meta(&request(name)).await?;
    }
    for name in fetch.into_iter().take(limit) {
        if !there.contains(name.as_str()) {
            if !asked.contains(name.as_str()) {
                store
                    .write_meta(&request(name.as_str()), name.as_str().as_bytes().to_vec())
                    .await?;
                out.asked += 1;
            }
            continue;
        }
        let Some(bytes) = store.read_meta(&place(name.as_str())).await? else {
            continue;
        };
        if bytes.len() > MAX_BYTES || !name.names(&bytes) || !crate::tags::is_cover(&bytes) {
            log::warn!(
                "the cover {} on the destination is not usable",
                name.as_str()
            );
            continue;
        }
        tokio::fs::create_dir_all(cache).await?;
        tokio::fs::write(cache.join(name.as_str()), bytes).await?;
        out.fetched += 1;
    }
    Ok(out)
}

/// The pictures the songs' covers are, by name, whatever device has them.
fn named(conn: &Connection) -> Result<BTreeSet<String>, Error> {
    let mut stmt = conn.prepare("SELECT val FROM op_state WHERE e = ?1 AND f = ?2")?;
    let rows = stmt.query_map(params![E_SONG_TAGS, COVER], |r| r.get::<_, String>(0))?;
    let mut out = BTreeSet::new();
    for val in rows {
        if let Ok(name) = serde_json::from_str::<String>(&val?) {
            out.insert(name);
        }
    }
    Ok(out)
}

/// Forgets that a picture was seen unused once a song has it again, so the time it is kept
/// starts over when it is next unused.
fn back_in_use(conn: &Connection) -> Result<(), Error> {
    conn.execute(
        "DELETE FROM covers_unused WHERE name IN
             (SELECT json_extract(val, '$') FROM op_state WHERE e = ?1 AND f = ?2)",
        params![E_SONG_TAGS, COVER],
    )?;
    Ok(())
}

/// Removes from the destination the pictures no song has had for [`UNUSED_KEPT_MS`], counted
/// from when this device first saw them unused, and the requests for pictures no song has.
/// Returns how many pictures it removed. Nothing while this device has not read everything the
/// others wrote.
pub async fn clean<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    now_ms: i64,
) -> Result<usize, Error> {
    let there = listed(store, DIR).await?;
    let asked = listed(store, WANTED_DIR).await?;
    // Chunks of other devices not applied here yet may name a picture: this device cannot tell
    // an unused picture from a new one, and leaves them all.
    for c in store.list_chunks().await? {
        let conn = lock(db)?;
        if c.chunk.dev != device_id(&conn)?
            && c.chunk.seq > super::state::cursor(&conn, &c.chunk.dev)?
        {
            return Ok(0);
        }
    }
    let (named, overdue) = {
        let conn = lock(db)?;
        let named = named(&conn)?;
        conn.execute("DELETE FROM covers_unused WHERE since_ms > ?1", [now_ms])?;
        let seen: BTreeSet<String> = conn
            .prepare("SELECT name FROM covers_unused")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        for name in seen
            .iter()
            .filter(|n| named.contains(*n) || !there.contains(*n))
        {
            conn.execute("DELETE FROM covers_unused WHERE name = ?1", [name])?;
        }
        for name in there.difference(&named) {
            conn.execute(
                "INSERT OR IGNORE INTO covers_unused (name, since_ms) VALUES (?1, ?2)",
                params![name, now_ms],
            )?;
        }
        let overdue: Vec<String> = conn
            .prepare("SELECT name FROM covers_unused WHERE since_ms <= ?1")?
            .query_map([now_ms - UNUSED_KEPT_MS], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        (named, overdue)
    };
    for name in asked.difference(&named) {
        store.delete_meta(&request(name)).await?;
    }
    let mut removed = 0;
    for name in overdue {
        store.delete_meta(&place(&name)).await?;
        let conn = lock(db)?;
        conn.execute("DELETE FROM covers_unused WHERE name = ?1", [&name])?;
        conn.execute("DELETE FROM covers_pushed WHERE name = ?1", [&name])?;
        removed += 1;
    }
    Ok(removed)
}
