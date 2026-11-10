#![allow(clippy::needless_pass_by_value)] // Tauri command args are taken by value

mod db;
mod error;
mod scan;

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{Manager, State};

use crate::db::Track;
use crate::error::Error;

struct AppState {
    db: Mutex<Connection>,
}

#[tauri::command]
fn scan_library(state: State<'_, AppState>, root: PathBuf) -> Result<usize, Error> {
    let tracks = scan::scan(&root);
    let mut conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::upsert(&mut conn, &tracks)?;
    Ok(tracks.len())
}

#[tauri::command]
fn list_tracks(state: State<'_, AppState>) -> Result<Vec<Track>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::list(&conn)
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
            app.manage(AppState { db: Mutex::new(conn) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![scan_library, list_tracks])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
