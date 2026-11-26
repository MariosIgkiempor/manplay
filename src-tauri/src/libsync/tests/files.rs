//! Where songs are and which were removed, written as ops (`files.rs`).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::{Memory, device, library, open, run_both, track};
use crate::libsync::clock;
use crate::libsync::files::{self, Move, RelPath, Stayed, UnixSeconds};
use crate::libsync::{remap, state};

const ROOT: &str = "/music";
/// Songs missing since this time or earlier count as removed: 500 is long ago, 2000 just now.
const EXPIRED_BEFORE: UnixSeconds = 1_000;
const JUST_NOW: UnixSeconds = 2_000;

fn record(db: &Mutex<Connection>) -> usize {
    files::record(&db.lock().expect("lock"), Path::new(ROOT), EXPIRED_BEFORE).expect("record")
}

fn sql(db: &Mutex<Connection>, statement: &str, song: usize) {
    db.lock()
        .expect("lock")
        .execute(statement, params![format!("fp{song}")])
        .expect("sql");
}

fn register(db: &Mutex<Connection>, song: usize, field: &str) -> Option<Value> {
    state::get(
        &db.lock().expect("lock"),
        "file",
        &format!("fp{song}"),
        field,
    )
    .expect("get")
}

/// The clock of the op that holds a field now, as its milliseconds.
fn written_at(db: &Mutex<Connection>, song: usize, field: &str) -> i64 {
    let conn = db.lock().expect("lock");
    let (at, _) = state::get_clocked(&conn, "file", &format!("fp{song}"), field)
        .expect("get")
        .expect("the field has a value");
    clock::parse(&at).expect("clock").0
}

/// Clocks this old are not edits: they say what a library simply had.
const EARLY_MS: i64 = 1_000_000;

#[test]
fn a_path_is_told_from_the_library_folder_down() {
    let cases: [(&str, &str, Option<&[&str]>); 5] = [
        ("/music", "/music/a.mp3", Some(&["a.mp3"])),
        (
            "/music",
            "/music/House/Deep/a.mp3",
            Some(&["House", "Deep", "a.mp3"]),
        ),
        ("/music", "/other/a.mp3", None),
        ("/music", "/music", None),
        ("/music", "/musical/a.mp3", None),
    ];
    for (root, path, want) in cases {
        let got = RelPath::below(Path::new(root), Path::new(path));
        let want = want.map(|parts| json!(parts).to_string());
        assert_eq!(
            got.map(|p| serde_json::to_string(&p).expect("json")),
            want,
            "{path} below {root}"
        );
    }
}

#[test]
fn what_the_library_has_is_written_once_and_never_as_an_edit() {
    let a = device(3);
    assert_eq!(record(&a), 6, "a path and a presence per song");
    assert_eq!(register(&a, 2, "path"), Some(json!(["2.mp3"])));
    assert_eq!(register(&a, 2, "present"), Some(json!(true)));
    assert!(written_at(&a, 2, "path") < EARLY_MS);
    assert!(written_at(&a, 2, "present") < EARLY_MS);
    assert_eq!(record(&a), 0, "nothing changed, nothing to say");
}

#[test]
fn nothing_is_written_while_library_data_is_not_shared() {
    let conn = open();
    library(&conn, 2);
    let db = Mutex::new(conn);
    assert_eq!(record(&db), 0);
    assert_eq!(register(&db, 1, "path"), None);
}

