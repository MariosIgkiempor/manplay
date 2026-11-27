//! Step 7: edge cases. One test per row of `docs/plans/shared-library/07-edge-cases.md` that can
//! be faked here (the rest are named in its "As built" table).

use std::io::Write;

use flate2::Compression;
use flate2::write::GzEncoder;
use rusqlite::params;
use serde_json::json;

use super::{
    Memory, chunks_of, compacted, delete_tag_named, device, everything, my_id, op, playlist, run,
    run_both, shown, smart, smart_shown, started, sync, tag, track, unjoined,
};
use crate::db;
use crate::libsync::clock::{self, Hlc};
use crate::libsync::membership::{self, JoinChoice};
use crate::libsync::remote;
use crate::libsync::{carry, remap, skew};

const YEAR_MS: i64 = 365 * 24 * 3600 * 1000;

fn set_hlc_ahead(db: &std::sync::Mutex<rusqlite::Connection>, ms: i64) {
    let mut hlc = Hlc::default();
    hlc.tick(ms);
    clock::save(&db.lock().expect("lock"), hlc).expect("save");
}

async fn joined_pair(
    store: &Memory,
) -> (
    std::sync::Mutex<rusqlite::Connection>,
    std::sync::Mutex<rusqlite::Connection>,
) {
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

// ---- clocks -----------------------------------------------------------------------

#[test]
fn ops_a_day_ahead_are_held_and_ones_within_ten_minutes_are_not() {
    let conn = super::open();
    let now = clock::now_ms();
    let minute = 60_000;
    let ops = vec![
        op(
            now + 9 * minute,
            "dddddddd",
            "tag",
            "t-ok",
            "name",
            json!("Ok"),
        ),
        op(
            now + 11 * minute,
            "dddddddd",
            "tag",
            "t-late",
            "name",
            json!("Late"),
        ),
        op(
            now + YEAR_MS,
            "dddddddd",
            "tag",
            "t-far",
            "name",
            json!("Far"),
        ),
    ];
    let screened = skew::screen(&conn, ops, now).expect("screen");
    assert_eq!(
        screened.accepted.len(),
        2,
        "the first two chain within ten minutes"
    );
    assert_eq!(screened.held, 1);
    // Held ops are tried again and come due once time has caught up.
    let later = skew::screen(&conn, Vec::new(), now + YEAR_MS).expect("screen");
    assert_eq!(later.accepted.len(), 1);
    assert_eq!(later.held, 0);
}

#[tokio::test]
async fn a_device_whose_clock_is_a_year_ahead_is_held_back_and_told_until_it_is_fixed() {
    let store = Memory::default();
    let (a, b) = joined_pair(&store).await;
    let real = clock::now_ms();
    let wrong = real + YEAR_MS;
    set_hlc_ahead(&a, wrong);
    tag(&a, "Future", &[1]);

    let sent = membership::run_joined_at(&a, &store, "x", wrong).await;
    assert!(sent.error.is_none(), "{:?}", sent.error);
    let got = membership::run_joined_at(&b, &store, "x", real).await;
    assert!(got.error.is_none(), "{:?}", got.error);
    assert!(got.held > 0, "{got:?}");
    assert!(!shown(&b).contains("Future"), "a wrong clock does not win");

    // The holder says so in its member file; the device with the wrong clock reads it.
    let told = membership::run_joined_at(&a, &store, "x", wrong).await;
    assert!(told.clock_wrong, "{told:?}");

    // Its clock is set right: it sends what it wrote again, with times from now.
    let fixed = membership::run_joined_at(&a, &store, "x", real).await;
    assert!(fixed.error.is_none(), "{:?}", fixed.error);
    let got = membership::run_joined_at(&b, &store, "x", real).await;
    assert!(got.error.is_none(), "{:?}", got.error);
    assert!(shown(&b).contains("Future"), "{}", shown(&b));
    assert!(
        skew::skewed_devices(&b.lock().expect("lock"))
            .expect("held")
            .is_empty()
    );

    // One more round and nobody says anything is wrong.
    assert!(
        membership::run_joined_at(&b, &store, "x", real)
            .await
            .error
            .is_none()
    );
    let calm = membership::run_joined_at(&a, &store, "x", real).await;
    assert!(!calm.clock_wrong, "{calm:?}");
    assert_eq!(shown(&a), shown(&b));
}

// ---- cloned device ID -------------------------------------------------------------

#[tokio::test]
async fn a_copied_device_id_is_replaced_and_nothing_is_lost() {
    let store = Memory::default();
    let a = device(3);
    let b = device(3);
    // B is a copy of A's app data: the same ID.
    let a_id = my_id(&a);
    db::set_setting(&b.lock().expect("lock"), "device_id", Some(&a_id)).expect("copy id");
    tag(&a, "Alpha", &[1]);
    tag(&b, "Beta", &[2]);

    sync(&a, &store).await;
    let found = run(&b, &store).await;
    assert!(found.error.is_none(), "{:?}", found.error);
    assert!(found.new_device_id, "{found:?}");
    assert_ne!(my_id(&b), a_id);
    sync(&a, &store).await;

    assert_eq!(shown(&a), shown(&b));
    assert!(
        shown(&a).contains("Beta"),
        "B's edit under its new ID reached A"
    );
    assert!(
        shown(&b).contains("Alpha"),
        "A's chunk is read as another device's"
    );
    assert_eq!(chunks_of(&store, &a_id), vec![1]);
    assert_eq!(chunks_of(&store, &my_id(&b)), vec![1]);
}

#[tokio::test]
async fn an_upload_that_was_never_recorded_is_not_mistaken_for_a_clone() {
    let store = Memory::default();
    let a = device(3);
    tag(&a, "Alpha", &[1]);
    sync(&a, &store).await;
    let id = my_id(&a);
    // The app stopped after the upload, before it wrote that it had.
    {
        let conn = a.lock().expect("lock");
        conn.execute("UPDATE oplog SET uploaded = 0, seq = NULL", [])
            .expect("reset");
        conn.execute("DELETE FROM op_cursor", []).expect("cursor");
        db::set_setting(&conn, "libsync_sent", None).expect("sent");
    }
    let again = run(&a, &store).await;
    assert!(again.error.is_none(), "{:?}", again.error);
    assert!(!again.new_device_id);
    assert_eq!(my_id(&a), id);
    assert_eq!(again.sent, 0, "nothing is sent twice");
    assert_eq!(chunks_of(&store, &id), vec![1]);
}

// ---- half-written files -----------------------------------------------------------

#[test]
fn a_half_written_last_line_and_part_files_are_ignored() {
    assert_eq!(remote::parse_chunk_name("00000012.jsonl.gz.part"), None);
    assert_eq!(remote::parse_chunk_name("00000012.jsonl.gz"), Some(12));
    let good =
        serde_json::to_string(&op(1, "dddddddd", "tag", "t", "name", json!("A"))).expect("json");
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    write!(gz, "{good}\n{{\"v\":1,\"clock\":\"0000").expect("write");
    let (ops, bad) = remote::decode(&gz.finish().expect("finish")).expect("decode");
    assert_eq!(ops.len(), 1);
    assert_eq!(bad, 1, "the cut-off line is counted, not fatal");
}

// ---- mixed versions ---------------------------------------------------------------

fn library_file(store: &Memory) -> membership::LibraryFile {
    serde_json::from_slice(&store.meta.lock().expect("lock")[membership::LIBRARY_FILE])
        .expect("library.json")
}

fn write_library_file(store: &Memory, file: &membership::LibraryFile) {
    store.meta.lock().expect("lock").insert(
        membership::LIBRARY_FILE.to_owned(),
        serde_json::to_vec(file).expect("json"),
    );
}

#[tokio::test]
async fn a_library_of_a_newer_format_is_neither_joined_nor_synced() {
    let store = Memory::default();
    let (a, _) = started(&store).await;
    let mut file = library_file(&store);
    file.format += 1;
    write_library_file(&store, &file);
    let chunks = store.chunks.lock().expect("lock").len();

    let (b, id) = unjoined(3);
    let refused = membership::join(
        &b,
        membership::Home::Target(id),
        &store,
        JoinChoice::Merge,
        "",
    )
    .await;
    assert!(
        refused
            .expect_err("refused")
            .to_string()
            .contains("newer version")
    );
    assert!(!super::is_joined(&b));

    tag(&a, "Late", &[1]);
    let sum = membership::run_joined(&a, &store, "x").await;
    assert!(sum.error.is_some_and(|e| e.contains("newer version")));
    assert_eq!(
        store.chunks.lock().expect("lock").len(),
        chunks,
        "nothing was written"
    );
}

fn reprint(db: &std::sync::Mutex<rusqlite::Connection>) -> Vec<(String, String)> {
    let conn = db.lock().expect("lock");
    conn.execute(
        "UPDATE tracks SET audio_fp = 'fq' || substr(audio_fp, 3)",
        [],
    )
    .expect("reprint");
    (1..=3)
        .map(|n| (format!("fp{n}"), format!("fq{n}")))
        .collect()
}

#[tokio::test]
async fn a_new_audio_fingerprint_is_remapped_and_older_builds_wait() {
    let store = Memory::default();
    let (a, b) = joined_pair(&store).await;
    let now = clock::now_ms();

    // A updates first and re-prints its songs.
    let pairs = reprint(&a);
    remap::remap_tracks(&mut a.lock().expect("lock"), &pairs, 2).expect("remap");
    let sum = membership::run_joined_as(&a, &store, "x", now, 2).await;
    assert!(sum.error.is_none(), "{:?}", sum.error);
    assert_eq!(library_file(&store).audio_fp_version, 2);

    // B still runs the old algorithm: it must not sync, and nothing it has is touched.
    let old = membership::run_joined_as(&b, &store, "x", now, 1).await;
    assert!(old.error.is_some_and(|e| e.contains("Update manplay")));
    // B is updated but has not re-printed yet.
    let waiting = membership::run_joined_as(&b, &store, "x", now, 2).await;
    assert!(
        waiting
            .error
            .is_some_and(|e| e.contains("Scan the library"))
    );

    reprint(&b);
    db::set_setting(
        &b.lock().expect("lock"),
        db::SETTING_AUDIO_FP_VERSION,
        Some("2"),
    )
    .expect("version");
    let ok = membership::run_joined_as(&b, &store, "x", now, 2).await;
    assert!(ok.error.is_none(), "{:?}", ok.error);
    let old_refs: i64 = b
        .lock()
        .expect("lock")
        .query_row(
            "SELECT COUNT(*) FROM op_state WHERE ref LIKE 'fp%'",
            [],
            |r| r.get(0),
        )
        .expect("count");
    assert_eq!(old_refs, 0, "every membership register names the new audio");

    // A device that joins later, already on the new fingerprints, still gets the old edits.
    let (c, id) = unjoined(3);
    reprint(&c);
    db::set_setting(
        &c.lock().expect("lock"),
        db::SETTING_AUDIO_FP_VERSION,
        Some("2"),
    )
    .expect("version");
    let joined = membership::join(
        &c,
        membership::Home::Target(id),
        &store,
        JoinChoice::Merge,
        "",
    )
    .await
    .expect("join");
    assert!(
        joined.error.is_some(),
        "the build here is still on version 1"
    );
    let sum = membership::run_joined_as(&c, &store, "x", now, 2).await;
    assert!(sum.error.is_none(), "{:?}", sum.error);
    assert!(shown(&c).contains("tagged House fq1"), "{}", shown(&c));
}

// ---- two devices writing library.json ---------------------------------------------

#[tokio::test]
async fn two_devices_starting_a_library_at_once_end_up_in_the_one_that_stands() {
    let store = Memory::default();
    let rival = membership::LibraryFile {
        format: 1,
        library_id: "the-other-one".into(),
        name: "Theirs".into(),
        created_at: 1,
        audio_fp_version: 1,
    };
    *store.rival_library.lock().expect("lock") = Some(serde_json::to_vec(&rival).expect("json"));
    let (a, id) = unjoined(3);
    let sum = membership::join(
        &a,
        membership::Home::Target(id),
        &store,
        JoinChoice::Start,
        "Ours",
    )
    .await
    .expect("start");
    assert!(sum.error.is_none(), "{:?}", sum.error);
    let conn = a.lock().expect("lock");
    assert_eq!(
        db::get_setting(&conn, "library_id").expect("id").as_deref(),
        Some("the-other-one"),
        "the last write stands for everyone"
    );
}

// ---- identity ---------------------------------------------------------------------

fn add_track(db: &std::sync::Mutex<rusqlite::Connection>, path: &str, fp: &str) -> i64 {
    let conn = db.lock().expect("lock");
    conn.execute(
        "INSERT INTO tracks (path, artist, album, title, size, audio_fp)
         VALUES (?1, 'a', 'b', 'new', 1, ?2)",
        params![path, fp],
    )
    .expect("track");
    conn.last_insert_rowid()
}

#[tokio::test]
async fn a_re_encoded_song_can_take_its_tags_playlists_and_tempo_along() {
    let store = Memory::default();
    let a = device(3);
    let b = device(3);
    add_track(&a, "/music/1.flac", "fpN");
    add_track(&b, "/music/1.flac", "fpN");
    tag(&a, "House", &[1]);
    playlist(&a, "Warmup", &[1, 2]);
    {
        let id = track(&a, 1);
        let conn = a.lock().expect("lock");
        db::set_tempo_key(&conn, id, Some(Some(128.0)), Some(Some("Am"))).expect("tempo");
    }
    sync(&a, &store).await;
    sync(&b, &store).await;

    // The MP3 is gone and a FLAC of the same name is there.
    a.lock()
        .expect("lock")
        .execute(
            "UPDATE tracks SET missing_since = 1 WHERE audio_fp = 'fp1'",
            [],
        )
        .expect("missing");
    let found = carry::candidates(&a.lock().expect("lock")).expect("candidates");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].old_fp, "fp1");
    assert_eq!(found[0].old_path.as_deref(), Some("/music/1.mp3"));
    assert_eq!(
        (found[0].tags, found[0].playlists, found[0].edits),
        (1, 1, true)
    );

    let done =
        carry::carry_over(&mut a.lock().expect("lock"), "fp1", found[0].track_id).expect("carry");
    assert_eq!((done.tags, done.playlists), (1, 1));
    assert_eq!(
        carry::candidates(&a.lock().expect("lock"))
            .expect("again")
            .len(),
        0
    );

    sync(&a, &store).await;
    sync(&b, &store).await;
    let text = shown(&b);
    assert!(text.contains("tagged House fpN"), "{text}");
    assert!(!text.contains("tagged House fp1"), "{text}");
    assert!(
        text.contains("Warmup [fpN,fp2]"),
        "the song keeps its place: {text}"
    );
    let (bpm, key, edited): (Option<f64>, Option<String>, bool) = b
        .lock()
        .expect("lock")
        .query_row(
            "SELECT bpm, musical_key, bpm_edited FROM analysis WHERE audio_fp = 'fpN'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("analysis");
    assert_eq!(
        (bpm, key.as_deref(), edited),
        (Some(128.0), Some("Am"), true)
    );
    assert_eq!(shown(&a), shown(&b));
}

