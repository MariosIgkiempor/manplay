#![allow(clippy::needless_pass_by_value)] // Tauri command args are taken by value

mod art;
mod db;
mod error;
mod fsops;
mod itunes;
mod rekordbox;
mod scan;
mod sync;
mod tailscale;
mod webdav;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

use crate::db::{NewTarget, Playlist, RunView, SyncTarget, Tag, Track};
use crate::error::Error;

struct AppState {
    db: Mutex<Connection>,
    data_dir: PathBuf,
    http: reqwest::Client,
    syncing: AtomicBool,
}

const SETTING_ROOT: &str = "library_root";
/// How long a track must stay missing before its record and remote copies are removed.
const GRACE_SECS: i64 = 7 * 24 * 60 * 60;
const GRACE_DAYS: i64 = 7;
const BACKUPS_KEEP: usize = 5;

/// Scans `root` off the UI thread, stores the results, and remembers `root` as the library folder.
async fn scan_and_store(state: &AppState, root: PathBuf) -> Result<usize, Error> {
    let scan_root = root.clone();
    let result = tauri::async_runtime::spawn_blocking(move || scan::scan(&scan_root))
        .await
        .map_err(|e| Error::Msg(e.to_string()))?;
    let mut conn = state.db.lock().map_err(|_| Error::Lock)?;
    detect_moves(&mut conn, &state.data_dir, &root, &result)?;
    db::upsert(&mut conn, &result.tracks)?;
    db::set_setting(&conn, SETTING_ROOT, root.to_str())?;
    reconcile_missing(&mut conn, &state.data_dir, &root, &result)?;
    drop(conn);
    auto_export(state);
    Ok(result.tracks.len())
}

/// Path relative to the library root, as it appears on sync destinations.
fn rel_path(root: &Path, path: &str) -> Option<Vec<String>> {
    Path::new(path)
        .strip_prefix(root)
        .ok()?
        .iter()
        .map(|s| s.to_str().map(str::to_owned))
        .collect()
}

/// Recognises renamed or moved files: a file at a brand-new path whose fingerprint matches
/// exactly one known track that is no longer at its old path is that track, moved. The track
/// row is updated in place, so tags, playlists and its id survive. Ambiguous matches and
/// copies (the old path still exists) are treated as new tracks.
///
/// Returns the number of moves applied. Safe on untrusted scans: it only acts on a positive
/// fingerprint match, never on absence.
fn detect_moves(
    conn: &mut Connection,
    data_dir: &Path,
    root: &Path,
    scan: &scan::ScanResult,
) -> Result<usize, Error> {
    let known = db::all_known(conn)?;
    let known_paths: HashSet<&str> = known.iter().map(|k| k.path.as_str()).collect();
    let found: HashSet<&str> = scan.tracks.iter().map(|t| t.path.as_str()).collect();

    // fingerprint -> tracks that have vanished from disk
    let mut vanished: HashMap<&str, Vec<&db::Known>> = HashMap::new();
    for k in &known {
        if let Some(fp) = k
            .fingerprint
            .as_deref()
            .filter(|_| !found.contains(k.path.as_str()))
        {
            vanished.entry(fp).or_default().push(k);
        }
    }

    let mut moves: Vec<(&db::Known, &db::NewTrack)> = Vec::new();
    for t in &scan.tracks {
        let Some(fp) = t.fingerprint.as_deref() else {
            continue;
        };
        if known_paths.contains(t.path.as_str()) {
            continue;
        }
        // Take the candidate so a second identical new file cannot claim the same track.
        if let Some(list) = vanished.get_mut(fp).filter(|l| l.len() == 1)
            && let Some(old) = list.pop()
        {
            moves.push((old, t));
        }
    }
    if moves.is_empty() {
        return Ok(0);
    }

    db::backup(conn, &data_dir.join("backups"), unix_now(), BACKUPS_KEEP)?;
    for (old, new) in &moves {
        let old_rel = rel_path(root, &old.path);
        db::apply_move(conn, old.id, new, old_rel.as_deref())?;
    }
    Ok(moves.len())
}

/// Soft-deletes tracks the scan could not find, then purges ones that have been gone
/// past the grace period. The database is backed up before either step changes anything.
fn reconcile_missing(
    conn: &mut Connection,
    data_dir: &Path,
    root: &Path,
    scan: &scan::ScanResult,
) -> Result<(), Error> {
    let now = unix_now();
    let backups = data_dir.join("backups");

    // Only a clean, non-empty scan may declare files missing. A scan with read errors, or an
    // empty one (unmounted drive, revoked permission), says nothing reliable about what is gone.
    if scan.errors == 0 && !scan.tracks.is_empty() {
        let found: HashSet<&str> = scan.tracks.iter().map(|t| t.path.as_str()).collect();
        let gone: Vec<i64> = db::present_tracks(conn)?
            .into_iter()
            .filter(|(_, p)| Path::new(p).starts_with(root) && !found.contains(p.as_str()))
            .map(|(id, _)| id)
            .collect();
        if !gone.is_empty() {
            db::backup(conn, &backups, now, BACKUPS_KEEP)?;
            db::mark_missing(conn, &gone, now)?;
        }
    }

    purge_expired(conn, &backups, now)
}