#[test]
fn a_change_in_the_library_becomes_an_edit_and_a_missing_song_waits() {
    struct Case {
        what: &'static str,
        change: &'static str,
        path: Value,
        present: bool,
        /// Whether the field that should change was written as an edit.
        edit: Option<&'static str>,
    }
    let here = json!(["1.mp3"]);
    let cases = [
        Case {
            what: "moved into a folder",
            change: "UPDATE tracks SET path = '/music/House/1.mp3' WHERE audio_fp = ?1",
            path: json!(["House", "1.mp3"]),
            present: true,
            edit: Some("path"),
        },
        Case {
            what: "missing, grace period not over",
            change: "UPDATE tracks SET missing_since = 2000 WHERE audio_fp = ?1",
            path: here.clone(),
            present: true,
            edit: None,
        },
        Case {
            what: "missing for the whole grace period",
            change: "UPDATE tracks SET missing_since = 500 WHERE audio_fp = ?1",
            path: here.clone(),
            present: false,
            edit: Some("present"),
        },
        Case {
            what: "removed now by the user",
            change: "UPDATE tracks SET missing_since = 0 WHERE audio_fp = ?1",
            path: here.clone(),
            present: false,
            edit: Some("present"),
        },
        Case {
            what: "missing for long, but the library folder was switched",
            change: "UPDATE tracks SET missing_since = 500, path = '/old/1.mp3' WHERE audio_fp = ?1",
            path: here.clone(),
            present: true,
            edit: None,
        },
        Case {
            what: "there, but not below the library folder",
            change: "UPDATE tracks SET path = '/old/1.mp3' WHERE audio_fp = ?1",
            path: here.clone(),
            present: true,
            edit: None,
        },
        Case {
            what: "its record is gone",
            change: "DELETE FROM tracks WHERE audio_fp = ?1",
            path: here.clone(),
            present: true,
            edit: None,
        },
    ];
    for case in cases {
        let a = device(2);
        record(&a);
        sql(&a, case.change, 1);
        let written = record(&a);
        assert_eq!(written, usize::from(case.edit.is_some()), "{}", case.what);
        assert_eq!(register(&a, 1, "path"), Some(case.path), "{}", case.what);
        assert_eq!(
            register(&a, 1, "present"),
            Some(json!(case.present)),
            "{}",
            case.what
        );
        if let Some(field) = case.edit {
            assert!(written_at(&a, 1, field) > EARLY_MS, "{}", case.what);
        }
        assert_eq!(record(&a), 0, "{}: said once", case.what);
    }
}

#[test]
fn a_removed_song_that_comes_back_is_present_again() {
    let a = device(1);
    record(&a);
    sql(
        &a,
        "UPDATE tracks SET missing_since = 500 WHERE audio_fp = ?1",
        1,
    );
    record(&a);
    assert_eq!(register(&a, 1, "present"), Some(json!(false)));
    sql(
        &a,
        "UPDATE tracks SET missing_since = NULL WHERE audio_fp = ?1",
        1,
    );
    assert_eq!(record(&a), 1);
    assert_eq!(register(&a, 1, "present"), Some(json!(true)));
}

#[test]
fn of_two_copies_one_path_is_written_and_it_stays_while_that_copy_does() {
    let a = device(1);
    {
        let conn = a.lock().expect("lock");
        conn.execute(
            "INSERT INTO tracks (path, artist, album, title, size, audio_fp)
             VALUES ('/music/0 copy.mp3', 'a', 'b', 's', 1, 'fp1')",
            [],
        )
        .expect("copy");
    }
    record(&a);
    assert_eq!(register(&a, 1, "path"), Some(json!(["0 copy.mp3"])));
    {
        let conn = a.lock().expect("lock");
        conn.execute(
            "INSERT INTO tracks (path, artist, album, title, size, audio_fp)
             VALUES ('/music/0 another.mp3', 'a', 'b', 's', 1, 'fp1')",
            [],
        )
        .expect("copy");
    }
    assert_eq!(record(&a), 0, "a copy that sorts first does not take over");
    {
        let conn = a.lock().expect("lock");
        conn.execute(
            "UPDATE tracks SET missing_since = 500 WHERE path = '/music/0 copy.mp3'",
            [],
        )
        .expect("gone");
    }
    assert_eq!(
        record(&a),
        1,
        "the copy written about went: another one is named"
    );
    assert_eq!(register(&a, 1, "path"), Some(json!(["0 another.mp3"])));
    assert_eq!(register(&a, 1, "present"), Some(json!(true)));
}

