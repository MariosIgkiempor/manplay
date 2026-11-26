//! The shared library's own sync (`libsync_worker`): when it decides to run, when it gives way,
//! and one run of it between two installs that keep their library in the same folder.
#![allow(clippy::expect_used)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Instant;

use super::{
    AppState, SETTING_ROOT, SharedPlace, db, due_library_sync, library_sync_slot, libsync, lookup,
    run_shared_folder, sync_scans,
};
use crate::libsync::auto::{self, Pace};
use crate::libsync::folder::FolderStore;
use crate::libsync::membership::{self, Home, JoinChoice};

/// An install with one song, whose library folder is `root`.
fn install(root: &Path) -> AppState {
    let conn = db::open(Path::new(":memory:")).expect("open");
    conn.execute(
        "INSERT INTO tracks (path, artist, album, title, size, audio_fp)
         VALUES ('/music/1.mp3', 'a', 'b', 's1', 1, 'fp1')",
        [],
    )
    .expect("track");
    db::set_setting(&conn, SETTING_ROOT, root.to_str()).expect("root");
    AppState {
        db: Mutex::new(conn),
        data_dir: root.to_path_buf(),
        http: reqwest::Client::new(),
        scan_http: reqwest::Client::new(),
        syncing: AtomicBool::new(false),
        fixing: AtomicBool::new(false),
        analyzing: AtomicBool::new(false),
        usb_exporting: AtomicBool::new(false),
        cancel_analysis: AtomicBool::new(false),
        lookup: lookup::Session::default(),
        scans: Mutex::new(sync_scans::ScanStore::default()),
        scan_wake: tokio::sync::Notify::new(),
        analysis_wake: tokio::sync::Notify::new(),
        import_wake: tokio::sync::Notify::new(),
        destination_io: tokio::sync::Mutex::new(()),
        next_action_id: AtomicU32::new(0),
        library_changed: Mutex::new(None),
        wf_misses: libsync::waveforms::Misses::default(),
        wf_filling: AtomicBool::new(false),
        wf_again: AtomicBool::new(false),
        jellyfin_plans: Mutex::new(HashMap::new()),
        jellyfin_pushing: tokio::sync::Mutex::new(()),
        libsync_io: tokio::sync::Mutex::new(()),
        libsync_wake: tokio::sync::Notify::new(),
        libsync_asked: AtomicBool::new(false),
        libsync_focused: AtomicBool::new(false),
        libsync_last: Mutex::new(None),
    }
}

/// A library folder of its own for one test.
fn folder(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("manplay-autosync-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("mkdir");
    root
}

async fn join(state: &AppState, root: &Path, choice: JoinChoice) {
    let sum = membership::join(
        &state.db,
        Home::Folder,
        &FolderStore::new(root),
        choice,
        "Shared",
    )
    .await
    .expect("join");
    assert!(sum.error.is_none(), "{:?}", sum.error);
}

fn tag(state: &AppState, name: &str) {
    let mut conn = state.db.lock().expect("lock");
    let id: i64 = conn
        .query_row("SELECT id FROM tracks", [], |r| r.get(0))
        .expect("track");
    db::tag_tracks(&mut conn, name, &[id]).expect("tag");
}

fn tags(state: &AppState) -> Vec<String> {
    let conn = state.db.lock().expect("lock");
    let mut stmt = conn
        .prepare("SELECT name FROM tags ORDER BY name")
        .expect("tags");
    stmt.query_map([], |r| r.get(0))
        .expect("rows")
        .map(|r| r.expect("row"))
        .collect()
}

fn is_due(state: &AppState, last_try: Option<Instant>, asked: bool, focused: bool) -> bool {
    due_library_sync(state, Pace::default(), last_try, asked, focused)
        .expect("due")
        .is_some()
}

#[tokio::test]
async fn when_the_worker_starts_a_sync() {
    let root = folder("due");
    let state = install(&root);
    assert!(
        !is_due(&state, None, true, false),
        "outside a library there is nothing to sync, even when asked"
    );
    join(&state, &root, JoinChoice::Start).await;
    let just_now = Some(Instant::now());
    // (what it is about, syncing on its own, the last try, asked, window came back, starts)
    let cases = [
        ("first look after launch", true, None, false, false, true),
        ("right after a sync", true, just_now, false, false, false),
        (
            "asked right after a sync",
            true,
            just_now,
            true,
            false,
            false,
        ),
        ("switched off", false, None, false, false, false),
        ("switched off, window back", false, None, false, true, false),
        ("switched off, but asked", false, None, true, false, true),
    ];
    for (name, on, last_try, asked, focused, starts) in cases {
        auto::set_enabled(&state.db.lock().expect("lock"), on).expect("set");
        assert_eq!(is_due(&state, last_try, asked, focused), starts, "{name}");
    }
    let place = due_library_sync(&state, Pace::default(), None, true, false).expect("due");
    assert!(matches!(place, Some(SharedPlace::Folder(at)) if at == root));
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn the_worker_gives_way_to_a_sync_the_user_started() {
    let state = install(Path::new("/nowhere"));
    assert!(library_sync_slot(&state).is_some());

    state.syncing.store(true, Ordering::SeqCst);
    assert!(library_sync_slot(&state).is_none(), "a sync is running");
    state.syncing.store(false, Ordering::SeqCst);

    let held = state.libsync_io.lock().await;
    assert!(library_sync_slot(&state).is_none(), "the library is held");
    drop(held);
    assert!(library_sync_slot(&state).is_some());
}

#[tokio::test]
async fn one_run_carries_an_edit_to_the_other_install_and_frees_the_folder() {
    let root = folder("run");
    let (a, b) = (install(&root), install(&root));
    join(&a, &root, JoinChoice::Start).await;
    join(&b, &root, JoinChoice::Merge).await;

    tag(&a, "House");
    let sent = run_shared_folder(&a, &root).await;
    assert!(sent.error.is_none(), "{:?}", sent.error);
    assert!(sent.sent > 0);
    // The lock is given back, or the other install could not sync.
    let got = run_shared_folder(&b, &root).await;
    assert!(got.error.is_none(), "{:?}", got.error);
    assert!(got.received > 0);
    assert_eq!(tags(&b), ["House"]);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn a_library_folder_that_is_away_is_an_error_not_a_crash() {
    let state = install(Path::new("/nowhere"));
    let out = run_shared_folder(&state, Path::new("/nowhere/at/all")).await;
    assert!(out.error.is_some_and(|e| e.contains("cannot be reached")));
}