/// Removes missing tracks past the grace period that have no remote copies left.
fn purge_expired(conn: &Connection, backups: &Path, now: i64) -> Result<(), Error> {
    let cutoff = now - GRACE_SECS;
    if db::purgeable_count(conn, cutoff)? > 0 {
        db::backup(conn, backups, now, BACKUPS_KEEP)?;
        db::purge_expired(conn, cutoff)?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryStatus {
    missing: i64,
    grace_days: i64,
}

#[tauri::command]
fn library_status(state: State<'_, AppState>) -> Result<LibraryStatus, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    Ok(LibraryStatus {
        missing: db::missing_count(&conn)?,
        grace_days: GRACE_DAYS,
    })
}

/// Ends the grace period for all missing tracks. Never-synced ones are purged immediately;
/// the rest go once the next sync has removed their remote copies.
#[tauri::command]
fn remove_missing_now(state: State<'_, AppState>) -> Result<(), Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::backup(
        &conn,
        &state.data_dir.join("backups"),
        unix_now(),
        BACKUPS_KEEP,
    )?;
    db::expire_missing_now(&conn)?;
    purge_expired(&conn, &state.data_dir.join("backups"), unix_now())
}

/// Scans a newly chosen folder and makes it the library folder.
#[tauri::command]
async fn scan_library(state: State<'_, AppState>, root: PathBuf) -> Result<usize, Error> {
    scan_and_store(&state, root).await
}

#[tauri::command]
fn get_library_root(state: State<'_, AppState>) -> Result<Option<String>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::get_setting(&conn, SETTING_ROOT)
}

/// Rescans the remembered library folder. `None` when no folder was ever chosen.
#[tauri::command]
async fn rescan_library(state: State<'_, AppState>) -> Result<Option<usize>, Error> {
    let saved = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::get_setting(&conn, SETTING_ROOT)?
    };
    let Some(root) = saved else {
        return Ok(None);
    };
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err(Error::Msg(format!(
            "library folder not found or not readable: {}",
            root.display()
        )));
    }
    scan_and_store(&state, root).await.map(Some)
}

#[tauri::command]
fn list_tracks(state: State<'_, AppState>) -> Result<Vec<Track>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::list(&conn)
}

macro_rules! with_db {
    ($state:expr, |$conn:ident| $body:expr) => {{
        let mut guard = $state.db.lock().map_err(|_| Error::Lock)?;
        let $conn = &mut *guard;
        $body
    }};
}

#[tauri::command]
fn list_playlists(state: State<'_, AppState>) -> Result<Vec<Playlist>, Error> {
    with_db!(state, |c| db::list_playlists(c))
}

#[tauri::command]
fn create_playlist(state: State<'_, AppState>, name: String) -> Result<i64, Error> {
    let id = with_db!(state, |c| db::create_playlist(c, name.trim()))?;
    auto_export(&state);
    Ok(id)
}

#[tauri::command]
fn rename_playlist(state: State<'_, AppState>, id: i64, name: String) -> Result<(), Error> {
    with_db!(state, |c| db::rename_playlist(c, id, name.trim()))?;
    auto_export(&state);
    Ok(())
}

#[tauri::command]
fn delete_playlist(state: State<'_, AppState>, id: i64) -> Result<(), Error> {
    with_db!(state, |c| db::delete_playlist(c, id))?;
    auto_export(&state);
    Ok(())
}

#[tauri::command]
fn add_to_playlist(
    state: State<'_, AppState>,
    playlist_id: i64,
    track_ids: Vec<i64>,
) -> Result<(), Error> {
    with_db!(state, |c| db::add_to_playlist(c, playlist_id, &track_ids))?;
    auto_export(&state);
    Ok(())
}

#[tauri::command]
fn remove_from_playlist(
    state: State<'_, AppState>,
    playlist_id: i64,
    track_id: i64,
) -> Result<(), Error> {
    with_db!(state, |c| db::remove_from_playlist(
        c,
        playlist_id,
        track_id
    ))?;
    auto_export(&state);
    Ok(())
}

#[tauri::command]
fn playlist_tracks(state: State<'_, AppState>, playlist_id: i64) -> Result<Vec<Track>, Error> {
    with_db!(state, |c| db::playlist_tracks(c, playlist_id))
}

#[tauri::command]
fn list_tags(state: State<'_, AppState>) -> Result<Vec<Tag>, Error> {
    with_db!(state, |c| db::list_tags(c))
}

#[tauri::command]
fn tag_tracks(state: State<'_, AppState>, name: String, track_ids: Vec<i64>) -> Result<(), Error> {
    with_db!(state, |c| db::tag_tracks(c, name.trim(), &track_ids))
}

#[tauri::command]
fn untag_track(state: State<'_, AppState>, name: String, track_id: i64) -> Result<(), Error> {
    with_db!(state, |c| db::untag_track(c, &name, track_id))
}

#[tauri::command]
fn delete_tag(state: State<'_, AppState>, id: i64) -> Result<(), Error> {
    with_db!(state, |c| db::delete_tag(c, id))
}

