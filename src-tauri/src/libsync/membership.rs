//! Being in a shared library: reading what a destination (or the library folder) holds, joining
//! it, leaving it.
//!
//! A place with shared data has `.manplay/library.json` (which library it is) and one
//! `.manplay/devices/<device id>.json` per member. A device belongs to at most one library, its
//! [`Home`]: the destination whose `sync_targets.libsync` is on, or the library folder itself
//! (`settings.library_in_folder`). Every other destination is files only and `.manplay/` there is
//! never written. See `docs/plans/shared-library/05-join-and-leave.md`.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use super::apply::{PLAYLISTS, SMARTS, TAGS};
use super::entities;
use super::remote::{ChunkStore, RunSummary, run_at};
use super::write::{active, device_id, new_uid};
use super::{clock, compact, remap, skew, snapshot};
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
/// `"1"` while the library folder itself holds this device's shared library.
pub(crate) const SETTING_IN_FOLDER: &str = "library_in_folder";

/// Version of `library.json`.
pub const LIBRARY_FORMAT: u32 = 2;

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
    /// The version of the audio fingerprint algorithm every song here is named with. A device
    /// that knows only an older one cannot sync (see `remap.rs`).
    pub audio_fp_version: i64,
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
    /// Devices whose edits this one is holding back because their clock is far ahead.
    pub skewed: Vec<String>,
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

/// Refuses a library written by a newer format than this build understands.
fn check_format(file: &LibraryFile) -> Result<(), Error> {
    if file.format > LIBRARY_FORMAT {
        return Err(Error::Msg(format!(
            "The shared library “{}” was set up by a newer version of manplay. Update manplay to use it.",
            file.name
        )));
    }
    Ok(())
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

/// Where this device's shared library is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Home {
    /// On a destination, by its id.
    Target(i64),
    /// In the library folder (`<library folder>/.manplay/`), for a folder other computers reach.
    Folder,
}

/// The library this device is in, if any.
pub fn home(conn: &Connection) -> Result<Option<Home>, Error> {
    let target: Option<i64> = conn
        .query_row(
            "SELECT id FROM sync_targets WHERE libsync = 1 ORDER BY id LIMIT 1",
            [],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            e => Err(e),
        })?;
    if let Some(id) = target {
        return Ok(Some(Home::Target(id)));
    }
    Ok((db::get_setting(conn, SETTING_IN_FOLDER)?.as_deref() == Some("1")).then_some(Home::Folder))
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
    }
    Ok(())
}

