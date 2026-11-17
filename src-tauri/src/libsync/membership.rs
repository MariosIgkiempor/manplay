//! Being in a shared library: reading what a destination holds, joining it, leaving it.
//!
//! A destination with shared data has `.manplay/library.json` (which library it is) and one
//! `.manplay/devices/<device id>.json` per member. A device belongs to at most one library: the
//! destination whose `sync_targets.libsync` is on. Every other destination is files only and
//! `.manplay/` there is never written. See `docs/plans/shared-library/05-join-and-leave.md`.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use super::apply::{PLAYLISTS, SMARTS, TAGS};
use super::entities;
use super::remote::{ChunkStore, RunSummary, run_at};
use super::write::{active, device_id, new_uid};
use super::{clock, compact, snapshot};
use crate::db;
use crate::error::Error;

/// Names the library and the format of what is under `.manplay/`.
pub const LIBRARY_FILE: &str = "library.json";
/// One small file per member device.
pub const DEVICES_DIR: &str = "devices";
/// Tells Jellyfin to skip the folder, next to the dot in its name.
pub const IGNORE_FILE: &str = ".ignore";

const SETTING_LIBRARY_ID: &str = "library_id";
const SETTING_LIBRARY_NAME: &str = "library_name";
const SETTING_DEVICE_NAME: &str = "device_name";
const SETTING_SEEDED: &str = "libsync_seeded";

/// Version of `library.json`.
pub const LIBRARY_FORMAT: u32 = 1;

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0))
}

fn lock(db: &Mutex<Connection>) -> Result<std::sync::MutexGuard<'_, Connection>, Error> {
    db.lock().map_err(|_| Error::Lock)
}

// ---- files on the destination ---------------------------------------------------

/// `.manplay/library.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFile {
    pub format: u32,
    pub library_id: String,
    pub name: String,
    /// Unix seconds, UTC.
    pub created_at: i64,
}

/// `.manplay/devices/<id>.json`: who is in the library, and when they last synced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFile {
    pub name: String,
    /// Unix seconds, UTC.
    pub last_seen: i64,
    /// The analysis version this device writes waveforms and grids with.
    #[serde(default)]
    pub analysis_version: i64,
}

fn device_path(id: &str) -> String {
    format!("{DEVICES_DIR}/{id}.json")
}

fn to_json<T: Serialize>(value: &T) -> Result<Vec<u8>, Error> {
    serde_json::to_vec_pretty(value).map_err(|e| Error::Msg(e.to_string()))
}

async fn read_library<S: ChunkStore>(store: &S) -> Result<Option<LibraryFile>, Error> {
    let Some(bytes) = store.read_meta(LIBRARY_FILE).await? else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|e| {
        Error::Msg(format!(
            "{LIBRARY_FILE} on the destination cannot be read: {e}"
        ))
    })
}

/// The `format` in `library.json`, if the file is there and readable.
pub async fn library_format<S: ChunkStore>(store: &S) -> Result<Option<u32>, Error> {
    Ok(read_library(store).await?.map(|f| f.format))
}

/// Writes `library.json` and `.ignore`.
async fn write_library<S: ChunkStore>(store: &S, file: &LibraryFile) -> Result<(), Error> {
    store.write_meta(LIBRARY_FILE, to_json(file)?).await?;
    store.write_meta(IGNORE_FILE, Vec::new()).await
}

// ---- this device ----------------------------------------------------------------

/// The machine's own name, for a device that was never named.
fn machine_name() -> String {
    #[cfg(target_os = "macos")]
    if let Some(name) = command_output("scutil", &["--get", "ComputerName"]) {
        return name;
    }
    #[cfg(target_os = "windows")]
    if let Ok(name) = std::env::var("COMPUTERNAME")
        && !name.trim().is_empty()
    {
        return name.trim().to_owned();
    }
    command_output("hostname", &[]).unwrap_or_else(|| "This device".to_owned())
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    let text = String::from_utf8(out.stdout).ok()?;
    let text = text.trim();
    (out.status.success() && !text.is_empty()).then(|| text.to_owned())
}

/// What other members see this device as: the name set in Settings, or the machine's name.
pub fn device_name(conn: &Connection) -> Result<String, Error> {
    Ok(db::get_setting(conn, SETTING_DEVICE_NAME)?.unwrap_or_else(machine_name))
}

/// Names this device; an empty name goes back to the machine's.
pub fn set_device_name(conn: &Connection, name: &str) -> Result<(), Error> {
    let name = name.trim();
    db::set_setting(
        conn,
        SETTING_DEVICE_NAME,
        (!name.is_empty()).then_some(name),
    )
}

/// The name of the shared library this device is in, if it is in one and knows the name.
pub fn library_name(conn: &Connection) -> Result<Option<String>, Error> {
    db::get_setting(conn, SETTING_LIBRARY_NAME)
}