#[tauri::command]
async fn tailscale_status() -> Result<tailscale::Status, Error> {
    tauri::async_runtime::spawn_blocking(tailscale::status)
        .await
        .map_err(|e| Error::Msg(e.to_string()))?
}

#[tauri::command]
async fn drive_list(
    state: State<'_, AppState>,
    tailnet: String,
    machine: String,
    path: Vec<String>,
) -> Result<Vec<webdav::Entry>, Error> {
    let segments: Vec<String> = [tailnet, machine].into_iter().chain(path).collect();
    webdav::list(&state.http, &segments).await
}

#[tauri::command]
fn list_sync_targets(state: State<'_, AppState>) -> Result<Vec<SyncTarget>, Error> {
    with_db!(state, |c| db::list_targets(c))
}

#[tauri::command]
fn add_sync_target(state: State<'_, AppState>, target: NewTarget) -> Result<i64, Error> {
    with_db!(state, |c| db::add_target(c, &target))
}

#[tauri::command]
fn remove_sync_target(state: State<'_, AppState>, id: i64) -> Result<(), Error> {
    with_db!(state, |c| db::remove_target(c, id))
}

#[tauri::command]
fn sync_history(state: State<'_, AppState>, limit: i64) -> Result<Vec<RunView>, Error> {
    with_db!(state, |c| db::history(c, limit))
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0))
}

fn collect_items(conn: &Connection) -> Result<Vec<sync::Item>, Error> {
    let Some(root) = db::get_setting(conn, SETTING_ROOT)? else {
        return Err(Error::Msg(
            "library folder unknown: click Scan folder in Library once, then sync".to_owned(),
        ));
    };
    let root = Path::new(&root);
    Ok(db::all_files(conn)?
        .into_iter()
        .filter_map(|f| {
            let local = PathBuf::from(f.path);
            // Files deleted since the last scan are skipped rather than reported as failures.
            if !local.exists() {
                return None;
            }
            let rel = local
                .strip_prefix(root)
                .ok()?
                .iter()
                .map(|s| s.to_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?;
            Some(sync::Item {
                track_id: f.id,
                local,
                rel,
            })
        })
        .collect())
}

/// Clears the "sync running" flag even if the sync future is dropped or errors.
struct SyncGuard<'a>(&'a AtomicBool);

impl Drop for SyncGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Syncs one target, or all of them when `target_id` is `None`.
#[tauri::command]
async fn sync_run(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: Option<i64>,
) -> Result<(), Error> {
    let (targets, items, mut victims) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        let targets = db::get_targets(&conn, target_id)?;
        let items = collect_items(&conn)?;
        let victims = collect_victims(&conn, &targets)?;
        (targets, items, victims)
    };
    if targets.is_empty() {
        return Err(Error::Msg("no sync target selected".to_owned()));
    }
    if items.is_empty() {
        return Err(Error::Msg(
            "no tracks under the library folder to sync".to_owned(),
        ));
    }
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a sync is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.syncing);

    for target in &targets {
        let started_at = unix_now();
        let mut outcome = sync::run(&app, &state.http, target, &items).await;
        let cleanup = if outcome.reachable {
            let list = victims.remove(&target.id).unwrap_or_default();
            sync::cleanup(&state.http, target, &list).await
        } else {
            sync::Cleanup::default()
        };
        // Old locations of moved files go only once the new copy is confirmed on the target.
        let confirmed: HashSet<i64> = outcome.present.iter().map(|(id, _)| *id).collect();
        let moved_cleanup = if outcome.reachable {
            let pending = {
                let conn = state.db.lock().map_err(|_| Error::Lock)?;
                db::stale_for(&conn, target.id)?
            };
            let list: Vec<sync::Victim> = pending
                .into_iter()
                .filter(|(id, _)| confirmed.contains(id))
                .map(|(track_id, rel)| sync::Victim { track_id, rel })
                .collect();
            sync::cleanup(&state.http, target, &list).await
        } else {
            sync::Cleanup::default()
        };
        outcome.summary.failed.extend(cleanup.errors);
        outcome.summary.failed.extend(moved_cleanup.errors);
        let removed_ids: Vec<i64> = cleanup.deleted.iter().map(|(id, _)| *id).collect();
        let record = db::RunRecord {
            target_id: target.id,
            started_at,
            finished_at: unix_now(),
            uploaded: outcome.summary.uploaded,
            skipped: outcome.summary.skipped,
            failed: outcome.summary.failed.len(),
            deleted: cleanup.deleted.len() + moved_cleanup.deleted.len(),
            first_error: outcome.summary.failed.first().cloned(),
        };
        let mut conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::record_run(&mut conn, &record, &outcome.present, &removed_ids)?;
        db::clear_stale(&conn, target.id, &moved_cleanup.deleted)?;
    }

    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    purge_expired(&conn, &state.data_dir.join("backups"), unix_now())
}

