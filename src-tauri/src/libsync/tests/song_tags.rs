//! The tags in the songs' files, written as ops and wanted from other devices (`song_tags.rs`).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::{Memory, device, library, open, run_both};
use crate::libsync::song_tags::{self, Fields};
use crate::libsync::{clock, journal, remap, state};

const ROOT: &str = "/music";

/// Clocks this old are not edits: they say what a file simply had.
const EARLY_MS: i64 = 1_000_000;

fn fields(pairs: &[(&str, &str)]) -> Fields {
    pairs
        .iter()
        .map(|(field, value)| ((*field).to_owned(), (*value).to_owned()))
        .collect()
}

/// The file of `song` now has these tags, and they were read.
fn retag(db: &Mutex<Connection>, song: usize, pairs: &[(&str, &str)]) {
    let conn = db.lock().expect("lock");
    let id: i64 = conn
        .query_row(
            "UPDATE tracks SET mtime_ms = COALESCE(mtime_ms, 0) + 1 WHERE audio_fp = ?1
             RETURNING id",
            params![format!("fp{song}")],
            |r| r.get(0),
        )
        .expect("touch");
    let file = song_tags::unread(&conn, 100)
        .expect("unread")
        .into_iter()
        .find(|file| file.track_id == id)
        .expect("the changed file is to be read");
    song_tags::store(&conn, &[(file, Some(fields(pairs)))]).expect("store");
}

fn record(db: &Mutex<Connection>) -> usize {
    song_tags::record(&db.lock().expect("lock"), Path::new(ROOT)).expect("record")
}

fn register(db: &Mutex<Connection>, song: usize, field: &str) -> Option<Value> {
    state::get(
        &db.lock().expect("lock"),
        "song_tags",
        &format!("fp{song}"),
        field,
    )
    .expect("get")
}

fn written_at(db: &Mutex<Connection>, song: usize, field: &str) -> i64 {
    let conn = db.lock().expect("lock");
    let (at, _) = state::get_clocked(&conn, "song_tags", &format!("fp{song}"), field)
        .expect("get")
        .expect("the field has a value");
    clock::parse(&at).expect("clock").0
}

/// What is to be written into this library's files: `(audio, fields)`.
fn wanted(db: &Mutex<Connection>) -> Vec<(String, Fields)> {
    record(db);
    song_tags::wanted(&db.lock().expect("lock"), Path::new(ROOT))
        .expect("wanted")
        .into_iter()
        .map(|write| (write.audio_fp, write.edits))
        .collect()
}

/// Two devices in one library with the same song, tagged the same.
async fn two(store: &Memory) -> (Mutex<Connection>, Mutex<Connection>) {
    let a = device(1);
    let b = device(1);
    for db in [&a, &b] {
        retag(db, 1, &[("title", "One"), ("genre", "House")]);
        record(db);
    }
    assert!(run_both(&a, &b, store).await);
    (a, b)
}

#[test]
fn only_text_for_a_shared_tag_field_is_taken_from_another_device() {
    let long = "x".repeat(64 * 1024 + 1);
    let cases = [
        ("title", json!("One"), true),
        ("comment", json!("two\nlines"), true),
        ("genre", json!(""), true),
        ("title", json!(7), false),
        ("title", json!(null), false),
        ("title", json!(["One"]), false),
        ("title", json!("a\0b"), false),
        ("title", json!(long), false),
        ("bpm", json!("128"), false),
        ("key", json!("8A"), false),
        ("path", json!("x"), false),
        ("", json!("x"), false),
    ];
    for (field, val, ok) in cases {
        assert_eq!(
            song_tags::shared_value(field, &val).is_some(),
            ok,
            "{field}: {}",
            val.to_string().chars().take(40).collect::<String>()
        );
    }
}

#[test]
fn a_file_is_read_once_and_again_when_it_changes() {
    let a = device(2);
    let unread = |db: &Mutex<Connection>| {
        song_tags::unread(&db.lock().expect("lock"), 100)
            .expect("unread")
            .len()
    };
    assert_eq!(unread(&a), 2);
    retag(&a, 1, &[("title", "One")]);
    assert_eq!(unread(&a), 1);
    let changes = [
        (
            "another time",
            "UPDATE tracks SET mtime_ms = 99 WHERE audio_fp = 'fp1'",
        ),
        (
            "another size",
            "UPDATE tracks SET size = 7 WHERE audio_fp = 'fp1'",
        ),
    ];
    for (what, change) in changes {
        a.lock().expect("lock").execute(change, []).expect("change");
        assert_eq!(unread(&a), 2, "{what}");
        retag(&a, 1, &[("title", "One")]);
        assert_eq!(unread(&a), 1, "{what}, read again");
    }
    a.lock()
        .expect("lock")
        .execute(
            "UPDATE tracks SET missing_since = 5 WHERE audio_fp = 'fp2'",
            [],
        )
        .expect("missing");
    assert_eq!(unread(&a), 0, "a missing file is not read");
}