#[test]
fn audio_replaced_in_place_is_noticed_and_can_be_declined() {
    let mut conn = super::open();
    let mut first = crate::db::NewTrack {
        path: "/music/x.mp3".into(),
        artist: "a".into(),
        album: "b".into(),
        title: "x".into(),
        size: 1,
        audio_fp: Some("old".into()),
        ..crate::db::NewTrack::default()
    };
    db::upsert(&mut conn, std::slice::from_ref(&first)).expect("first");
    let id: i64 = conn
        .query_row("SELECT id FROM tracks", [], |r| r.get(0))
        .expect("id");
    db::tag_tracks(&mut conn, "House", &[id]).expect("tag");
    assert_eq!(carry::candidates(&conn).expect("none").len(), 0);

    first.audio_fp = Some("new".into());
    db::upsert(&mut conn, &[first]).expect("re-encoded");
    let found = carry::candidates(&conn).expect("found");
    assert_eq!(found.len(), 1);
    assert_eq!(
        (found[0].old_fp.as_str(), found[0].old_path.as_deref()),
        ("old", None)
    );

    carry::dismiss(&conn, "old").expect("dismiss");
    assert_eq!(carry::candidates(&conn).expect("none").len(), 0);
}

// ---- rules and selections ---------------------------------------------------------