/// Remote copies of long-missing tracks, per target. Only files this app recorded syncing
/// (and that map under the current library folder) are ever considered.
fn collect_victims(
    conn: &Connection,
    targets: &[db::SyncTarget],
) -> Result<HashMap<i64, Vec<sync::Victim>>, Error> {
    let Some(root) = db::get_setting(conn, SETTING_ROOT)? else {
        return Ok(HashMap::new());
    };
    let root = Path::new(&root);
    let cutoff = unix_now() - GRACE_SECS;
    let mut out = HashMap::new();
    for t in targets {
        let victims = db::expired_synced(conn, t.id, cutoff)?
            .into_iter()
            .filter_map(|(track_id, path)| {
                let rel = Path::new(&path)
                    .strip_prefix(root)
                    .ok()?
                    .iter()
                    .map(|s| s.to_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()?;
                Some(sync::Victim { track_id, rel })
            })
            .collect();
        out.insert(t.id, victims);
    }
    Ok(out)
}

#[tauri::command]
fn is_syncing(state: State<'_, AppState>) -> bool {
    state.syncing.load(Ordering::SeqCst)
}

// ---- file browser ------------------------------------------------------------

fn library_root(state: &AppState) -> Result<PathBuf, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::get_setting(&conn, SETTING_ROOT)?
        .map(PathBuf::from)
        .ok_or_else(|| Error::Msg("choose a library folder in Library first".to_owned()))
}

#[tauri::command]
async fn fs_list(state: State<'_, AppState>, path: PathBuf) -> Result<Vec<fsops::FsEntry>, Error> {
    let root = library_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || fsops::list(&root, &path))
        .await
        .map_err(|e| Error::Msg(e.to_string()))?
}

/// Rescans so the database follows a change on disk: renamed and moved files keep their
/// tags and playlists (see `detect_moves`). The change itself already succeeded, so a failed
/// rescan is only logged.
async fn refresh_after_fs_change(state: &AppState, root: PathBuf) {
    if let Err(e) = scan_and_store(state, root).await {
        log::warn!("rescan after file change failed: {e}");
    }
}

#[tauri::command]
async fn fs_make_dir(
    state: State<'_, AppState>,
    parent: PathBuf,
    name: String,
) -> Result<(), Error> {
    let root = library_root(&state)?;
    fsops::make_dir(&root, &parent, &name)?;
    Ok(())
}

#[tauri::command]
async fn fs_rename(
    state: State<'_, AppState>,
    path: PathBuf,
    new_name: String,
) -> Result<(), Error> {
    let root = library_root(&state)?;
    fsops::rename(&root, &path, &new_name)?;
    refresh_after_fs_change(&state, root).await;
    Ok(())
}

#[tauri::command]
async fn fs_copy(
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
    dest: PathBuf,
) -> Result<(), Error> {
    let root = library_root(&state)?;
    fsops::copy_into(&root, &paths, &dest)?;
    refresh_after_fs_change(&state, root).await;
    Ok(())
}

/// Moves to the system Trash. Tracks that vanish are soft-deleted by the rescan, as usual.
#[tauri::command]
async fn fs_trash(state: State<'_, AppState>, paths: Vec<PathBuf>) -> Result<(), Error> {
    let root = library_root(&state)?;
    let r = root.clone();
    tauri::async_runtime::spawn_blocking(move || fsops::trash(&r, &paths))
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;
    refresh_after_fs_change(&state, root).await;
    Ok(())
}

#[tauri::command]
async fn fs_move(
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
    dest: PathBuf,
) -> Result<(), Error> {
    let root = library_root(&state)?;
    fsops::move_into(&root, &paths, &dest)?;
    refresh_after_fs_change(&state, root).await;
    Ok(())
}

// ---- rekordbox ---------------------------------------------------------------

const SETTING_RB_PATH: &str = "rekordbox_xml_path";
const SETTING_RB_LAST: &str = "rekordbox_last_export";

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct RekordboxLast {
    exported_at: Option<i64>,
    playlists: usize,
    tracks: usize,
    error: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RekordboxStatus {
    path: Option<String>,
    #[serde(flatten)]
    last: RekordboxLast,
}

fn rekordbox_status_of(conn: &Connection) -> Result<RekordboxStatus, Error> {
    let last = db::get_setting(conn, SETTING_RB_LAST)?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    Ok(RekordboxStatus {
        path: db::get_setting(conn, SETTING_RB_PATH)?,
        last,
    })
}

fn store_last(conn: &Connection, last: &RekordboxLast) -> Result<(), Error> {
    let raw = serde_json::to_string(last).map_err(|e| Error::Msg(e.to_string()))?;
    db::set_setting(conn, SETTING_RB_LAST, Some(&raw))
}

/// Writes the rekordbox XML to the configured file. `Ok(false)` when no file is configured.
/// The file is written atomically so rekordbox never reads a half-written library.
fn run_export(state: &AppState) -> Result<bool, Error> {
    let (path, tracks, playlists) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        let Some(path) = db::get_setting(&conn, SETTING_RB_PATH)? else {
            return Ok(false);
        };
        let (tracks, playlists) = db::export_data(&conn)?;
        (PathBuf::from(path), tracks, playlists)
    };
    let xml = rekordbox::build_xml(&tracks, &playlists);
    let tmp = path.with_extension("xml.tmp");
    let written = std::fs::write(&tmp, xml).and_then(|()| std::fs::rename(&tmp, &path));

    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    let mut last: RekordboxLast = rekordbox_status_of(&conn)?.last;
    match written {
        Ok(()) => {
            last = RekordboxLast {
                exported_at: Some(unix_now()),
                playlists: playlists.len(),
                tracks: tracks.len(),
                error: None,
            };
            store_last(&conn, &last)?;
            Ok(true)
        }
        Err(e) => {
            last.error = Some(format!("could not write {}: {e}", path.display()));
            store_last(&conn, &last)?;
            Err(Error::Io(e))
        }
    }
}

