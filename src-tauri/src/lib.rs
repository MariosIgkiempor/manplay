#![allow(clippy::needless_pass_by_value)] // Tauri command args are taken by value

mod art;
mod db;
mod error;
mod scan;
mod sync;
mod tailscale;
mod webdav;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

use crate::db::{NewTarget, Playlist, RunView, SyncTarget, Tag, Track};
use crate::error::Error;

struct AppState {
    db: Mutex<Connection>,
    http: reqwest::Client,
    syncing: AtomicBool,
}

const SETTING_ROOT: &str = "library_root";

#[tauri::command]
fn scan_library(state: State<'_, AppState>, root: PathBuf) -> Result<usize, Error> {
    let tracks = scan::scan(&root);
    let mut conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::upsert(&mut conn, &tracks)?;
    db::set_setting(&conn, SETTING_ROOT, root.to_str())?;
    Ok(tracks.len())
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
    with_db!(state, |c| db::create_playlist(c, name.trim()))
}

#[tauri::command]
fn rename_playlist(state: State<'_, AppState>, id: i64, name: String) -> Result<(), Error> {
    with_db!(state, |c| db::rename_playlist(c, id, name.trim()))
}

#[tauri::command]
fn delete_playlist(state: State<'_, AppState>, id: i64) -> Result<(), Error> {
    with_db!(state, |c| db::delete_playlist(c, id))
}

#[tauri::command]
fn add_to_playlist(
    state: State<'_, AppState>,
    playlist_id: i64,
    track_ids: Vec<i64>,
) -> Result<(), Error> {
    with_db!(state, |c| db::add_to_playlist(c, playlist_id, &track_ids))
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
    ))
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
    let (targets, items) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        (db::get_targets(&conn, target_id)?, collect_items(&conn)?)
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
        let outcome = sync::run(&app, &state.http, target, &items).await;
        let record = db::RunRecord {
            target_id: target.id,
            started_at,
            finished_at: unix_now(),
            uploaded: outcome.summary.uploaded,
            skipped: outcome.summary.skipped,
            failed: outcome.summary.failed.len(),
            first_error: outcome.summary.failed.first().cloned(),
        };
        let mut conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::record_run(&mut conn, &record, &outcome.present)?;
    }
    Ok(())
}

#[tauri::command]
fn is_syncing(state: State<'_, AppState>) -> bool {
    state.syncing.load(Ordering::SeqCst)
}

fn art_response(app: &AppHandle, id: Option<i64>) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap_or_default()
    };
    let Some(id) = id else { return not_found() };
    let state = app.state::<AppState>();
    let path = state
        .db
        .lock()
        .ok()
        .and_then(|c| db::track_path(&c, id).ok().flatten());
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
            let id = request.uri().path().trim_matches('/').parse::<i64>().ok();
            std::thread::spawn(move || responder.respond(art_response(&app, id)));
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
                http,
                syncing: AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_library,
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
            is_syncing
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
