#![allow(clippy::needless_pass_by_value)] // Tauri command args are taken by value

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

use crate::db::{Playlist, Tag, Track};
use crate::error::Error;

struct AppState {
    db: Mutex<Connection>,
    http: reqwest::Client,
    syncing: AtomicBool,
}

const SETTING_ROOT: &str = "library_root";
const SETTING_TARGET: &str = "sync_target";

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
fn get_sync_target(state: State<'_, AppState>) -> Result<Option<sync::Target>, Error> {
    let raw = with_db!(state, |c| db::get_setting(c, SETTING_TARGET))?;
    Ok(raw.and_then(|r| serde_json::from_str(&r).ok()))
}

#[tauri::command]
fn set_sync_target(state: State<'_, AppState>, target: Option<sync::Target>) -> Result<(), Error> {
    let raw = target
        .map(|t| serde_json::to_string(&t))
        .transpose()
        .map_err(|e| Error::Msg(e.to_string()))?;
    with_db!(state, |c| db::set_setting(
        c,
        SETTING_TARGET,
        raw.as_deref()
    ))
}

fn collect_items(conn: &Connection) -> Result<(Option<sync::Target>, Vec<sync::Item>), Error> {
    let target = db::get_setting(conn, SETTING_TARGET)?
        .and_then(|r| serde_json::from_str::<sync::Target>(&r).ok());
    let Some(root) = db::get_setting(conn, SETTING_ROOT)? else {
        return Ok((target, Vec::new()));
    };
    let root = Path::new(&root);
    let items = db::all_paths(conn)?
        .into_iter()
        .filter_map(|p| {
            let local = PathBuf::from(p);
            let rel = local
                .strip_prefix(root)
                .ok()?
                .iter()
                .map(|s| s.to_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?;
            Some(sync::Item { local, rel })
        })
        .collect();
    Ok((target, items))
}

#[tauri::command]
async fn sync_now(app: AppHandle, state: State<'_, AppState>) -> Result<sync::Summary, Error> {
    let (target, items) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        collect_items(&conn)?
    };
    let target = target.ok_or_else(|| Error::Msg("no sync target selected".to_owned()))?;
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a sync is already running".to_owned()));
    }
    let summary = sync::run(&app, &state.http, &target, items).await;
    state.syncing.store(false, Ordering::SeqCst);
    Ok(summary)
}

/// # Panics
/// Panics if the Tauri application fails to start.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(clippy::expect_used)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            get_sync_target,
            set_sync_target,
            sync_now
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