/// Keeps the exported file current after playlist or library changes. Failures are recorded
/// in the export status (shown on the Rekordbox page) rather than failing the user's action.
fn auto_export(state: &AppState) {
    let _ = run_export(state);
}

#[tauri::command]
fn rekordbox_status(state: State<'_, AppState>) -> Result<RekordboxStatus, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    rekordbox_status_of(&conn)
}

/// Chooses (or clears, with `None`) the XML file, and writes it right away.
#[tauri::command]
fn rekordbox_set_path(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<RekordboxStatus, Error> {
    {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::set_setting(&conn, SETTING_RB_PATH, path.as_deref())?;
        if path.is_none() {
            db::set_setting(&conn, SETTING_RB_LAST, None)?;
        }
    }
    run_export(&state)?;
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    rekordbox_status_of(&conn)
}

#[tauri::command]
fn rekordbox_export(state: State<'_, AppState>) -> Result<RekordboxStatus, Error> {
    if !run_export(&state)? {
        return Err(Error::Msg(
            "choose where to save the rekordbox file first".to_owned(),
        ));
    }
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    rekordbox_status_of(&conn)
}

// ---- iTunes import -----------------------------------------------------------

const SETTING_ITUNES_PATH: &str = "itunes_path";
const SETTING_ITUNES_LAST: &str = "itunes_last_import";
const ITUNES_KEEP: usize = 50;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ItunesStatus {
    path: Option<String>,
    last: Option<itunes::ImportReport>,
}

fn itunes_status_of(conn: &Connection) -> Result<ItunesStatus, Error> {
    Ok(ItunesStatus {
        path: db::get_setting(conn, SETTING_ITUNES_PATH)?,
        last: db::get_setting(conn, SETTING_ITUNES_LAST)?
            .and_then(|raw| serde_json::from_str(&raw).ok()),
    })
}

#[tauri::command]
fn itunes_status(state: State<'_, AppState>) -> Result<ItunesStatus, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    itunes_status_of(&conn)
}

/// Chooses (or clears, with `None`) the iTunes folder to import from.
#[tauri::command]
fn itunes_set_path(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<ItunesStatus, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::set_setting(&conn, SETTING_ITUNES_PATH, path.as_deref())?;
    if path.is_none() {
        db::set_setting(&conn, SETTING_ITUNES_LAST, None)?;
    }
    itunes_status_of(&conn)
}

/// Converts new iTunes songs into the library, then rescans so they show up.
/// `Ok(None)` when no iTunes folder or library folder is configured.
#[tauri::command]
async fn itunes_import(state: State<'_, AppState>) -> Result<Option<ItunesStatus>, Error> {
    let (source, library, known) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        let source = db::get_setting(&conn, SETTING_ITUNES_PATH)?;
        let library = db::get_setting(&conn, SETTING_ROOT)?;
        let (Some(source), Some(library)) = (source, library) else {
            return Ok(None);
        };
        (
            PathBuf::from(source),
            PathBuf::from(library),
            itunes::Known::load(&conn)?,
        )
    };
    let now = unix_now();
    let lib = library.clone();
    let (mut report, imported) = tauri::async_runtime::spawn_blocking(move || {
        let mut imported = Vec::new();
        let report = itunes::import(&source, &lib, known, now, |c, dest| {
            imported.push((c.clone(), dest.to_path_buf()));
            Ok(())
        });
        (report, imported)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?;

    {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        for (c, dest) in &imported {
            itunes::record_imported(&conn, c, dest, now)?;
        }
    }
    if !report.converted.is_empty() {
        scan_and_store(&state, library).await?;
    }
    report.converted.truncate(ITUNES_KEEP);
    report.failed.truncate(ITUNES_KEEP);
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    let raw = serde_json::to_string(&report).map_err(|e| Error::Msg(e.to_string()))?;
    db::set_setting(&conn, SETTING_ITUNES_LAST, Some(&raw))?;
    itunes_status_of(&conn).map(Some)
}

/// What an `art://` request asks for: a track id, or a path in the library (file browser).
enum ArtTarget {
    None,
    Track(i64),
    Path(PathBuf),
}

impl ArtTarget {
    fn parse(uri_path: &str) -> Self {
        let raw = uri_path.strip_prefix('/').unwrap_or(uri_path);
        if let Ok(id) = raw.parse::<i64>() {
            return Self::Track(id);
        }
        percent_encoding::percent_decode_str(raw)
            .decode_utf8()
            .map_or(Self::None, |p| Self::Path(PathBuf::from(p.as_ref())))
    }
}

/// The audio file whose artwork represents `path` (itself, or the first track inside a folder).
/// Only paths inside the library folder qualify.
fn fs_art_source(state: &AppState, path: &Path) -> Option<String> {
    let root = library_root(state).ok()?;
    let resolved = fsops::inside(&root, path).ok()?;
    let track = if resolved.is_dir() {
        fsops::first_audio(&resolved)?
    } else if scan::is_audio(&resolved) {
        resolved
    } else {
        return None;
    };
    track.to_str().map(str::to_owned)
}

fn art_response(app: &AppHandle, target: ArtTarget) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap_or_default()
    };
    let state = app.state::<AppState>();
    let path = match target {
        ArtTarget::None => None,
        ArtTarget::Track(id) => state
            .db
            .lock()
            .ok()
            .and_then(|c| db::track_path(&c, id).ok().flatten()),
        ArtTarget::Path(p) => fs_art_source(&state, &p),
    };
    let cache = app.path().app_cache_dir().map(|d| d.join("art"));
    let bytes = path
        .zip(cache.ok())
        .and_then(|(p, dir)| art::thumbnail(Path::new(&p), &dir));
    bytes.map_or_else(not_found, |b| {
        tauri::http::Response::builder()
            .header("Content-Type", "image/jpeg")
            .header("Cache-Control", "max-age=31536000")
            .body(b)
            .unwrap_or_default()
    })
}