#[test]
fn deleting_in_the_app_removes_the_song_at_once_unless_a_copy_is_left() {
    for (copy_left, want_present) in [(false, false), (true, true)] {
        let a = device(2);
        record(&a);
        if copy_left {
            a.lock()
                .expect("lock")
                .execute(
                    "INSERT INTO tracks (path, artist, album, title, size, audio_fp)
                     VALUES ('/music/z.mp3', 'a', 'b', 's', 1, 'fp1')",
                    [],
                )
                .expect("copy");
        }
        let id = a
            .lock()
            .expect("lock")
            .query_row(
                "SELECT id FROM tracks WHERE path = '/music/1.mp3'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .expect("id");
        let written =
            files::deleted_here(&a.lock().expect("lock"), Path::new(ROOT), &[id], JUST_NOW)
                .expect("deleted");
        assert_eq!(written, usize::from(!copy_left));
        assert_eq!(register(&a, 1, "present"), Some(json!(want_present)));
        let missing: Option<i64> = a
            .lock()
            .expect("lock")
            .query_row(
                "SELECT missing_since FROM tracks WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .expect("row");
        assert_eq!(missing, Some(JUST_NOW), "the song is missing at once");
        // The scan that follows finds the file gone too and has nothing to add.
        let after = record(&a);
        assert_eq!(register(&a, 1, "present"), Some(json!(want_present)));
        assert_eq!(
            after,
            usize::from(copy_left),
            "only a new path for the copy left"
        );
    }
}

#[tokio::test]
async fn an_edit_beats_what_another_library_simply_has() {
    let store = Memory::default();
    let a = device(2);
    let b = device(2);
    record(&a);
    sql(
        &a,
        "UPDATE tracks SET path = '/music/Renamed.mp3' WHERE audio_fp = ?1",
        1,
    );
    record(&a);
    // B has the same song under its old name, and says so before it has heard from A.
    record(&b);
    assert!(run_both(&a, &b, &store).await);
    for db in [&a, &b] {
        assert_eq!(register(db, 1, "path"), Some(json!(["Renamed.mp3"])));
        assert_eq!(register(db, 2, "path"), Some(json!(["2.mp3"])));
    }
    assert_eq!(
        record(&b),
        0,
        "B does not write its own name back over the rename"
    );
    assert_eq!(register(&b, 1, "path"), Some(json!(["Renamed.mp3"])));
}

#[tokio::test]
async fn a_song_removed_elsewhere_is_not_brought_back_by_a_device_that_still_has_it() {
    let store = Memory::default();
    let a = device(2);
    let b = device(2);
    record(&a);
    record(&b);
    assert!(run_both(&a, &b, &store).await);
    let id = track(&a, 1);
    files::deleted_here(&a.lock().expect("lock"), Path::new(ROOT), &[id], JUST_NOW)
        .expect("deleted");
    assert!(run_both(&a, &b, &store).await);
    assert_eq!(register(&b, 1, "present"), Some(json!(false)));
    assert_eq!(record(&b), 0);
    assert_eq!(register(&b, 1, "present"), Some(json!(false)));
    let still_there: bool = b
        .lock()
        .expect("lock")
        .query_row(
            "SELECT missing_since IS NULL FROM tracks WHERE audio_fp = 'fp1'",
            [],
            |r| r.get(0),
        )
        .expect("row");
    assert!(still_there, "nothing is removed from B's library yet");
}

#[test]
fn a_new_audio_fingerprint_keeps_what_was_written_about_the_file() {
    let a = device(1);
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
    assert_eq!(
        record(&a),
        0,
        "the same file under its new name: nothing to say"
    );
    let conn = a.lock().expect("lock");
    assert_eq!(state::get(&conn, "file", "fp1", "path").expect("get"), None);
    assert_eq!(
        state::get(&conn, "file", "new1", "path").expect("get"),
        Some(json!(["1.mp3"]))
    );
}

#[test]
fn audio_written_over_in_place_replaces_the_old_audio() {
    let a = device(2);
    record(&a);
    {
        let conn = a.lock().expect("lock");
        let id: i64 = conn
            .query_row("SELECT id FROM tracks WHERE audio_fp = 'fp1'", [], |r| {
                r.get(0)
            })
            .expect("id");
        conn.execute(
            "UPDATE tracks SET audio_fp = 'encoded' WHERE id = ?1",
            params![id],
        )
        .expect("re-encode");
        conn.execute(
            "INSERT INTO audio_changes (track_id, old_fp, new_fp) VALUES (?1, 'fp1', 'encoded')",
            params![id],
        )
        .expect("noted");
    }
    assert_eq!(record(&a), 3, "the old audio removed, the new one written");
    assert_eq!(register(&a, 1, "present"), Some(json!(false)));
    assert!(written_at(&a, 1, "present") > EARLY_MS);
    let conn = a.lock().expect("lock");
    assert_eq!(
        state::get(&conn, "file", "encoded", "path").expect("get"),
        Some(json!(["1.mp3"]))
    );
    assert_eq!(
        state::get(&conn, "file", "encoded", "present").expect("get"),
        Some(json!(true))
    );
    drop(conn);
    assert_eq!(record(&a), 0);
}

#[test]
fn a_path_from_another_device_must_stay_inside_the_library_folder() {
    let cases = [
        (json!(["House", "a.mp3"]), true),
        (json!(["a.mp3"]), true),
        (json!(["Pão", "ünï cödé.flac"]), true),
        (json!([]), false),
        (json!([""]), false),
        (json!(["..", "a.mp3"]), false),
        (json!(["House", "..", "..", "a.mp3"]), false),
        (json!([".", "a.mp3"]), false),
        (json!(["House/a.mp3"]), false),
        (json!(["House\\a.mp3"]), false),
        (json!(["a\0.mp3"]), false),
        (json!("House/a.mp3"), false),
        (json!(["House", 3]), false),
        (json!(null), false),
        (json!(["C:", "a.mp3"]), !cfg!(windows)),
    ];
    for (val, ok) in cases {
        assert_eq!(RelPath::from_value(&val).is_some(), ok, "{val}");
    }
}

fn wanted(db: &Mutex<Connection>) -> Vec<(String, String, String)> {
    record(db);
    files::moves_wanted(&db.lock().expect("lock"))
        .expect("wanted")
        .into_iter()
        .map(|m| {
            (
                m.audio_fp,
                serde_json::to_string(&m.from).expect("json"),
                serde_json::to_string(&m.to).expect("json"),
            )
        })
        .collect()
}

/// Two devices with the same two songs, in one library, that have heard of each other.
async fn two(store: &Memory) -> (Mutex<Connection>, Mutex<Connection>) {
    let a = device(2);
    let b = device(2);
    record(&a);
    record(&b);
    assert!(run_both(&a, &b, store).await);
    (a, b)
}

#[tokio::test]
async fn a_song_renamed_elsewhere_is_to_be_moved_here_and_then_nothing_is_left_to_say() {
    let store = Memory::default();
    let (a, b) = two(&store).await;
    assert_eq!(wanted(&b).len(), 0);
    sql(
        &a,
        "UPDATE tracks SET path = '/music/House/One.mp3' WHERE audio_fp = ?1",
        1,
    );
    record(&a);
    assert!(run_both(&a, &b, &store).await);
    assert_eq!(
        wanted(&b),
        [(
            "fp1".to_owned(),
            r#"["1.mp3"]"#.to_owned(),
            r#"["House","One.mp3"]"#.to_owned()
        )]
    );
    assert_eq!(
        wanted(&a).len(),
        0,
        "the device that renamed it has nothing to move"
    );
    // B moves the file and its scan finds it there.
    sql(
        &b,
        "UPDATE tracks SET path = '/music/House/One.mp3' WHERE audio_fp = ?1",
        1,
    );
    assert_eq!(wanted(&b).len(), 0);
    assert_eq!(record(&b), 0, "following a move is not an edit");
}

#[tokio::test]
async fn a_rename_made_here_since_is_not_taken_back() {
    let store = Memory::default();
    let (a, b) = two(&store).await;
    sql(
        &a,
        "UPDATE tracks SET path = '/music/Theirs.mp3' WHERE audio_fp = ?1",
        1,
    );
    record(&a);
    // B renames the same song later, before it hears of A's name for it.
    std::thread::sleep(std::time::Duration::from_millis(5));
    sql(
        &b,
        "UPDATE tracks SET path = '/music/Mine.mp3' WHERE audio_fp = ?1",
        1,
    );
    record(&b);
    assert!(run_both(&a, &b, &store).await);
    assert_eq!(wanted(&b).len(), 0, "the later rename is B's own");
    assert_eq!(wanted(&a).len(), 1, "and A follows it");
    assert_eq!(register(&a, 1, "path"), Some(json!(["Mine.mp3"])));
}

#[tokio::test]
async fn nothing_is_moved_for_a_song_removed_elsewhere_or_a_path_that_climbs_out() {
    let store = Memory::default();
    let (a, b) = two(&store).await;
    sql(
        &a,
        "UPDATE tracks SET path = '/music/Gone.mp3' WHERE audio_fp = ?1",
        1,
    );
    record(&a);
    let id = track(&a, 1);
    files::deleted_here(&a.lock().expect("lock"), Path::new(ROOT), &[id], JUST_NOW)
        .expect("deleted");
    {
        let conn = a.lock().expect("lock");
        crate::libsync::write::stamp(
            &conn,
            &[crate::libsync::write::Field {
                e: "file".to_owned(),
                id: "fp2".to_owned(),
                f: "path".to_owned(),
                val: json!(["..", "..", "etc", "2.mp3"]),
            }],
        )
        .expect("a path no honest device writes");
    }
    assert!(run_both(&a, &b, &store).await);
    assert_eq!(wanted(&b).len(), 0);
}

fn folder(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("manplay-files-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    dir
}

fn a_move(from: &[&str], to: &[&str]) -> Move {
    Move {
        audio_fp: "fp".to_owned(),
        from: RelPath::from_value(&json!(from)).expect("from"),
        to: RelPath::from_value(&json!(to)).expect("to"),
    }
}

#[test]
fn a_file_moves_into_folders_made_for_it_and_never_over_another_file() {
    let root = folder("move");
    std::fs::write(root.join("a.mp3"), b"a").expect("write");
    std::fs::write(root.join("taken.mp3"), b"other").expect("write");

    assert_eq!(
        a_move(&["a.mp3"], &["taken.mp3"]).carry_out(&root),
        Err(Stayed::Taken)
    );
    assert_eq!(std::fs::read(root.join("a.mp3")).expect("read"), b"a");
    assert_eq!(
        std::fs::read(root.join("taken.mp3")).expect("read"),
        b"other"
    );

    assert_eq!(
        a_move(&["a.mp3"], &["House", "Deep", "b.mp3"]).carry_out(&root),
        Ok(())
    );
    assert!(!root.join("a.mp3").exists());
    assert_eq!(
        std::fs::read(root.join("House").join("Deep").join("b.mp3")).expect("read"),
        b"a"
    );

    assert_eq!(
        a_move(&["a.mp3"], &["c.mp3"]).carry_out(&root),
        Err(Stayed::NotThere)
    );

    // Only the spelling changes: fine where case is ignored, and where it is not.
    assert_eq!(
        a_move(&["House", "Deep", "b.mp3"], &["House", "Deep", "B.mp3"]).carry_out(&root),
        Ok(())
    );
    let names: Vec<String> = std::fs::read_dir(root.join("House").join("Deep"))
        .expect("list")
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    assert_eq!(names, ["B.mp3"]);
    let _ = std::fs::remove_dir_all(&root);
}