#[test]
fn nothing_is_read_or_written_while_library_data_is_not_shared() {
    let conn = open();
    library(&conn, 1);
    assert_eq!(song_tags::unread(&conn, 100).expect("unread").len(), 0);
    assert_eq!(
        song_tags::record(&conn, Path::new(ROOT)).expect("record"),
        0
    );
    assert_eq!(
        song_tags::wanted(&conn, Path::new(ROOT))
            .expect("wanted")
            .len(),
        0
    );
}

#[test]
fn what_a_file_has_is_written_once_and_never_as_an_edit() {
    let a = device(2);
    retag(
        &a,
        1,
        &[
            ("title", "One"),
            ("genre", "House"),
            ("bpm", "128"),
            ("key", "8A"),
        ],
    );
    assert_eq!(
        record(&a),
        2,
        "title and genre; tempo and key are the analysis's"
    );
    assert_eq!(register(&a, 1, "title"), Some(json!("One")));
    assert_eq!(register(&a, 1, "bpm"), None);
    assert!(written_at(&a, 1, "title") < EARLY_MS);
    assert_eq!(register(&a, 2, "title"), None, "a file not read yet");
    assert_eq!(record(&a), 0, "nothing changed, nothing to say");
}

#[test]
fn a_tag_changed_in_a_file_becomes_an_edit() {
    struct Case {
        what: &'static str,
        now: &'static [(&'static str, &'static str)],
        field: &'static str,
        value: &'static str,
    }
    let cases = [
        Case {
            what: "a field changed",
            now: &[("title", "Uno"), ("genre", "House")],
            field: "title",
            value: "Uno",
        },
        Case {
            what: "a field cleared",
            now: &[("title", "One")],
            field: "genre",
            value: "",
        },
        Case {
            what: "a field added",
            now: &[("title", "One"), ("genre", "House"), ("label", "Tresor")],
            field: "label",
            value: "Tresor",
        },
    ];
    for case in cases {
        let a = device(1);
        retag(&a, 1, &[("title", "One"), ("genre", "House")]);
        record(&a);
        retag(&a, 1, case.now);
        assert_eq!(record(&a), 1, "{}", case.what);
        assert_eq!(
            register(&a, 1, case.field),
            Some(json!(case.value)),
            "{}",
            case.what
        );
        assert!(written_at(&a, 1, case.field) > EARLY_MS, "{}", case.what);
        assert_eq!(record(&a), 0, "{}", case.what);
    }
}

#[tokio::test]
async fn a_tag_changed_elsewhere_is_to_be_written_here_and_then_nothing_is_left_to_say() {
    let store = Memory::default();
    let (a, b) = two(&store).await;
    assert_eq!(wanted(&b).len(), 0);
    retag(&a, 1, &[("title", "Uno"), ("genre", "House")]);
    record(&a);
    assert!(run_both(&a, &b, &store).await);
    assert_eq!(
        wanted(&b),
        [("fp1".to_owned(), fields(&[("title", "Uno")]))]
    );
    assert_eq!(wanted(&a).len(), 0, "A's file already says so");
    // B's file is written and read again.
    retag(&b, 1, &[("title", "Uno"), ("genre", "House")]);
    assert_eq!(record(&b), 0, "B says nothing: it only followed");
    assert_eq!(wanted(&b).len(), 0);
}

#[tokio::test]
async fn a_tag_cleared_elsewhere_is_to_be_cleared_here() {
    let store = Memory::default();
    let (a, b) = two(&store).await;
    retag(&a, 1, &[("title", "One")]);
    record(&a);
    assert!(run_both(&a, &b, &store).await);
    assert_eq!(wanted(&b), [("fp1".to_owned(), fields(&[("genre", "")]))]);
}

#[tokio::test]
async fn the_later_of_two_changes_to_one_field_stays_and_other_fields_merge() {
    let store = Memory::default();
    let (a, b) = two(&store).await;
    retag(&a, 1, &[("title", "Theirs"), ("genre", "Techno")]);
    record(&a);
    std::thread::sleep(std::time::Duration::from_millis(5));
    retag(&b, 1, &[("title", "Mine"), ("genre", "House")]);
    record(&b);
    assert!(run_both(&a, &b, &store).await);
    assert_eq!(
        wanted(&b),
        [("fp1".to_owned(), fields(&[("genre", "Techno")]))],
        "B keeps its later title and takes the genre it did not touch"
    );
    assert_eq!(
        wanted(&a),
        [("fp1".to_owned(), fields(&[("title", "Mine")]))]
    );
}