/// # Panics
/// Panics if the Tauri application fails to start.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(clippy::expect_used)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("art", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let target = ArtTarget::parse(request.uri().path());
            std::thread::spawn(move || responder.respond(art_response(&app, target)));
        })
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::open(&dir.join("library.db"))?;
            let http = reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(5))
                .build()
                .map_err(|e| Error::Msg(e.to_string()))?;
            app.manage(AppState {
                db: Mutex::new(conn),
                data_dir: dir.clone(),
                http,
                syncing: AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_library,
            get_library_root,
            library_status,
            remove_missing_now,
            rescan_library,
            list_tracks,
            list_playlists,
            create_playlist,
            rename_playlist,
            delete_playlist,
            add_to_playlist,
            remove_from_playlist,
            playlist_tracks,
            list_tags,
            tag_tracks,
            untag_track,
            delete_tag,
            tailscale_status,
            drive_list,
            list_sync_targets,
            add_sync_target,
            remove_sync_target,
            sync_history,
            sync_run,
            is_syncing,
            rekordbox_status,
            rekordbox_set_path,
            rekordbox_export,
            itunes_status,
            itunes_set_path,
            itunes_import,
            fs_list,
            fs_make_dir,
            fs_rename,
            fs_move,
            fs_copy,
            fs_trash
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unused_self)] // test fixtures: panicking is the failure mode
mod tests {
    use super::*;
    use crate::db::NewTrack;
    use crate::scan::ScanResult;

    struct Fixture {
        dir: PathBuf,
        conn: Connection,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("manplay-test-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap_or_default();
            let conn = db::open(&dir.join("library.db")).expect("open db");
            Self { dir, conn }
        }

        fn root(&self) -> PathBuf {
            PathBuf::from("/music")
        }

        fn scan_of(&self, names: &[&str], errors: usize) -> ScanResult {
            ScanResult {
                tracks: names
                    .iter()
                    .map(|n| NewTrack {
                        path: format!("/music/{n}"),
                        artist: "a".into(),
                        album: "b".into(),
                        title: (*n).into(),
                        size: 1,
                        fingerprint: Some(format!("fp-{}", n.rsplit('/').next().unwrap_or(n))),
                        ..NewTrack::default()
                    })
                    .collect(),
                errors,
            }
        }

        fn apply(&mut self, scan: &ScanResult) {
            let root = self.root();
            detect_moves(&mut self.conn, &self.dir, &root, scan).expect("moves");
            db::upsert(&mut self.conn, &scan.tracks).expect("upsert");
            reconcile_missing(&mut self.conn, &self.dir, &root, scan).expect("reconcile");
        }

        fn visible(&self) -> usize {
            db::list(&self.conn).expect("list").len()
        }