#[tokio::test]
async fn a_tag_deleted_elsewhere_leaves_no_unknown_tag_in_smart_playlists() {
    let store = Memory::default();
    let a = device(3);
    let b = device(3);
    tag(&a, "Gone", &[1]);
    tag(&a, "Kept", &[1]);
    smart(&a, "Mix", &["Gone", "Kept"]);
    sync(&a, &store).await;
    sync(&b, &store).await;
    assert!(smart_shown(&b).contains("\"Gone\""), "{}", smart_shown(&b));

    delete_tag_named(&b, "Gone");
    sync(&b, &store).await;
    sync(&a, &store).await;
    for text in [smart_shown(&a), smart_shown(&b)] {
        assert!(!text.contains('?'), "{text}");
        assert!(text.contains("Kept") && !text.contains("Gone"), "{text}");
    }
    assert_eq!(everything(&a), everything(&b));
}

// ---- gaps from earlier steps ------------------------------------------------------

#[tokio::test]
async fn the_local_log_forgets_what_a_snapshot_holds() {
    let store = Memory::default();
    let a = device(4);
    tag(&a, "House", &[1, 2]);
    sync(&a, &store).await;
    let before: i64 = a
        .lock()
        .expect("lock")
        .query_row("SELECT COUNT(*) FROM oplog WHERE uploaded = 1", [], |r| {
            r.get(0)
        })
        .expect("count");
    assert!(before > 0);
    let out = compacted(&a, &store, 1).await;
    assert!(out.snapshot.is_some());
    assert_eq!(i64::try_from(out.ops_pruned).expect("fits"), before);
    // Nothing is lost: the snapshot rebuilds a new device.
    let b = device(4);
    sync(&b, &store).await;
    assert_eq!(shown(&a), shown(&b));
}