fn joined_target(conn: &Connection) -> Option<i64> {
    conn.query_row(
        "SELECT id FROM sync_targets WHERE libsync = 1 ORDER BY id LIMIT 1",
        [],
        |r| r.get(0),
    )
    .ok()
}

// ---- reading a destination ------------------------------------------------------

/// One device in a library.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub name: String,
    /// Unix seconds.
    pub last_seen: i64,
    /// This device.
    pub mine: bool,
}

/// The library a destination holds, with who is in it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub library_id: String,
    pub name: String,
    pub created_at: i64,
    pub members: Vec<Member>,
    /// When a member last synced, Unix seconds; the last change anyone made.
    pub last_change: Option<i64>,
}

/// Reads `.manplay/library.json` and `devices/`. Changes nothing.
pub async fn inspect<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
) -> Result<Option<Found>, Error> {
    let Some(file) = read_library(store).await? else {
        return Ok(None);
    };
    let me = {
        let conn = lock(db)?;
        device_id(&conn)?
    };
    let mut members = Vec::new();
    for name in store.list_meta(DEVICES_DIR).await? {
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        let Some(bytes) = store.read_meta(&device_path(id)).await? else {
            continue;
        };
        // A device file that cannot be read is left out of the list, not an error.
        if let Ok(d) = serde_json::from_slice::<DeviceFile>(&bytes) {
            members.push(Member {
                name: d.name,
                last_seen: d.last_seen,
                mine: id == me,
            });
        }
    }
    members.sort_by(|a, b| {
        b.last_seen
            .cmp(&a.last_seen)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(Some(Found {
        library_id: file.library_id,
        name: file.name,
        created_at: file.created_at,
        last_change: members.iter().map(|m| m.last_seen).max(),
        members,
    }))
}

// ---- joining ----------------------------------------------------------------------

/// What happens to what this device already has when it joins a library that exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JoinChoice {
    /// Mine become shared; same names go to the Clashes list.
    Merge,
    /// Mine become local; everything shared arrives.
    KeepLocal,
    /// Mine are dropped; everything shared arrives.
    Replace,
    /// There is no library yet: write `library.json` and share mine.
    Start,
}

/// What joining needs from the library's own database.
fn prepare_join(conn: &Connection, choice: JoinChoice) -> Result<(), Error> {
    match choice {
        JoinChoice::Merge | JoinChoice::Start => {}
        JoinChoice::KeepLocal => {
            for table in [TAGS.table, PLAYLISTS.table, SMARTS.table] {
                conn.execute(&format!("UPDATE {table} SET scope = 'local'"), [])?;
            }
        }
        JoinChoice::Replace => {
            conn.execute_batch(
                "DELETE FROM track_tags;
                 DELETE FROM playlist_tracks;
                 DELETE FROM tags;
                 DELETE FROM playlists;
                 DELETE FROM smart_playlists;
                 DELETE FROM clashes;
                 DELETE FROM oplog WHERE e IN
                     ('tag', 'track_tag', 'playlist', 'playlist_track', 'smart_playlist');
                 DELETE FROM op_state WHERE e IN
                     ('tag', 'track_tag', 'playlist', 'playlist_track', 'smart_playlist');
                 DELETE FROM op_cursor;",
            )?;
            snapshot::forget(conn)?;
        }
    }
    Ok(())
}

/// How many tags, playlists and smart playlists a replace would drop.
pub fn replace_count(conn: &Connection) -> Result<i64, Error> {
    let mut total = 0;
    for table in [TAGS.table, PLAYLISTS.table, SMARTS.table] {
        total += conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| {
            r.get::<_, i64>(0)
        })?;
    }
    Ok(total)
}