        fn backups(&self) -> usize {
            std::fs::read_dir(self.dir.join("backups")).map_or(0, Iterator::count)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn clean_scan_soft_deletes_missing_tracks_after_backing_up() {
        let mut f = Fixture::new("softdelete");
        f.apply(&f.scan_of(&["1", "2", "3"], 0));
        assert_eq!(f.visible(), 3);
        assert_eq!(f.backups(), 0);

        f.apply(&f.scan_of(&["1", "2"], 0));
        assert_eq!(f.visible(), 2);
        assert_eq!(db::missing_count(&f.conn).expect("count"), 1);
        assert_eq!(f.backups(), 1);
    }

    #[test]
    fn scan_with_errors_marks_nothing() {
        let mut f = Fixture::new("errors");
        f.apply(&f.scan_of(&["1", "2", "3"], 0));
        f.apply(&f.scan_of(&["1"], 2));
        assert_eq!(f.visible(), 3);
        assert_eq!(f.backups(), 0);
    }

    #[test]
    fn empty_scan_marks_nothing() {
        let mut f = Fixture::new("empty");
        f.apply(&f.scan_of(&["1", "2"], 0));
        f.apply(&f.scan_of(&[], 0));
        assert_eq!(f.visible(), 2);
    }

    #[test]
    fn tracks_outside_the_scanned_root_are_left_alone() {
        let mut f = Fixture::new("outside");
        let other = ScanResult {
            tracks: vec![NewTrack {
                path: "/elsewhere/x".into(),
                artist: "a".into(),
                album: "b".into(),
                title: "x".into(),
                size: 1,
                fingerprint: Some("fp-x".into()),
                ..NewTrack::default()
            }],
            errors: 0,
        };
        db::upsert(&mut f.conn, &other.tracks).expect("upsert");
        f.apply(&f.scan_of(&["1"], 0));
        assert_eq!(f.visible(), 2);
    }

    #[test]
    fn reappearing_file_comes_back_with_its_tags_and_playlists() {
        let mut f = Fixture::new("reappear");
        f.apply(&f.scan_of(&["1", "2"], 0));
        let id = db::list(&f.conn).expect("list")[0].id;
        db::tag_tracks(&mut f.conn, "keep", &[id]).expect("tag");
        let pl = db::create_playlist(&f.conn, "p").expect("playlist");
        db::add_to_playlist(&mut f.conn, pl, &[id]).expect("add");

        f.apply(&f.scan_of(&["2"], 0)); // track 1 disappears
        assert_eq!(db::playlist_tracks(&f.conn, pl).expect("pl").len(), 0);

        f.apply(&f.scan_of(&["1", "2"], 0)); // and comes back
        let back = db::playlist_tracks(&f.conn, pl).expect("pl");
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].tags, vec!["keep".to_owned()]);
    }

    #[test]
    fn purge_waits_for_grace_period_and_remote_copies() {
        let mut f = Fixture::new("purge");
        f.apply(&f.scan_of(&["1", "2"], 0));
        let ids: Vec<i64> = db::list(&f.conn)
            .expect("list")
            .iter()
            .map(|t| t.id)
            .collect();
        let target = db::add_target(
            &f.conn,
            &db::NewTarget {
                tailnet: "t".into(),
                machine: "m".into(),
                path: vec!["s".into()],
            },
        )
        .expect("target");
        let record = db::RunRecord {
            target_id: target,
            started_at: 1,
            finished_at: 1,
            uploaded: 2,
            skipped: 0,
            failed: 0,
            deleted: 0,
            first_error: None,
        };
        db::record_run(&mut f.conn, &record, &[(ids[0], 1), (ids[1], 1)], &[]).expect("run");

        f.apply(&f.scan_of(&["2"], 0)); // track 1 now missing, marked just now
        assert_eq!(db::missing_count(&f.conn).expect("count"), 1);

        // Inside the grace period nothing is purged.
        purge_expired(&f.conn, &f.dir.join("backups"), unix_now()).expect("purge");
        assert_eq!(db::missing_count(&f.conn).expect("count"), 1);

        // Past the grace period it is still kept while a remote copy is recorded.
        let later = unix_now() + GRACE_SECS + 10;
        purge_expired(&f.conn, &f.dir.join("backups"), later).expect("purge");
        assert_eq!(db::missing_count(&f.conn).expect("count"), 1);
        let victims = db::expired_synced(&f.conn, target, later - GRACE_SECS).expect("victims");
        assert_eq!(victims.len(), 1);

        // Once the remote copy is deleted, the track record can go.
        db::record_run(&mut f.conn, &record, &[], &[victims[0].0]).expect("run");
        purge_expired(&f.conn, &f.dir.join("backups"), later).expect("purge");
        assert_eq!(db::missing_count(&f.conn).expect("count"), 0);
    }

    fn ids_by_title(f: &Fixture) -> HashMap<String, i64> {
        db::list(&f.conn)
            .expect("list")
            .into_iter()
            .map(|t| (t.title, t.id))
            .collect()
    }

