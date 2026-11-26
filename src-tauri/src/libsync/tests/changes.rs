//! What other devices' edits changed here (`journal.rs`), taking them back, and the stop before
//! a lot is deleted at once (`brake.rs`).

use std::sync::Mutex;

use rusqlite::Connection;

use super::{Memory, delete_tag_named, playlist, row_id, run_both, shown, started, tag, unjoined};
use crate::db;
use crate::libsync::brake::{self, Decision};
use crate::libsync::clock;
use crate::libsync::journal::{self, Change, Standing};
use crate::libsync::membership::{self, JoinChoice};
use crate::libsync::remote::RunSummary;

/// Two devices in one library: `a` started it with the tags `House` and `Peak`.
async fn pair(store: &Memory) -> (Mutex<Connection>, Mutex<Connection>) {
    let (a, _) = started(store).await;
    let (b, id) = unjoined(3);
    let sum = membership::join(
        &b,
        membership::Home::Target(id),
        store,
        JoinChoice::Merge,
        "",
    )
    .await
    .expect("join");
    assert!(sum.error.is_none(), "{:?}", sum.error);
    assert!(run_both(&a, &b, store).await);
    (a, b)
}

async fn sync(db: &Mutex<Connection>, store: &Memory) -> RunSummary {
    let sum = membership::run_joined(db, store, "x").await;
    assert!(sum.error.is_none(), "{:?}", sum.error);
    sum
}

fn batches(db: &Mutex<Connection>) -> Vec<journal::Batch> {
    journal::list(&db.lock().expect("lock"), clock::now_ms()).expect("list")
}

fn change<'a>(batch: &'a journal::Batch, kind: &str, name: &str) -> &'a Change {
    batch
        .changes
        .iter()
        .find(|c| c.kind == kind && c.name == name)
        .expect("the batch has a change for that item")
}

fn undo(db: &Mutex<Connection>, batch: journal::BatchId) -> Result<journal::Undone, String> {
    journal::undo(&mut db.lock().expect("lock"), batch, clock::now_ms()).map_err(|e| e.to_string())
}

#[tokio::test]
async fn what_another_device_changed_is_listed_per_item() {
    let store = Memory::default();
    let (a, b) = pair(&store).await;
    let before = batches(&a).len();
    tag(&b, "Deep", &[3]);
    tag(&b, "House", &[2]);
    playlist(&b, "Warmup", &[1, 2]);
    assert!(run_both(&a, &b, &store).await);

    let all = batches(&a);
    assert_eq!(all.len(), before + 1, "one sync is one entry");
    let newest = &all[0];
    assert_eq!(newest.by.len(), 1);
    assert!(!newest.undone);
    let deep = change(newest, "tag", "Deep");
    assert_eq!(deep.standing, Standing::Created);
    assert_eq!(deep.songs_added, 1);
    let house = change(newest, "tag", "House");
    assert_eq!(house.standing, Standing::Existing);
    assert_eq!(house.songs_added, 1);
    let warmup = change(newest, "playlist", "Warmup");
    assert_eq!(warmup.standing, Standing::Created);
    assert_eq!((warmup.songs_added, warmup.songs_moved), (2, 0));
    // The device that made the edits has nothing to list for them.
    assert!(batches(&b).iter().all(|batch| batch.id != newest.id));
}

#[tokio::test]
async fn taking_a_sync_back_restores_what_was_there_for_everyone() {
    let store = Memory::default();
    let (a, b) = pair(&store).await;
    let before = shown(&a);
    tag(&b, "Deep", &[3]);
    playlist(&b, "Warmup", &[1, 2]);
    delete_tag_named(&b, "House");
    assert!(run_both(&a, &b, &store).await);
    assert_ne!(shown(&a), before);

    let batch = batches(&a)[0].id;
    let undone = undo(&a, batch).expect("undo");
    assert!(undone.reverted > 0, "{undone:?}");
    assert!(run_both(&a, &b, &store).await);
    assert_eq!(shown(&a), shown(&b));
    let text = shown(&a);
    for gone in ["Deep", "Warmup"] {
        assert!(!text.contains(gone), "{gone} is still there:\n{text}");
    }
    assert!(text.contains("tagged House fp1"), "{text}");
    assert!(text.contains("tagged Peak fp2"), "{text}");

    assert!(batches(&a).iter().any(|b| b.id == batch && b.undone));
    assert!(undo(&a, batch).is_err(), "a sync is taken back once");
}

