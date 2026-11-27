//! The songs this device streams, as rows built from the log (`streamed.rs`).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, params};

use super::{Memory, device, run_both, tag};
use crate::db::FileState;
use crate::libsync::files::{self, UnixSeconds};
use crate::libsync::keep::{self, KeepKind, KeepRule};
use crate::libsync::song_tags::{self, Fields};
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
    streamed::refresh(&lock(db), Path::new(ROOT), &backups()).expect("refresh")
}

fn backups() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("manplay-streamed-backups-{}", std::process::id()))
}

fn backups_named(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "manplay-streamed-backups-{}-{}",
        std::process::id(),
        name.replace(|c: char| !c.is_ascii_alphanumeric(), "_")
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
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
async fn a_streamed_row_stays_when_the_song_is_removed_or_the_library_left_and_folds_into_a_kept_one()
 {
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
            what: "removed by the device that had it: it waits for a review",
            on_a: "UPDATE tracks SET missing_since = 0 WHERE audio_fp = ?1",
            on_b: nothing,
            rows_left: 3,
            state_left: Some(FileState::Streamed),
        },
        Case {
            what: "kept here: its file was downloaded and read",
            on_a: nothing,
            on_b: "UPDATE tracks SET file_state = 'here' WHERE audio_fp = ?1",
            rows_left: 3,
            state_left: Some(FileState::Here),
        },
        Case {
            what: "the shared library was left: the rows stay as unplayable songs",
            on_a: nothing,
            on_b: "UPDATE sync_targets SET libsync = 0 WHERE ?1 IS NOT NULL",
            rows_left: 3,
            state_left: Some(FileState::Streamed),
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

/// `b` streams song 3, which is in the playlist "Set" and the tag "Warmup".
async fn streamed_in_a_playlist_and_a_tag(
    store: &Memory,
) -> (Mutex<Connection>, Mutex<Connection>) {
    let (a, b) = one_more(store).await;
    super::playlist(&a, "Set", &[1, 3]);
    tag(&a, "Warmup", &[3]);
    assert!(run_both(&a, &b, store).await);
    assert_eq!(refresh(&b).added, 1);
    (a, b)
}

fn memberships_of_song_3(db: &Mutex<Connection>) -> Vec<(String, String, String)> {
    let conn = lock(db);
    let mut out: Vec<(String, String, String)> = conn
        .prepare(
            "SELECT t.path, p.name, 'playlist' FROM playlist_tracks pt
             JOIN tracks t ON t.id = pt.track_id JOIN playlists p ON p.id = pt.playlist_id
             WHERE t.audio_fp = 'fp3'
             UNION ALL
             SELECT t.path, g.name, 'tag' FROM track_tags tt
             JOIN tracks t ON t.id = tt.track_id JOIN tags g ON g.id = tt.tag_id
             WHERE t.audio_fp = 'fp3'
             ORDER BY 1, 2, 3",
        )
        .expect("prepare")
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .expect("rows")
        .map(|r| r.expect("row"))
        .collect();
    out.sort();
    out
}

#[tokio::test]
async fn a_streamed_row_of_a_song_kept_elsewhere_hands_its_playlists_and_tags_to_the_kept_row() {
    for (what, kept_is_in_the_playlist) in [
        ("the kept row is in neither", false),
        ("the kept row is in the playlist already", true),
    ] {
        let store = Memory::default();
        let (_a, b) = streamed_in_a_playlist_and_a_tag(&store).await;
        let conn = lock(&b);
        conn.execute(
            "INSERT INTO tracks (path, artist, album, title, size, audio_fp, added_at)
             VALUES ('/music/Other/3.mp3', 'a', 'b', 'kept', 1, 'fp3', 0)",
            [],
        )
        .expect("kept row");
        if kept_is_in_the_playlist {
            conn.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, position)
                 SELECT p.id, t.id, 9 FROM playlists p, tracks t
                 WHERE p.name = 'Set' AND t.path = '/music/Other/3.mp3'",
                [],
            )
            .expect("membership");
        }
        drop(conn);
        let dir = backups_named(what);
        let refreshed = streamed::refresh(&lock(&b), Path::new(ROOT), &dir).expect("refresh");
        assert_eq!(refreshed.removed, 1, "{what}");
        assert_eq!(
            memberships_of_song_3(&b),
            [
                (
                    "/music/Other/3.mp3".to_owned(),
                    "Set".to_owned(),
                    "playlist".to_owned()
                ),
                (
                    "/music/Other/3.mp3".to_owned(),
                    "Warmup".to_owned(),
                    "tag".to_owned()
                ),
            ],
            "{what}"
        );
        assert_eq!(
            lock(&b)
                .query_row(
                    "SELECT COUNT(*) FROM tracks WHERE audio_fp = 'fp3' AND file_state = 'streamed'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .expect("count"),
            0,
            "{what}"
        );
        assert_eq!(
            std::fs::read_dir(&dir).expect("backups").count(),
            1,
            "{what}"
        );
    }
}

#[tokio::test]
async fn a_streamed_song_another_device_removed_is_listed_for_review_and_applying_it_saves_a_copy()
{
    let store = Memory::default();
    let (a, b) = one_more(&store).await;
    super::playlist(&a, "Set", &[3]);
    assert!(run_both(&a, &b, &store).await);
    refresh(&b);
    sql(
        &a,
        "UPDATE tracks SET missing_since = 0 WHERE audio_fp = ?1",
        3,
    );
    record(&a);
    assert!(run_both(&a, &b, &store).await);
    refresh(&b);

    let waiting = files::removals_waiting(&lock(&b), Path::new(ROOT)).expect("waiting");
    assert_eq!(waiting.len(), 1);
    assert!(waiting[0].streamed);
    assert_eq!(waiting[0].audio_fp, "fp3");
    assert_eq!(rows(&b), 3, "nothing is removed before someone decides");

    let dir = backups_named("apply-streamed-removal");
    let removed = streamed::remove(&lock(&b), Some(&["fp3".to_owned()]), &dir).expect("apply");
    assert_eq!(removed, 1);
    assert_eq!(rows(&b), 2);
    assert_eq!(
        std::fs::read_dir(&dir).expect("backups").count(),
        1,
        "a copy first"
    );
    assert_eq!(
        files::removals_waiting(&lock(&b), Path::new(ROOT))
            .expect("waiting")
            .len(),
        0
    );
}

#[tokio::test]
async fn keeping_a_streamed_song_another_device_removed_makes_it_present_again() {
    let store = Memory::default();
    let (a, b) = one_more(&store).await;
    refresh(&b);
    sql(
        &a,
        "UPDATE tracks SET missing_since = 0 WHERE audio_fp = ?1",
        3,
    );
    record(&a);
    assert!(run_both(&a, &b, &store).await);
    refresh(&b);
    let kept = files::keep(&lock(&b), Path::new(ROOT), &["fp3".to_owned()]).expect("keep");
    assert_eq!(kept, 1);
    assert_eq!(
        files::removals_waiting(&lock(&b), Path::new(ROOT))
            .expect("waiting")
            .len(),
        0
    );
    assert_eq!(row(&b, 3).map(|r| r.5), Some(FileState::Streamed));
    assert!(run_both(&a, &b, &store).await);
    assert_eq!(
        refresh(&b),
        Refreshed::default(),
        "it is wanted again, as it was"
    );
}

#[tokio::test]
async fn removing_streamed_songs_saves_a_copy_first_and_takes_only_the_songs_asked_for() {
    let cases: [(&str, Option<&[&str]>, usize, i64); 3] = [
        ("every streamed song", None, 2, 2),
        ("one of them", Some(&["fp3"]), 1, 3),
        ("a song that is not streamed", Some(&["fp1"]), 0, 4),
    ];
    for (what, asked, removed, rows_left) in cases {
        let store = Memory::default();
        let (_a, b) = one_more(&store).await;
        refresh(&b);
        lock(&b)
            .execute(
                "INSERT INTO tracks (path, artist, album, title, size, audio_fp, file_state, added_at)
                 VALUES ('/music/x.mp3', 'a', 'b', 'x', 1, 'fpx', 'streamed', 0)",
                [],
            )
            .expect("second streamed row");
        let dir = backups_named(what);
        let asked: Option<Vec<String>> =
            asked.map(|fps| fps.iter().map(|fp| (*fp).to_owned()).collect());
        let gone = streamed::remove(&lock(&b), asked.as_deref(), &dir).expect("remove");
        assert_eq!(gone, removed, "{what}");
        assert_eq!(rows(&b), rows_left, "{what}");
        let copies = std::fs::read_dir(&dir).map_or(0, Iterator::count);
        assert_eq!(copies, usize::from(removed > 0), "{what}");
    }
}

#[tokio::test]
async fn a_streamed_song_is_not_added_where_a_file_is_already() {
    let store = Memory::default();
    let (_a, b) = one_more(&store).await;
    let root = std::env::temp_dir().join(format!("manplay-streamed-root-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("Artist/Album")).expect("folders");
    std::fs::write(root.join("Artist/Album/3.mp3"), b"not scanned yet").expect("file");
    let refreshed = streamed::refresh(&lock(&b), &root, &backups()).expect("refresh");
    assert_eq!(refreshed.added, 0, "the scan will find that file");
    assert_eq!(rows(&b), 2);
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
        .map(|song| song.path.parts().join("/"))
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
        .query_row("SELECT id FROM tracks WHERE audio_fp = 'fp3'", [], |r| {
            r.get(0)
        })
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

#[tokio::test]
async fn a_tag_edit_on_a_streamed_song_goes_to_the_log_and_the_row_and_reaches_the_device_with_the_file()
 {
    let store = Memory::default();
    let (a, b) = one_more(&store).await;
    refresh(&b);
    let edits: std::collections::BTreeMap<String, String> = [
        ("title", "Night Drive (VIP)"),
        ("genre", "House;  Deep House"),
        ("bpm", "124"),
    ]
    .into_iter()
    .map(|(f, v)| (f.to_owned(), v.to_owned()))
    .collect();
    let left_out = song_tags::edit_streamed(&lock(&b), "fp3", &edits).expect("edit");
    assert_eq!(left_out, ["bpm"], "BPM is the analysis's, not a shared tag");
    let values = song_tags::streamed_values(&lock(&b), "fp3").expect("values");
    assert_eq!(
        values.get("title").cloned().flatten().as_deref(),
        Some("Night Drive (VIP)")
    );
    assert_eq!(
        values.get("genre").cloned().flatten().as_deref(),
        Some("House; Deep House"),
        "stored the way a file would hold it"
    );
    assert_eq!(values.get("bpm").cloned().flatten(), None);
    assert_eq!(refresh(&b).updated, 1);
    assert_eq!(
        row(&b, 3).map(|r| r.3).as_deref(),
        Some("Night Drive (VIP)")
    );

    assert!(run_both(&a, &b, &store).await);
    let wanted = song_tags::wanted(&lock(&a), Path::new(ROOT)).expect("wanted");
    assert!(
        wanted
            .iter()
            .any(|w| w.edits.get("title").map(String::as_str) == Some("Night Drive (VIP)")),
        "the device with the file is to write it in"
    );
}

#[tokio::test]
async fn a_cover_set_on_a_streamed_song_is_named_in_the_log_for_the_device_with_the_file() {
    let store = Memory::default();
    let (a, b) = one_more(&store).await;
    refresh(&b);
    let name =
        crate::tags::CoverBackupName::of_image(&crate::tags::tests::picture(42)).expect("name");
    song_tags::set_streamed_cover(&lock(&b), "fp3", &name).expect("cover");
    assert_eq!(
        song_tags::cover_of(&lock(&b), "fp3").expect("cover"),
        Some(name.clone())
    );
    assert!(run_both(&a, &b, &store).await);
    let wanted = song_tags::wanted(&lock(&a), Path::new(ROOT)).expect("wanted");
    assert!(
        wanted.iter().any(|w| w.cover().as_ref() == Some(&name)),
        "the device with the file is to put the picture in"
    );
}
