//! A shared library kept in the library folder itself (`folder.rs`), on a real folder on disk.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use rusqlite::Connection;

use super::{Memory, scopes, shown, started, tag, unjoined};
use crate::libsync::folder::FolderStore;
use crate::libsync::membership::{self, Home, JoinChoice};
use crate::libsync::remote::{ChunkRef, ChunkStore};

/// A new empty folder standing in for a library folder, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "manplay-folder-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch folder");
        Self(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn home_of(db: &Mutex<Connection>) -> Option<Home> {
    membership::home(&db.lock().expect("lock")).expect("home")
}

async fn sync(db: &Mutex<Connection>, store: &FolderStore) {
    let out = membership::run_joined(db, store, "Crates").await;
    assert!(out.error.is_none(), "{:?}", out.error);
}

#[tokio::test]
async fn a_library_shared_in_the_folder_is_found_and_joined_by_another_computer() {
    let folder = Scratch::new();
    let store = FolderStore::new(&folder.0);
    let (a, _) = unjoined(3);
    tag(&a, "House", &[1]);
    let started = membership::join(&a, Home::Folder, &store, JoinChoice::Start, "Crates")
        .await
        .expect("start");
    assert!(started.error.is_none(), "{:?}", started.error);
    assert_eq!(home_of(&a), Some(Home::Folder));
    assert!(folder.0.join(".manplay/library.json").is_file());

    // Another computer opening the same folder sees the library and who is in it.
    let (b, _) = unjoined(3);
    let found = membership::inspect(&b, &store)
        .await
        .expect("inspect")
        .expect("a library");
    assert_eq!(found.name, "Crates");
    assert_eq!(found.members.len(), 1);
    assert!(!found.members[0].mine);

    tag(&b, "Deep", &[2]);
    let joined = membership::join(&b, Home::Folder, &store, JoinChoice::Merge, "")
        .await
        .expect("join");
    assert!(joined.error.is_none(), "{:?}", joined.error);
    sync(&a, &store).await;
    sync(&b, &store).await;
    assert_eq!(shown(&a), shown(&b));
    assert_eq!(scopes(&a, "tags"), "Deep:shared,House:shared");
    // No temporary file is left behind for a listing to trip on.
    let leftovers: Vec<_> = walk(&folder.0.join(".manplay"))
        .into_iter()
        .filter(|p| p.to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

fn walk(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

#[tokio::test]
async fn the_folder_cannot_be_joined_while_in_a_library_on_a_destination() {
    let destination = Memory::default();
    let (a, _) = started(&destination).await;
    let folder = Scratch::new();
    let store = FolderStore::new(&folder.0);
    let refused = membership::join(&a, Home::Folder, &store, JoinChoice::Start, "Crates").await;
    assert!(refused.is_err());
    assert!(!folder.0.join(".manplay").exists());
}

#[tokio::test]
async fn choosing_another_library_folder_leaves_its_library_with_a_copy() {
    let folder = Scratch::new();
    let store = FolderStore::new(&folder.0);
    let (a, _) = unjoined(3);
    tag(&a, "House", &[1]);
    membership::join(&a, Home::Folder, &store, JoinChoice::Start, "Crates")
        .await
        .expect("start");
    {
        let conn = a.lock().expect("lock");
        membership::detach_folder(&conn).expect("detach");
    }
    assert_eq!(home_of(&a), None);
    assert_eq!(scopes(&a, "tags"), "House:local");
}

#[tokio::test]
async fn a_chunk_is_written_once() {
    let folder = Scratch::new();
    let store = FolderStore::new(&folder.0);
    let chunk = ChunkRef {
        dev: "dev1".to_owned(),
        seq: 1,
    };
    store
        .write_chunk(&chunk, b"one".to_vec())
        .await
        .expect("first write");
    assert!(store.write_chunk(&chunk, b"two".to_vec()).await.is_err());
    assert_eq!(store.read_chunk(&chunk).await.expect("read"), b"one");
    let listed = store.list_chunks().await.expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].chunk, chunk);
    assert_eq!(listed[0].size, 3);
}

#[tokio::test]
async fn paths_that_leave_the_folder_are_refused() {
    let folder = Scratch::new();
    let store = FolderStore::new(&folder.0);
    let cases = [
        ("parent", "../escape.json"),
        ("parent inside", "devices/../../escape.json"),
        ("current", "./library.json"),
        ("empty segment", "devices//a.json"),
        ("backslash", "devices\\a.json"),
        ("drive", "C:/escape.json"),
        ("empty", ""),
    ];
    for (case, path) in cases {
        assert!(store.read_meta(path).await.is_err(), "read {case}");
        assert!(
            store.write_meta(path, b"x".to_vec()).await.is_err(),
            "write {case}"
        );
    }
    let bad_device = ChunkRef {
        dev: "..".to_owned(),
        seq: 1,
    };
    assert!(store.write_chunk(&bad_device, Vec::new()).await.is_err());
    assert!(
        !folder
            .0
            .parent()
            .expect("parent")
            .join("escape.json")
            .exists()
    );
}

#[tokio::test]
async fn a_missing_folder_reads_as_empty() {
    let folder = Scratch::new();
    let store = FolderStore::new(&folder.0.join("not-there"));
    assert_eq!(store.list_chunks().await.expect("chunks"), Vec::new());
    assert_eq!(store.list_waveforms().await.expect("waveforms"), Vec::new());
    assert_eq!(
        store.list_meta("devices").await.expect("devices"),
        Vec::<String>::new()
    );
    assert_eq!(store.read_meta("library.json").await.expect("read"), None);
}