/// Joins the library at `home` (or starts one there with `Start`, called `new_name`), then does
/// the first sync. Refused while this device is in another library. Problems after the join
/// itself (the first sync) are in the returned summary: the device is in the library and the
/// next sync repeats them.
pub async fn join<S: ChunkStore>(
    db: &Mutex<Connection>,
    home: Home,
    store: &S,
    choice: JoinChoice,
    new_name: &str,
) -> Result<RunSummary, Error> {
    {
        let conn = lock(db)?;
        if let Home::Target(target_id) = home {
            let exists: bool = conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM sync_targets WHERE id = ?1)",
                params![target_id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(Error::Msg("That destination no longer exists.".into()));
            }
        }
        if let Some(other) = self::home(&conn)? {
            return Err(Error::Msg(match (other == home, home) {
                (true, Home::Target(_)) => {
                    "This device is already in the library of this destination.".into()
                }
                (true, Home::Folder) => {
                    "This device is already in the library of the library folder.".into()
                }
                (false, _) => "This device is in another shared library. Leave it first.".into(),
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
                audio_fp_version: fp_version_of(db)?,
            };
            write_library(store, &file).await?;
            // Another device may have started one at the same moment; the last write stands, and
            // everyone goes by what is there now.
            read_library(store).await?.unwrap_or(file)
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
    check_format(&file)?;
    {
        let mut conn = lock(db)?;
        let tx = conn.transaction()?;
        prepare_join(&tx, choice)?;
        db::set_setting(&tx, SETTING_LIBRARY_ID, Some(&file.library_id))?;
        db::set_setting(&tx, SETTING_LIBRARY_NAME, Some(&file.name))?;
        tx.commit()?;
        if let Err(e) = settle_home(&mut conn, home) {
            db::set_setting(&conn, SETTING_LIBRARY_ID, None)?;
            db::set_setting(&conn, SETTING_LIBRARY_NAME, None)?;
            return Err(e);
        }
    }
    Ok(run_joined(db, store, &file.name).await)
}

/// The join's last step: marks where the library is kept, and sends what this device already
/// has (`seed`).
fn settle_home(conn: &mut Connection, home: Home) -> Result<(), Error> {
    match home {
        Home::Target(id) => db::set_target_libsync(conn, id, true),
        Home::Folder => {
            db::set_setting(conn, SETTING_IN_FOLDER, Some("1"))?;
            if let Err(e) = super::seed::seed(conn) {
                db::set_setting(conn, SETTING_IN_FOLDER, None)?;
                return Err(e);
            }
            Ok(())
        }
    }
}

/// Before each sync of a joined device: makes sure the destination still holds this device's
/// library (and that this build can read it), and says that this device is a member
/// (`devices/<id>.json`). Returns the devices that member file says are being held back.
///
/// A device that had library data on before libraries existed carries over as joined: it adopts
/// the `library.json` it finds, or writes one named `fallback_name`.
async fn ensure<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    fallback_name: &str,
    build_fp_version: i64,
) -> Result<Vec<String>, Error> {
    let (known, local_fp) = {
        let conn = lock(db)?;
        (
            db::get_setting(&conn, SETTING_LIBRARY_ID)?,
            remap::local_version(&conn)?,
        )
    };
    let found = read_library(store).await?;
    let mut file = match (known.as_deref(), found) {
        (Some(mine), Some(file)) if file.library_id != mine => {
            return Err(Error::Msg(format!(
                "This destination now holds another shared library (“{}”). Leave this one and join it again.",
                file.name
            )));
        }
        (_, Some(file)) => file,
        (known, None) => {
            let library = {
                let conn = lock(db)?;
                library_name(&conn)?.unwrap_or_else(|| fallback_name.to_owned())
            };
            let file = LibraryFile {
                format: LIBRARY_FORMAT,
                library_id: known.map_or_else(new_uid, str::to_owned),
                name: library,
                created_at: now(),
                audio_fp_version: local_fp,
            };
            write_library(store, &file).await?;
            // Another device may be writing one at the same moment: the last write stands.
            read_library(store).await?.unwrap_or(file)
        }
    };
    check_format(&file)?;
    if file.audio_fp_version > build_fp_version {
        return Err(Error::Msg(
            "This shared library names songs in a newer way than this version of manplay knows. Update manplay to keep syncing."
                .into(),
        ));
    }
    if file.audio_fp_version > local_fp {
        return Err(Error::Msg(
            "This shared library names songs in a newer way. Scan the library once so this device does too, then sync again."
                .into(),
        ));
    }
    if known.as_deref() != Some(file.library_id.as_str()) {
        let conn = lock(db)?;
        remember(&conn, &file)?;
    }
    if file.audio_fp_version < local_fp {
        // The first device on the new fingerprint: everyone else waits for it.
        file.audio_fp_version = local_fp;
        write_library(store, &file).await?;
    }
    write_device(db, store).await
}

/// Writes this device's member file; returns the devices it lists as held back.
async fn write_device<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
) -> Result<Vec<String>, Error> {
    let (id, name, skewed) = {
        let conn = lock(db)?;
        (
            device_id(&conn)?,
            device_name(&conn)?,
            skew::skewed_devices(&conn)?.into_iter().collect::<Vec<_>>(),
        )
    };
    let device = DeviceFile {
        name,
        last_seen: now(),
        analysis_version: crate::analysis::VERSION,
        skewed: skewed.clone(),
    };
    store
        .write_meta(&device_path(&id), to_json(&device)?)
        .await?;
    Ok(skewed)
}

fn fp_version_of(db: &Mutex<Connection>) -> Result<i64, Error> {
    let conn = lock(db)?;
    remap::local_version(&conn)
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
    run_joined_as(
        db,
        store,
        fallback_name,
        now_ms,
        i64::from(crate::audioprint::VERSION),
    )
    .await
}

/// [`run_joined_at`] for a build whose fingerprint algorithm is `build_fp_version` (a test can
/// pretend to be a newer or older build).
pub async fn run_joined_as<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    fallback_name: &str,
    now_ms: i64,
    build_fp_version: i64,
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
    let written = match ensure(db, store, fallback_name, build_fp_version).await {
        Ok(written) => written,
        Err(e) => {
            return RunSummary {
                error: Some(e.to_string()),
                ..RunSummary::default()
            };
        }
    };
    let mut summary = run_at(db, store, now_ms).await;
    if summary.error.is_none() {
        // None of this is needed for the sync itself: a failure here is tried again next time.
        let skewed = lock(db)
            .and_then(|c| skew::skewed_devices(&c))
            .map(|s| s.into_iter().collect::<Vec<_>>());
        if (summary.new_device_id || skewed.as_ref().is_ok_and(|s| *s != written))
            && let Err(e) = write_device(db, store).await
        {
            log::warn!("could not update this device's member file: {e}");
        }
        if let Err(e) = refresh_devices(db, store).await {
            log::warn!("could not read the member list: {e}");
        }
        if let Err(e) = compact::maybe(db, store, now_ms, compact::THRESHOLD).await {
            log::warn!("could not compact the shared library: {e}");
        }
        summary.clock_wrong = lock(db)
            .and_then(|c| skew::clock_wrong(&c))
            .unwrap_or(false);
    }
    summary
}

/// Remembers the names of the other members, for Recently deleted, and whether any of them says
/// this device's clock is wrong.
async fn refresh_devices<S: ChunkStore>(db: &Mutex<Connection>, store: &S) -> Result<(), Error> {
    let me = {
        let conn = lock(db)?;
        device_id(&conn)?
    };
    let mut names = Vec::new();
    let mut wrong = false;
    for file in store.list_meta(DEVICES_DIR).await? {
        let Some(id) = file.strip_suffix(".json") else {
            continue;
        };
        if let Some(bytes) = store.read_meta(&device_path(id)).await?
            && let Ok(d) = serde_json::from_slice::<DeviceFile>(&bytes)
        {
            if id != me && d.skewed.contains(&me) {
                wrong = true;
            }
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
    skew::set_clock_wrong(&tx, wrong)?;
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
                        "SELECT id, uid FROM {} WHERE scope = 'shared'",
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
    for key in [SETTING_LIBRARY_ID, SETTING_LIBRARY_NAME, SETTING_IN_FOLDER] {
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

/// The library folder is changing: if it held this device's library, this device leaves it,
/// keeping a copy, without asking the old folder.
pub fn detach_folder(conn: &Connection) -> Result<(), Error> {
    if home(conn)? == Some(Home::Folder) {
        leave_local(conn, LeaveChoice::KeepCopy)?;
    }
    Ok(())
}