#[tokio::test]
async fn taking_a_sync_back_leaves_what_was_changed_since() {
    let store = Memory::default();
    let (a, b) = pair(&store).await;
    let list = playlist(&b, "Warmup", &[1]);
    assert!(run_both(&a, &b, &store).await);
    db::rename_playlist(&b.lock().expect("lock"), list, "Opening").expect("rename");
    assert!(run_both(&a, &b, &store).await);
    let batch = batches(&a)[0].id;
    // Someone renames it again before the first rename is taken back.
    let mine = row_id(&a, "playlists", "Opening");
    db::rename_playlist(&a.lock().expect("lock"), mine, "Closing").expect("rename");

    let undone = undo(&a, batch).expect("undo");
    assert_eq!((undone.reverted, undone.skipped), (0, 1));
    assert!(shown(&a).contains("Closing"));
}

#[tokio::test]
async fn a_renamed_tag_stays_renamed_when_its_sync_is_taken_back() {
    let store = Memory::default();
    let (a, b) = pair(&store).await;
    db::migrate_tags(
        &mut b.lock().expect("lock"),
        &["Peak".to_owned()],
        Some("Peak time"),
    )
    .expect("rename");
    assert!(run_both(&a, &b, &store).await);
    let batch = batches(&a)[0].id;

    let undone = undo(&a, batch).expect("undo");
    assert_eq!(undone.reverted, 0, "{undone:?}");
    assert!(undone.skipped > 0);
    assert!(run_both(&a, &b, &store).await);
    assert!(shown(&a).contains("tagged Peak time fp2"), "{}", shown(&a));
    assert_eq!(shown(&a), shown(&b));
}

fn tag_names(count: usize) -> Vec<String> {
    (1..=count).map(|n| format!("Set {n:02}")).collect()
}

fn has_tag(db: &Mutex<Connection>, name: &str) -> bool {
    db.lock()
        .expect("lock")
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM tags WHERE name = ?1)",
            [name],
            |r| r.get(0),
        )
        .expect("exists")
}

/// `b` deletes `count` tags that `a` has, and `a` syncs once.
async fn after_deleting(
    count: usize,
    store: &Memory,
) -> (Mutex<Connection>, Mutex<Connection>, RunSummary) {
    let (a, b) = pair(store).await;
    for name in tag_names(count) {
        tag(&a, &name, &[1]);
    }
    assert!(run_both(&a, &b, store).await);
    for name in tag_names(count) {
        delete_tag_named(&b, &name);
    }
    sync(&b, store).await;
    let sum = sync(&a, store).await;
    (a, b, sum)
}

#[tokio::test]
async fn deletions_are_held_only_above_the_limit() {
    // (tags another device deletes, held)
    let cases = [
        (1, false),
        (brake::LIMIT, false),
        (brake::LIMIT + 1, true),
        (brake::LIMIT * 2, true),
    ];
    for (count, held) in cases {
        let store = Memory::default();
        let (a, _b, sum) = after_deleting(count, &store).await;
        assert_eq!(sum.delete_hold.is_some(), held, "{count} deletions");
        assert_eq!(has_tag(&a, "Set 01"), held, "{count} deletions");
        if let Some(hold) = sum.delete_hold {
            assert_eq!(hold.count, count);
            assert_eq!(sum.received, 0);
        }
    }
}

#[tokio::test]
async fn held_deletions_wait_and_this_devices_edits_still_go_out() {
    let store = Memory::default();
    let (a, b, _) = after_deleting(brake::LIMIT + 5, &store).await;
    tag(&a, "Mine", &[2]);
    let again = sync(&a, &store).await;
    assert!(again.delete_hold.is_some(), "still waiting");
    assert_eq!(again.received, 0);
    assert!(again.sent > 0);
    assert!(has_tag(&a, "Set 01"));
    sync(&b, &store).await;
    assert!(has_tag(&b, "Mine"));
}

#[tokio::test]
async fn held_deletions_follow_what_the_user_decides() {
    // (the decision, whether the tags are there afterwards on both devices)
    let cases = [(Decision::Apply, false), (Decision::Keep, true)];
    for (decision, kept) in cases {
        let store = Memory::default();
        let (a, b, _) = after_deleting(brake::LIMIT + 5, &store).await;
        brake::decide(&a.lock().expect("lock"), decision).expect("decide");
        let sum = sync(&a, &store).await;
        assert!(sum.delete_hold.is_none(), "{decision:?}");
        assert!(sum.received > 0, "{decision:?}");
        assert!(run_both(&a, &b, &store).await);
        for name in tag_names(brake::LIMIT + 5) {
            assert_eq!(has_tag(&a, &name), kept, "{decision:?}: {name} here");
            assert_eq!(has_tag(&b, &name), kept, "{decision:?}: {name} there");
        }
        assert_eq!(shown(&a), shown(&b), "{decision:?}");
        let conn = a.lock().expect("lock");
        assert!(brake::hold(&conn).expect("hold").is_none(), "{decision:?}");
        assert!(brake::decision(&conn).expect("decision").is_none());
    }
}

#[test]
fn deciding_needs_something_held() {
    let (a, _) = unjoined(1);
    assert!(brake::decide(&a.lock().expect("lock"), Decision::Apply).is_err());
}