// ---- semantics ---------------------------------------------------------------------

#[tokio::test]
async fn a_child_added_under_a_renamed_parent_is_kept_as_a_tag_of_its_own() {
    let store = Memory::default();
    let a = device(3);
    let b = device(3);
    tag(&a, "Genre/House", &[1]);
    sync(&a, &store).await;
    sync(&b, &store).await;
    // A renames the parent while B adds a child under the old name.
    db::migrate_tags(
        &mut a.lock().expect("lock"),
        &["Genre".to_owned()],
        Some("Style"),
    )
    .expect("rename");
    tag(&b, "Genre/House/Deep", &[2]);
    sync(&a, &store).await;
    sync(&b, &store).await;
    sync(&a, &store).await;
    let text = shown(&a);
    assert!(
        text.contains("tagged Genre/House/Deep fp2"),
        "not lost: {text}"
    );
    assert!(text.contains("tagged Style/House fp1"), "{text}");
    assert_eq!(shown(&a), shown(&b));
}

#[tokio::test]
async fn a_shared_tag_under_a_private_parent_stays_private() {
    let a = device(3);
    {
        let mut conn = a.lock().expect("lock");
        db::create_tag(&mut conn, "Genre", Some("local")).expect("parent");
        db::create_tag(&mut conn, "Genre/House", Some("shared")).expect("child");
        db::create_tag(&mut conn, "Mood/Calm", Some("shared")).expect("shared pair");
    }
    let conn = a.lock().expect("lock");
    let scope = |name: &str| -> String {
        conn.query_row("SELECT scope FROM tags WHERE name = ?1", [name], |r| {
            r.get(0)
        })
        .expect("tag")
    };
    assert_eq!(scope("Genre/House"), "local");
    assert_eq!(scope("Mood"), "shared");
    assert_eq!(scope("Mood/Calm"), "shared");
}

