//! The songs this device streams, as rows built from the log (`streamed.rs`).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, params};

use super::{Memory, device, run_both, tag};
use crate::db::FileState;
use crate::libsync::files::{self, UnixSeconds};
use crate::libsync::song_tags::{self, Fields};
use crate::libsync::keep::{self, KeepKind, KeepRule};
use crate::libsync::streamed::{self, NewSongs, Refreshed};

const ROOT: &str = "/music";
const EXPIRED_BEFORE: UnixSeconds = 1_000;

fn lock(db: &Mutex<Connection>) -> std::sync::MutexGuard<'_, Connection> {
    db.lock().expect("lock")
}

fn record(db: &Mutex<Connection>) {
    let conn = lock(db);
    files::record(&conn, Path::new(ROOT), EXPIRED_BEFORE).expect("files");
    song_tags::record(&conn, Path::new(ROOT)).expect("tags");
}

fn refresh(db: &Mutex<Connection>) -> Refreshed {
    streamed::refresh(&lock(db), Path::new(ROOT)).expect("refresh")
}

fn sql(db: &Mutex<Connection>, statement: &str, song: usize) {
    lock(db)
        .execute(statement, params![format!("fp{song}")])
        .expect("sql");
}

/// The file of `song` now has these tags, and they were read.
fn retag(db: &Mutex<Connection>, song: usize, pairs: &[(&str, &str)]) {
    let conn = lock(db);
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
    let fields: Fields = pairs
        .iter()
        .map(|(f, v)| ((*f).to_owned(), (*v).to_owned()))
        .collect();
    song_tags::store(&conn, &[(file, Some(fields))]).expect("store");
}

/// `(path, artist, album, title, duration_ms, file_state)` of the row with `song`'s audio.
type Row = (String, String, String, String, Option<i64>, FileState);