/// Joins `target_id`'s library (or starts one there with `Start`, called `new_name`), then does
/// the first sync. Refused while another destination holds this device's library. Problems
/// after the join itself (the first sync) are in the returned summary: the device is in the
/// library and the next sync repeats them.
pub async fn join<S: ChunkStore>(
    db: &Mutex<Connection>,
    target_id: i64,
    store: &S,
    choice: JoinChoice,
    new_name: &str,
) -> Result<RunSummary, Error> {
    {
        let conn = lock(db)?;
        let exists: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM sync_targets WHERE id = ?1)",
            params![target_id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(Error::Msg("That destination no longer exists.".into()));
        }
        if let Some(other) = joined_target(&conn) {
            return Err(Error::Msg(if other == target_id {
                "This device is already in the library of this destination.".into()
            } else {
                "This device is in another shared library. Leave it first.".into()
            }));
        }
    }
    let found = read_library(store).await?;
    let file = match (choice, found) {
        (JoinChoice::Start, None) => {
            let file = LibraryFile {
                format: LIBRARY_FORMAT,
                library_id: new_uid(),
                name: new_name.trim().to_owned(),
                created_at: now(),
            };
            write_library(store, &file).await?;
            file
        }
        (JoinChoice::Start, Some(_)) => {
            return Err(Error::Msg(
                "A shared library was started here in the meantime. Join it instead.".into(),
            ));
        }
        (_, Some(file)) => file,
        (_, None) => {
            return Err(Error::Msg(
                "There is no shared library here to join.".into(),
            ));
        }
    };
    {
        let mut conn = lock(db)?;
        let tx = conn.transaction()?;
        prepare_join(&tx, choice)?;
        db::set_setting(&tx, SETTING_LIBRARY_ID, Some(&file.library_id))?;
        db::set_setting(&tx, SETTING_LIBRARY_NAME, Some(&file.name))?;
        tx.commit()?;
        if let Err(e) = db::set_target_libsync(&mut conn, target_id, true) {
            db::set_setting(&conn, SETTING_LIBRARY_ID, None)?;
            db::set_setting(&conn, SETTING_LIBRARY_NAME, None)?;
            return Err(e);
        }
    }
    Ok(run_joined(db, store, &file.name).await)
}

/// Before each sync of a joined device: makes sure the destination still holds this device's
/// library, and says that this device is a member (`devices/<id>.json`).
///
/// A device that had library data on before libraries existed carries over as joined: it adopts
/// the `library.json` it finds, or writes one named `fallback_name`.
async fn ensure<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    fallback_name: &str,
) -> Result<(), Error> {
    let (known, id, name) = {
        let conn = lock(db)?;
        (
            db::get_setting(&conn, SETTING_LIBRARY_ID)?,
            device_id(&conn)?,
            device_name(&conn)?,
        )
    };
    let found = read_library(store).await?;
    match (known, found) {
        (Some(mine), Some(file)) if file.library_id != mine => {
            return Err(Error::Msg(format!(
                "This destination now holds another shared library (“{}”). Leave this one and join it again.",
                file.name
            )));
        }
        (None, Some(file)) => {
            let conn = lock(db)?;
            remember(&conn, &file)?;
        }
        (known, None) => {
            let (library_id, library) = {
                let conn = lock(db)?;
                (
                    known.unwrap_or_else(new_uid),
                    library_name(&conn)?.unwrap_or_else(|| fallback_name.to_owned()),
                )
            };
            let file = LibraryFile {
                format: LIBRARY_FORMAT,
                library_id,
                name: library,
                created_at: now(),
            };
            write_library(store, &file).await?;
            let conn = lock(db)?;
            remember(&conn, &file)?;
        }
        (Some(_), Some(_)) => {}
    }
    let device = DeviceFile {
        name,
        last_seen: now(),
        analysis_version: crate::analysis::VERSION,
    };
    store.write_meta(&device_path(&id), to_json(&device)?).await
}

fn remember(conn: &Connection, file: &LibraryFile) -> Result<(), Error> {
    db::set_setting(conn, SETTING_LIBRARY_ID, Some(&file.library_id))?;
    db::set_setting(conn, SETTING_LIBRARY_NAME, Some(&file.name))
}

/// One sync of library data for a device that is in a library. A device that is not in one
/// does nothing and does not touch the destination.
pub async fn run_joined<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    fallback_name: &str,
) -> RunSummary {
    run_joined_at(db, store, fallback_name, clock::now_ms()).await
}

/// [`run_joined`] at a given time (UTC ms).
pub async fn run_joined_at<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    fallback_name: &str,
    now_ms: i64,
) -> RunSummary {
    match lock(db).and_then(|c| active(&c)) {
        Ok(true) => {}
        Ok(false) => return RunSummary::default(),
        Err(e) => {
            return RunSummary {
                error: Some(e.to_string()),
                ..RunSummary::default()
            };
        }
    }
    if let Err(e) = ensure(db, store, fallback_name).await {
        return RunSummary {
            error: Some(e.to_string()),
            ..RunSummary::default()
        };
    }
    let summary = run_at(db, store, now_ms).await;
    if summary.error.is_none() {
        // Neither is needed for the sync itself: a failure here is tried again next time.
        if let Err(e) = refresh_devices(db, store).await {
            log::warn!("could not read the member list: {e}");
        }
        if let Err(e) = compact::maybe(db, store, now_ms, compact::THRESHOLD).await {
            log::warn!("could not compact the shared library: {e}");
        }
    }
    summary
}