#[tokio::test]
async fn files_tagged_differently_before_sharing_end_up_the_same() {
    let store = Memory::default();
    let a = device(1);
    let b = device(1);
    retag(&a, 1, &[("title", "A's")]);
    retag(&b, 1, &[("title", "B's")]);
    record(&a);
    record(&b);
    assert!(run_both(&a, &b, &store).await);
    let title = register(&a, 1, "title");
    assert_eq!(register(&b, 1, "title"), title, "both agree on one");
    assert_eq!(
        wanted(&a).len() + wanted(&b).len(),
        1,
        "and the other file is to be written"
    );
}

#[tokio::test]
async fn a_tag_another_device_changed_is_listed_and_can_be_taken_back() {
    let store = Memory::default();
    let (a, b) = two(&store).await;
    let list = |db: &Mutex<Connection>| {
        journal::list(&db.lock().expect("lock"), clock::now_ms()).expect("list")
    };
    assert_eq!(
        list(&b).iter().flat_map(|batch| &batch.changes).count(),
        0,
        "what the other device's file simply had is not a change"
    );
    retag(&a, 1, &[("title", "Uno"), ("genre", "House")]);
    record(&a);
    assert!(run_both(&a, &b, &store).await);
    let batches = list(&b);
    let change = &batches[0].changes[0];
    assert_eq!((change.kind.as_str(), change.count), ("song_tags", 1));
    retag(&b, 1, &[("title", "Uno"), ("genre", "House")]);
    record(&b);
    journal::undo(&mut b.lock().expect("lock"), batches[0].id, clock::now_ms()).expect("undo");
    assert_eq!(register(&b, 1, "title"), Some(json!("One")));
    assert_eq!(
        wanted(&b),
        [("fp1".to_owned(), fields(&[("title", "One")]))],
        "B's file gets the old title back"
    );
    assert!(run_both(&a, &b, &store).await);
    assert_eq!(
        wanted(&a),
        [("fp1".to_owned(), fields(&[("title", "One")]))],
        "and so does A's"
    );
}

#[test]
fn a_value_that_cannot_go_into_a_file_is_not_wanted() {
    let a = device(1);
    retag(&a, 1, &[("title", "One")]);
    record(&a);
    {
        let conn = a.lock().expect("lock");
        let field = |f: &str, val: Value| crate::libsync::write::Field {
            e: "song_tags".to_owned(),
            id: "fp1".to_owned(),
            f: f.to_owned(),
            val,
        };
        crate::libsync::write::stamp(
            &conn,
            &[
                field("title", json!(["not", "text"])),
                field("key", json!("8A")),
                field("nonsense", json!("x")),
                field("genre", json!("House")),
            ],
        )
        .expect("stamp");
    }
    assert_eq!(
        wanted(&a),
        [("fp1".to_owned(), fields(&[("genre", "House")]))]
    );
}

#[test]
fn of_two_copies_only_the_one_written_about_is_looked_at() {
    let a = device(1);
    a.lock()
        .expect("lock")
        .execute(
            "INSERT INTO tracks (path, artist, album, title, size, audio_fp)
             VALUES ('/music/Copy/1.mp3', 'a', 'b', 's', 1, 'fp1')",
            [],
        )
        .expect("copy");
    crate::libsync::files::record(&a.lock().expect("lock"), Path::new(ROOT), 0).expect("files");
    let conn = a.lock().expect("lock");
    let unread = song_tags::unread(&conn, 100).expect("unread");
    let read: Vec<_> = unread
        .into_iter()
        .map(|file| {
            let title = if file.path == "/music/1.mp3" {
                "Kept"
            } else {
                "Copy"
            };
            (file, Some(fields(&[("title", title)])))
        })
        .collect();
    song_tags::store(&conn, &read).expect("store");
    drop(conn);
    assert_eq!(record(&a), 1);
    assert_eq!(register(&a, 1, "title"), Some(json!("Kept")));
}

#[test]
fn a_new_audio_fingerprint_keeps_what_was_written_about_the_tags() {
    let a = device(1);
    retag(&a, 1, &[("title", "One")]);
    record(&a);
    {
        let conn = a.lock().expect("lock");
        conn.execute(
            "UPDATE tracks SET audio_fp = 'new1' WHERE audio_fp = 'fp1'",
            [],
        )
        .expect("reprint");
        remap::apply_pair(&conn, "fp1", "new1").expect("remap");
    }
    assert_eq!(record(&a), 0, "the same file under its new name");
    let conn = a.lock().expect("lock");
    assert_eq!(
        state::get(&conn, "song_tags", "fp1", "title").expect("get"),
        None
    );
    assert_eq!(
        state::get(&conn, "song_tags", "new1", "title").expect("get"),
        Some(json!("One"))
    );
}