fn row(db: &Mutex<Connection>, song: usize) -> Option<Row> {
    lock(db)
        .query_row(
            "SELECT path, artist, album, title, duration_ms, file_state FROM tracks
             WHERE audio_fp = ?1",
            params![format!("fp{song}")],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .ok()
}

fn rows(db: &Mutex<Connection>) -> i64 {
    lock(db)
        .query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
        .expect("count")
}

/// `a` has three songs and `b` the first two; `a`'s third has tags and details; they have synced.
async fn one_more(store: &Memory) -> (Mutex<Connection>, Mutex<Connection>) {
    let a = device(3);
    let b = device(2);
    sql(
        &a,
        "UPDATE tracks SET path = '/music/Artist/Album/3.mp3', duration_ms = 200000,
                bitrate = 320, sample_rate = 44100, size = 9000000
         WHERE audio_fp = ?1",
        3,
    );
    retag(
        &a,
        3,
        &[
            ("title", "Night Drive"),
            ("artist", "Kas"),
            ("genre", "House"),
        ],
    );
    record(&a);
    record(&b);
    assert!(run_both(&a, &b, store).await);
    (a, b)
}

#[tokio::test]
async fn a_song_only_another_device_has_is_streamed_with_its_tags_and_details() {
    let store = Memory::default();
    let (_a, b) = one_more(&store).await;
    assert_eq!(refresh(&b).added, 1);
    assert_eq!(
        row(&b, 3),
        Some((
            "/music/Artist/Album/3.mp3".to_owned(),
            "Kas".to_owned(),
            "Album".to_owned(),
            "Night Drive".to_owned(),
            Some(200_000),
            FileState::Streamed,
        )),
        "the album comes from the folder when the log has no album tag"
    );
    assert_eq!(
        refresh(&b),
        Refreshed::default(),
        "nothing changed, nothing to do"
    );
    assert!(
        files::arrivals_wanted(&lock(&b))
            .expect("arrivals")
            .is_empty(),
        "a streamed song is not downloaded"
    );
}

#[tokio::test]
async fn a_streamed_song_is_in_the_shared_tags_it_is_in() {
    let store = Memory::default();
    let (a, b) = one_more(&store).await;
    tag(&a, "Warmup", &[3]);
    assert!(run_both(&a, &b, &store).await);
    refresh(&b);
    let tagged: i64 = lock(&b)
        .query_row(
            "SELECT COUNT(*) FROM track_tags tt JOIN tags g ON g.id = tt.tag_id
             JOIN tracks t ON t.id = tt.track_id WHERE g.name = 'Warmup' AND t.audio_fp = 'fp3'",
            [],
            |r| r.get(0),
        )
        .expect("count");
    assert_eq!(tagged, 1);
}

#[tokio::test]
async fn a_streamed_song_follows_renames_and_tag_edits_from_other_devices() {
    let store = Memory::default();
    let (a, b) = one_more(&store).await;
    refresh(&b);
    sql(
        &a,
        "UPDATE tracks SET path = '/music/Kas/3.mp3' WHERE audio_fp = ?1",
        3,
    );
    retag(&a, 3, &[("title", "Night Drive (Edit)"), ("artist", "Kas")]);
    record(&a);
    assert!(run_both(&a, &b, &store).await);
    assert_eq!(refresh(&b).updated, 1);
    let (path, _, _, title, _, state) = row(&b, 3).expect("row");
    assert_eq!(path, "/music/Kas/3.mp3");
    assert_eq!(title, "Night Drive (Edit)");
    assert_eq!(state, FileState::Streamed);
    assert!(
        files::moves_wanted(&lock(&b)).expect("moves").is_empty(),
        "there is no file to move"
    );
}

#[tokio::test]
async fn a_streamed_row_goes_when_the_song_is_removed_kept_or_the_library_left() {
    struct Case {
        what: &'static str,
        /// Run on `a`, which has the file, before the devices sync again.
        on_a: &'static str,
        /// Run on `b`, which streams it.
        on_b: &'static str,
        rows_left: i64,
        state_left: Option<FileState>,
    }
    let nothing = "UPDATE tracks SET size = size WHERE audio_fp = ?1";
    let cases = [
        Case {
            what: "removed by the device that had it",
            on_a: "UPDATE tracks SET missing_since = 0 WHERE audio_fp = ?1",
            on_b: nothing,
            rows_left: 2,
            state_left: None,
        },
        Case {
            what: "kept here: its file was downloaded and read",
            on_a: nothing,
            on_b: "UPDATE tracks SET file_state = 'here' WHERE audio_fp = ?1",
            rows_left: 3,
            state_left: Some(FileState::Here),
        },
        Case {
            what: "the shared library was left",
            on_a: nothing,
            on_b: "UPDATE sync_targets SET libsync = 0 WHERE ?1 IS NOT NULL",
            rows_left: 2,
            state_left: None,
        },
    ];
    for case in cases {
        let store = Memory::default();
        let (a, b) = one_more(&store).await;
        assert_eq!(refresh(&b).added, 1, "{}", case.what);
        sql(&a, case.on_a, 3);
        record(&a);
        assert!(run_both(&a, &b, &store).await, "{}", case.what);
        sql(&b, case.on_b, 3);
        refresh(&b);
        assert_eq!(rows(&b), case.rows_left, "{}", case.what);
        assert_eq!(row(&b, 3).map(|r| r.5), case.state_left, "{}", case.what);
    }
}

#[tokio::test]
async fn new_songs_set_to_download_are_not_streamed_but_streamed_ones_stay() {
    let store = Memory::default();
    let (a, b) = one_more(&store).await;
    NewSongs::Download.set(&lock(&b)).expect("set");
    assert_eq!(refresh(&b).added, 0);
    assert_eq!(
        files::arrivals_wanted(&lock(&b)).expect("arrivals").len(),
        1
    );

    NewSongs::Stream.set(&lock(&b)).expect("set");
    assert_eq!(refresh(&b).added, 1);
    NewSongs::Download.set(&lock(&b)).expect("set");
    retag(&a, 3, &[("title", "Renamed")]);
    record(&a);
    assert!(run_both(&a, &b, &store).await);
    assert_eq!(
        refresh(&b).updated,
        1,
        "a song already streamed stays and follows the log"
    );
    assert_eq!(row(&b, 3).map(|r| r.5), Some(FileState::Streamed));
}

#[test]
fn the_new_songs_setting_reads_back_and_defaults_to_stream() {
    let db = device(0);
    let conn = lock(&db);
    assert_eq!(NewSongs::get(&conn).expect("get"), NewSongs::Stream);
    for want in [NewSongs::Download, NewSongs::Stream] {
        want.set(&conn).expect("set");
        assert_eq!(NewSongs::get(&conn).expect("get"), want);
    }
}

fn rule(kind: KeepKind, id: &str) -> KeepRule {
    KeepRule {
        kind,
        id: id.to_owned(),
    }
}

fn to_download(db: &Mutex<Connection>) -> Vec<String> {
    keep::to_download(&lock(db), Path::new(ROOT))
        .expect("to download")
        .iter()
        .map(|rel| rel.parts().join("/"))
        .collect()
}

#[tokio::test]
async fn a_kept_song_or_a_kept_playlists_songs_are_downloaded_and_nothing_else() {
    struct Case {
        what: &'static str,
        keep: fn(&Mutex<Connection>),
        want: &'static [&'static str],
    }
    let cases = [
        Case {
            what: "nothing kept",
            keep: |_| {},
            want: &[],
        },
        Case {
            what: "the song kept",
            keep: |b| keep::add(&lock(b), &[rule(KeepKind::Song, "fp3")]).expect("keep"),
            want: &["Artist/Album/3.mp3"],
        },
        Case {
            what: "a playlist with it kept",
            keep: |b| {
                let conn = lock(b);
                let uid: String = conn
                    .query_row("SELECT uid FROM playlists WHERE name = 'Set'", [], |r| {
                        r.get(0)
                    })
                    .expect("uid");
                keep::add(&conn, &[rule(KeepKind::Playlist, &uid)]).expect("keep");
            },
            want: &["Artist/Album/3.mp3"],
        },
        Case {
            what: "a song that is kept already",
            keep: |b| keep::add(&lock(b), &[rule(KeepKind::Song, "fp1")]).expect("keep"),
            want: &[],
        },
    ];
    for case in cases {
        let store = Memory::default();
        let (a, b) = one_more(&store).await;
        super::playlist(&a, "Set", &[3]);
        assert!(run_both(&a, &b, &store).await, "{}", case.what);
        refresh(&b);
        (case.keep)(&b);
        assert_eq!(to_download(&b), case.want, "{}", case.what);
    }
}