#[test]
fn nothing_is_removed_for_being_old_while_the_clock_may_be_wrong() {
    const HOUR: i64 = 60 * 60 * 1000;
    const DAY: i64 = 24 * HOUR;
    let start = 1_700_000_000_000_i64;
    // (what happens, the device's time, whether others say its clock is wrong, may old things go)
    let steps = [
        ("the first look", start, false, true),
        ("an hour on", start + HOUR, false, true),
        ("time steps 40 days ahead", start + 40 * DAY, false, false),
        (
            "still within a day of the step",
            start + 40 * DAY + 23 * HOUR,
            false,
            false,
        ),
        ("a day after the step", start + 41 * DAY + HOUR, false, true),
        ("another step ahead", start + 90 * DAY, false, false),
        (
            "the clock is put back",
            start + 41 * DAY + 2 * HOUR,
            false,
            true,
        ),
        (
            "others say the clock is wrong",
            start + 41 * DAY + 3 * HOUR,
            true,
            false,
        ),
        (
            "and then that it is right",
            start + 41 * DAY + 4 * HOUR,
            false,
            true,
        ),
    ];
    let conn = super::open();
    for (what, now_ms, said_wrong, may) in steps {
        crate::libsync::skew::set_clock_wrong(&conn, said_wrong).expect("set");
        assert_eq!(
            crate::libsync::skew::old_things_may_go(&conn, now_ms).expect("ask"),
            may,
            "{what}"
        );
    }
}