    #[test]
    fn rename_keeps_identity_tags_and_playlists() {
        let mut f = Fixture::new("rename");
        f.apply(&f.scan_of(&["1", "2"], 0));
        let id = ids_by_title(&f)["1"];
        db::tag_tracks(&mut f.conn, "keep", &[id]).expect("tag");
        let pl = db::create_playlist(&f.conn, "p").expect("playlist");
        db::add_to_playlist(&mut f.conn, pl, &[id]).expect("add");

        f.apply(&f.scan_of(&["new/1", "2"], 0)); // "1" moved to new/1

        assert_eq!(f.visible(), 2);
        assert_eq!(db::missing_count(&f.conn).expect("count"), 0);
        let moved = db::playlist_tracks(&f.conn, pl).expect("pl");
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].id, id);
        assert_eq!(moved[0].path, "/music/new/1");
        assert_eq!(moved[0].tags, vec!["keep".to_owned()]);
        assert!(f.backups() >= 1);
    }

    #[test]
    fn a_copy_is_a_new_track_not_a_move() {
        let mut f = Fixture::new("copy");
        f.apply(&f.scan_of(&["1"], 0));
        f.apply(&f.scan_of(&["1", "copy/1"], 0));
        assert_eq!(f.visible(), 2);
        assert_eq!(db::missing_count(&f.conn).expect("count"), 0);
    }

    #[test]
    fn ambiguous_matches_are_not_guessed() {
        let mut f = Fixture::new("ambiguous");
        f.apply(&f.scan_of(&["x/1", "y/1", "keep"], 0));
        f.apply(&f.scan_of(&["z/1", "keep"], 0)); // both x/1 and y/1 vanish, z/1 appears
        let titles = ids_by_title(&f);
        assert!(titles.contains_key("z/1"));
        assert_eq!(db::missing_count(&f.conn).expect("count"), 2);
    }

    #[test]
    fn missing_track_that_reappears_elsewhere_is_recognised() {
        let mut f = Fixture::new("late-move");
        f.apply(&f.scan_of(&["1", "2"], 0));
        let id = ids_by_title(&f)["1"];
        f.apply(&f.scan_of(&["2"], 0)); // "1" goes missing
        assert_eq!(db::missing_count(&f.conn).expect("count"), 1);
        f.apply(&f.scan_of(&["moved/1", "2"], 0)); // and shows up at a new path
        assert_eq!(db::missing_count(&f.conn).expect("count"), 0);
        assert_eq!(ids_by_title(&f)["moved/1"], id);
    }

    #[test]
    fn move_queues_the_old_remote_copy_and_resets_sync_state() {
        let mut f = Fixture::new("stale");
        f.apply(&f.scan_of(&["1", "2"], 0));
        let id = ids_by_title(&f)["1"];
        let target = db::add_target(
            &f.conn,
            &db::NewTarget {
                tailnet: "t".into(),
                machine: "m".into(),
                path: vec!["s".into()],
            },
        )
        .expect("target");
        let record = db::RunRecord {
            target_id: target,
            started_at: 1,
            finished_at: 1,
            uploaded: 1,
            skipped: 0,
            failed: 0,
            deleted: 0,
            first_error: None,
        };
        db::record_run(&mut f.conn, &record, &[(id, 1)], &[]).expect("run");
        assert_eq!(db::list(&f.conn).expect("list")[0].synced_count, 1);

        f.apply(&f.scan_of(&["new/1", "2"], 0));

        let moved = db::list(&f.conn)
            .expect("list")
            .into_iter()
            .find(|t| t.id == id)
            .expect("track");
        assert_eq!(moved.synced_count, 0, "must be re-synced at the new path");
        let stale = db::stale_for(&f.conn, target).expect("stale");
        assert_eq!(stale, vec![(id, vec!["1".to_owned()])]);

        db::clear_stale(&f.conn, target, &stale).expect("clear");
        assert_eq!(db::stale_for(&f.conn, target).expect("stale"), vec![]);
    }

    #[test]
    fn export_writes_the_xml_file_with_playlists_and_updates_status() {
        let mut f = Fixture::new("rekordbox");
        f.apply(&f.scan_of(&["1", "2", "3"], 0));
        let ids: Vec<i64> = db::list(&f.conn)
            .expect("list")
            .iter()
            .map(|t| t.id)
            .collect();
        let pl = db::create_playlist(&f.conn, "Friday").expect("playlist");
        db::add_to_playlist(&mut f.conn, pl, &[ids[2], ids[0]]).expect("add");

        let out = f.dir.join("out").join("rekordbox.xml");
        std::fs::create_dir_all(out.parent().expect("parent")).expect("mkdir");
        db::set_setting(&f.conn, SETTING_RB_PATH, out.to_str()).expect("setting");

        let dir = f.dir.clone();
        let conn = std::mem::replace(&mut f.conn, Connection::open_in_memory().expect("mem"));
        let state = AppState {
            db: Mutex::new(conn),
            data_dir: dir,
            http: reqwest::Client::new(),
            syncing: AtomicBool::new(false),
        };
        assert!(run_export(&state).expect("export"));

        let xml = std::fs::read_to_string(&out).expect("file written");
        let doc = roxmltree::Document::parse(&xml).expect("well-formed");
        assert_eq!(
            doc.descendants()
                .filter(|n| n.has_tag_name("TRACK") && n.has_attribute("Location"))
                .count(),
            3
        );
        let node = doc
            .descendants()
            .find(|n| n.has_tag_name("NODE") && n.attribute("Name") == Some("Friday"))
            .expect("playlist node");
        assert_eq!(node.attribute("Entries"), Some("2"));
        assert!(
            !out.with_extension("xml.tmp").exists(),
            "temp file is renamed away"
        );

        let conn = state.db.lock().expect("lock");
        let status = rekordbox_status_of(&conn).expect("status");
        assert_eq!(status.last.playlists, 1);
        assert_eq!(status.last.tracks, 3);
        assert!(status.last.error.is_none());
    }

    #[test]
    fn export_is_a_no_op_until_a_file_is_chosen() {
        let mut f = Fixture::new("rekordbox-off");
        f.apply(&f.scan_of(&["1"], 0));
        let dir = f.dir.clone();
        let conn = std::mem::replace(&mut f.conn, Connection::open_in_memory().expect("mem"));
        let state = AppState {
            db: Mutex::new(conn),
            data_dir: dir,
            http: reqwest::Client::new(),
            syncing: AtomicBool::new(false),
        };
        assert!(!run_export(&state).expect("no-op"));
    }
}