#[tokio::test]
async fn a_song_in_a_kept_playlist_is_kept_by_it_and_a_rule_can_be_taken_back() {
    let store = Memory::default();
    let (a, b) = one_more(&store).await;
    super::playlist(&a, "Set", &[3]);
    assert!(run_both(&a, &b, &store).await);
    refresh(&b);
    let conn = lock(&b);
    let (uid, kept_before): (String, bool) = conn
        .query_row(
            "SELECT uid, EXISTS (SELECT 1 FROM keep_rules) FROM playlists WHERE name = 'Set'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("uid");
    assert!(!kept_before);
    let id: i64 = conn
        .query_row("SELECT id FROM tracks WHERE audio_fp = 'fp3'", [], |r| r.get(0))
        .expect("id");
    keep::add(&conn, &[rule(KeepKind::Playlist, &uid)]).expect("keep");
    assert!(keep::kept_by_playlist(&conn, id).expect("kept"));
    let listed = crate::db::list_playlists(&conn).expect("playlists");
    assert!(listed.iter().any(|p| p.name == "Set" && p.kept));
    keep::remove(&conn, &[rule(KeepKind::Playlist, &uid)]).expect("unkeep");
    assert!(!keep::kept_by_playlist(&conn, id).expect("kept"));
    drop(conn);
    assert_eq!(to_download(&b), Vec::<String>::new());
}