/// Remembers the names of the other members, for Recently deleted.
async fn refresh_devices<S: ChunkStore>(db: &Mutex<Connection>, store: &S) -> Result<(), Error> {
    let mut names = Vec::new();
    for file in store.list_meta(DEVICES_DIR).await? {
        let Some(id) = file.strip_suffix(".json") else {
            continue;
        };
        if let Some(bytes) = store.read_meta(&device_path(id)).await?
            && let Ok(d) = serde_json::from_slice::<DeviceFile>(&bytes)
        {
            names.push((id.to_owned(), d.name));
        }
    }
    let mut conn = lock(db)?;
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM libsync_devices", [])?;
    for (id, name) in names {
        tx.execute(
            "INSERT OR REPLACE INTO libsync_devices (id, name) VALUES (?1, ?2)",
            params![id, name],
        )?;
    }
    tx.commit()?;
    Ok(())
}

// ---- leaving ----------------------------------------------------------------------

/// What happens to the shared items on this device when it leaves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LeaveChoice {
    /// They stay, as local items.
    KeepCopy,
    /// They go; only what was local stays.
    KeepLocal,
}

/// Leaves the library: optionally sends and receives one last time (`sync`; a failure there
/// stops the leaving, so nothing is lost by an unreachable destination), then stops reading and
/// writing `.manplay/` and removes this device from `devices/`.
pub async fn leave<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    choice: LeaveChoice,
    sync: bool,
) -> Result<(), Error> {
    let me = {
        let conn = lock(db)?;
        if !active(&conn)? {
            return Err(Error::Msg("This device is not in a shared library.".into()));
        }
        device_id(&conn)?
    };
    if sync {
        let summary = run_at(db, store, clock::now_ms()).await;
        if let Some(e) = summary.error {
            return Err(Error::Msg(format!("Could not sync before leaving: {e}")));
        }
    }
    {
        let mut conn = lock(db)?;
        let tx = conn.transaction()?;
        leave_local(&tx, choice)?;
        tx.commit()?;
    }
    // Others only see a stale member when this fails; the leaving itself is done.
    let _ = store.delete_meta(&device_path(&me)).await;
    Ok(())
}

/// The local half of leaving: no network. Run it inside a transaction.
///
/// Kept items get new uids, so joining again meets them as clashes (to Combine) instead of being
/// mistaken for the shared ones. The sync state (ops, cursors, clashes) is dropped: it describes
/// a library this device is no longer in. Edits already sent stay in the log for the others.
pub fn leave_local(conn: &Connection, choice: LeaveChoice) -> Result<(), Error> {
    match choice {
        LeaveChoice::KeepCopy => {
            let mut renamed = Vec::new();
            for kind in [TAGS, PLAYLISTS, SMARTS] {
                let rows: Vec<(i64, String)> = conn
                    .prepare(&format!(
                        "SELECT id, COALESCE(uid, '') FROM {} WHERE scope = 'shared'",
                        kind.table
                    ))?
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<Result<_, _>>()?;
                for (id, old) in rows {
                    let fresh = new_uid();
                    conn.execute(
                        &format!(
                            "UPDATE {} SET uid = ?2, scope = 'local' WHERE id = ?1",
                            kind.table
                        ),
                        params![id, fresh],
                    )?;
                    if kind.table == TAGS.table {
                        renamed.push((old, fresh));
                    }
                }
            }
            for (old, fresh) in renamed {
                entities::repoint_rules(conn, &old, &fresh)?;
            }
        }
        LeaveChoice::KeepLocal => {
            conn.execute_batch(
                "DELETE FROM track_tags WHERE tag_id IN (SELECT id FROM tags WHERE scope = 'shared');
                 DELETE FROM playlist_tracks WHERE playlist_id IN
                     (SELECT id FROM playlists WHERE scope = 'shared');
                 DELETE FROM tags WHERE scope = 'shared';
                 DELETE FROM playlists WHERE scope = 'shared';
                 DELETE FROM smart_playlists WHERE scope = 'shared';",
            )?;
        }
    }
    conn.execute_batch(
        "DELETE FROM clashes;
         DELETE FROM oplog;
         DELETE FROM op_state;
         DELETE FROM op_cursor;
         DELETE FROM op_unknown;
         DELETE FROM libsync_devices;
         UPDATE analysis SET wf_pushed = 0;
         UPDATE sync_targets SET libsync = 0;",
    )?;
    for key in [SETTING_LIBRARY_ID, SETTING_LIBRARY_NAME, SETTING_SEEDED] {
        db::set_setting(conn, key, None)?;
    }
    snapshot::forget(conn)?;
    Ok(())
}

/// A destination is going away (removed, or pointed at another folder): if it held this device's
/// library, this device leaves it, keeping a copy, without asking the destination.
pub fn detach_target(conn: &Connection, id: i64) -> Result<(), Error> {
    let joined: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sync_targets WHERE id = ?1 AND libsync = 1)",
        params![id],
        |r| r.get(0),
    )?;
    if joined {
        leave_local(conn, LeaveChoice::KeepCopy)?;
    }
    Ok(())
}
