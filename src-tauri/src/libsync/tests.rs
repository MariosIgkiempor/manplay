#![allow(clippy::expect_used)] // test fixtures: panicking is the failure mode

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::apply::{apply_ops, materialize_pending};
use super::clock::{self, Hlc};
use super::frac;
use super::ops::{FORMAT, Op};
use super::remote::{self, ChunkRef, ChunkStore};
use super::{run, seed, state};
use crate::db;
use crate::error::Error;

const DEV_A: &str = "aaaaaaaa";
const DEV_B: &str = "bbbbbbbb";

fn open() -> Connection {
    db::open(Path::new(":memory:")).expect("open")
}

/// A library with songs `s1..sN`, each with its own `audio_fp` (`fp1..fpN`); returns track ids.
fn library(conn: &Connection, n: usize) -> Vec<i64> {
    (1..=n)
        .map(|i| {
            conn.execute(
                "INSERT INTO tracks (path, artist, album, title, size, audio_fp)
                 VALUES (?1, 'a', 'b', ?2, 1, ?3)",
                params![format!("/music/{i}.mp3"), format!("s{i}"), format!("fp{i}")],
            )
            .expect("track");
            conn.last_insert_rowid()
        })
        .collect()
}

/// A destination that shares library data.
fn share(conn: &mut Connection) {
    conn.execute(
        "INSERT INTO sync_targets (tailnet, machine, path) VALUES ('t', 'm', '[]')",
        [],
    )
    .expect("target");
    let id = conn.last_insert_rowid();
    db::set_target_libsync(conn, id, true).expect("enable");
}

fn op(clock_ms: i64, dev: &str, e: &str, id: &str, f: &str, val: Value) -> Op {
    Op {
        v: FORMAT,
        clock: clock::format(clock_ms, 0, dev),
        dev: dev.to_owned(),
        e: e.to_owned(),
        id: id.to_owned(),
        f: f.to_owned(),
        val,
    }
}

/// Everything shared, as content (no row ids): tags by uid, memberships by name and audio.
fn dump(conn: &Connection) -> String {
    let mut out = Vec::new();
    let mut stmt = conn
        .prepare("SELECT uid, name, scope FROM tags ORDER BY uid")
        .expect("tags");
    for r in stmt
        .query_map([], |r| {
            Ok(format!(
                "tag {} {} {}",
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?
            ))
        })
        .expect("rows")
    {
        out.push(r.expect("row"));
    }
    let mut stmt = conn
        .prepare(
            "SELECT g.name, t.audio_fp FROM track_tags tt JOIN tags g ON g.id = tt.tag_id
             JOIN tracks t ON t.id = tt.track_id ORDER BY g.name, t.audio_fp",
        )
        .expect("members");
    for r in stmt
        .query_map([], |r| {
            Ok(format!(
                "tagged {} {}",
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?
            ))
        })
        .expect("rows")
    {
        out.push(r.expect("row"));
    }
    let mut stmt = conn
        .prepare("SELECT id, uid, name FROM playlists ORDER BY uid")
        .expect("playlists");
    let lists: Vec<(i64, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .expect("rows")
        .map(|r| r.expect("row"))
        .collect();
    for (id, uid, name) in lists {
        let fps: Vec<String> = conn
            .prepare(
                "SELECT t.audio_fp FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                 WHERE pt.playlist_id = ?1 ORDER BY pt.position",
            )
            .expect("order")
            .query_map(params![id], |r| r.get(0))
            .expect("rows")
            .map(|r| r.expect("row"))
            .collect();
        out.push(format!("playlist {uid} {name} [{}]", fps.join(",")));
    }
    out.join("\n")
}

/// Deterministic shuffle (Fisher-Yates over a small LCG).
fn shuffled<T: Clone>(items: &[T], mut seed: u64) -> Vec<T> {
    let mut v = items.to_vec();
    for i in (1..v.len()).rev() {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let j = usize::try_from(seed >> 33).expect("usize") % (i + 1);
        v.swap(i, j);
    }
    v
}

fn replay(ops: &[Op]) -> String {
    let mut conn = open();
    library(&conn, 4);
    let tx = conn.transaction().expect("tx");
    apply_ops(&tx, ops).expect("apply");
    tx.commit().expect("commit");
    dump(&conn)
}

fn sample_ops() -> Vec<Op> {
    vec![
        op(10, DEV_A, "tag", "t-house", "name", json!("Genre/House")),
        op(11, DEV_A, "tag", "t-genre", "name", json!("Genre")),
        op(
            12,
            DEV_B,
            "tag",
            "t-house",
            "name",
            json!("Genre/Deep House"),
        ),
        op(
            13,
            DEV_A,
            "track_tag",
            "t-house/fp1",
            "present",
            json!(true),
        ),
        op(
            14,
            DEV_B,
            "track_tag",
            "t-house/fp2",
            "present",
            json!(true),
        ),
        op(
            15,
            DEV_A,
            "track_tag",
            "t-house/fp2",
            "present",
            json!(false),
        ),
        op(16, DEV_A, "tag", "t-old", "name", json!("Old")),
        op(17, DEV_A, "track_tag", "t-old/fp3", "present", json!(true)),
        op(18, DEV_B, "tag", "t-old", "_delete", Value::Null),
        op(19, DEV_A, "tag", "t-old", "name", json!("Older")),
        op(20, DEV_A, "playlist", "p-1", "name", json!("Warmup")),
        op(
            21,
            DEV_A,
            "playlist_track",
            "p-1/fp3",
            "present",
            json!(true),
        ),
        op(22, DEV_A, "playlist_track", "p-1/fp3", "pos", json!("V")),
        op(
            23,
            DEV_B,
            "playlist_track",
            "p-1/fp1",
            "present",
            json!(true),
        ),
        op(24, DEV_B, "playlist_track", "p-1/fp1", "pos", json!("k")),
        op(
            25,
            DEV_A,
            "playlist_track",
            "p-1/fp2",
            "present",
            json!(true),
        ),
        op(26, DEV_A, "playlist_track", "p-1/fp2", "pos", json!("k")),
        op(
            27,
            DEV_A,
            "playlist_track",
            "p-1/fp9",
            "present",
            json!(true),
        ),
        op(28, DEV_A, "playlist_track", "p-1/fp9", "pos", json!("A")),
        op(29, DEV_A, "playlist", "p-2", "name", json!("Gone")),
        op(30, DEV_B, "playlist", "p-2", "_delete", Value::Null),
        op(31, DEV_A, "weird", "x", "f", json!(1)),
    ]
}

#[test]
fn apply_is_order_independent() {
    let ops = sample_ops();
    let expected = replay(&ops);
    for seed in 1..40 {
        assert_eq!(replay(&shuffled(&ops, seed)), expected, "seed {seed}");
    }
    // Sanity: the shared result is what the rules say.
    assert!(expected.contains("Genre/Deep House"), "{expected}");
    assert!(
        !expected.contains("Older"),
        "deleted tag stays deleted: {expected}"
    );
    assert!(!expected.contains("Gone"), "{expected}");
    // fp1 and fp2 tie on "k": ordered by audio_fp, after "V" (fp3); "A" (fp9) is not in the library.
    assert!(expected.contains("[fp3,fp1,fp2]"), "{expected}");
    assert!(
        expected.contains("tagged Genre/Deep House fp1"),
        "{expected}"
    );
    assert!(
        !expected.contains("tagged Genre/Deep House fp2"),
        "{expected}"
    );
}

#[test]
fn last_writer_wins_per_field() {
    let mut conn = open();
    library(&conn, 1);
    let newer = op(20, DEV_B, "playlist", "p", "name", json!("New"));
    let older = op(10, DEV_A, "playlist", "p", "name", json!("Old"));
    let tx = conn.transaction().expect("tx");
    assert_eq!(
        apply_ops(&tx, std::slice::from_ref(&newer)).expect("apply"),
        1
    );
    assert_eq!(
        apply_ops(&tx, &[older]).expect("apply"),
        0,
        "older op loses"
    );
    assert_eq!(
        apply_ops(&tx, &[newer]).expect("apply"),
        0,
        "replays are no-ops"
    );
    tx.commit().expect("commit");
    assert!(dump(&conn).contains("playlist p New"));
}

#[test]
fn same_millisecond_ties_break_on_counter_then_device() {
    let a = clock::format(5, 0, DEV_A);
    let b = clock::format(5, 1, DEV_A);
    let c = clock::format(5, 1, DEV_B);
    assert!(a < b && b < c);
}

#[test]
fn delete_beats_concurrent_and_later_edits() {
    let tombstone = op(20, DEV_A, "tag", "t", "_delete", Value::Null);
    let before = op(10, DEV_B, "tag", "t", "name", json!("Early"));
    let after = op(30, DEV_B, "tag", "t", "name", json!("Late"));
    for order in [
        vec![before.clone(), tombstone.clone(), after.clone()],
        vec![after.clone(), tombstone.clone(), before.clone()],
        vec![tombstone, before, after],
    ] {
        assert_eq!(replay(&order), "", "no tag survives");
    }
}

#[test]
fn memberships_wait_for_songs_that_arrive_later() {
    let mut conn = open();
    let ops = vec![
        op(10, DEV_A, "tag", "t", "name", json!("Peak")),
        op(11, DEV_A, "track_tag", "t/fp7", "present", json!(true)),
        op(12, DEV_A, "playlist", "p", "name", json!("Set")),
        op(13, DEV_A, "playlist_track", "p/fp7", "present", json!(true)),
        op(14, DEV_A, "playlist_track", "p/fp7", "pos", json!("V")),
    ];
    let tx = conn.transaction().expect("tx");
    apply_ops(&tx, &ops).expect("apply");
    tx.commit().expect("commit");
    assert!(!dump(&conn).contains("fp7"));
    assert_eq!(materialize_pending(&mut conn).expect("pending"), 0);

    conn.execute(
        "INSERT INTO tracks (path, artist, album, title, size, audio_fp)
         VALUES ('/new.mp3', 'a', 'b', 'new', 1, 'fp7')",
        [],
    )
    .expect("track");
    assert_eq!(materialize_pending(&mut conn).expect("pending"), 2);
    let shown = dump(&conn);
    assert!(shown.contains("tagged Peak fp7"), "{shown}");
    assert!(shown.contains("playlist p Set [fp7]"), "{shown}");
    assert_eq!(
        materialize_pending(&mut conn).expect("pending"),
        0,
        "done once"
    );
}

#[test]
fn unknown_entities_are_kept_and_newer_formats_set_aside() {
    let mut conn = open();
    let future = Op {
        v: FORMAT + 1,
        ..op(40, DEV_B, "tag", "t", "name", json!("Future"))
    };
    let tx = conn.transaction().expect("tx");
    apply_ops(
        &tx,
        &[
            op(10, DEV_A, "smart_playlist", "s", "rules", json!({})),
            future,
        ],
    )
    .expect("apply");
    tx.commit().expect("commit");
    assert_eq!(
        state::get(&conn, "smart_playlist", "s", "rules").expect("get"),
        Some(json!({}))
    );
    let kept: i64 = conn
        .query_row("SELECT COUNT(*) FROM op_unknown", [], |r| r.get(0))
        .expect("count");
    assert_eq!(kept, 1);
    assert_eq!(dump(&conn), "", "neither touches the tables");
}

#[test]
fn name_clash_merges_into_the_lowest_uid() {
    let a = [
        op(10, DEV_A, "tag", "u-2", "name", json!("House")),
        op(11, DEV_A, "track_tag", "u-2/fp1", "present", json!(true)),
    ];
    let b = vec![
        op(12, DEV_B, "tag", "u-1", "name", json!("house")),
        op(13, DEV_B, "track_tag", "u-1/fp2", "present", json!(true)),
    ];
    let both: Vec<Op> = a.iter().chain(&b).cloned().collect();
    let expected = replay(&both);
    assert_eq!(expected.matches("tag u-").count(), 1, "{expected}");
    assert!(expected.contains("tag u-1 house"), "{expected}");
    assert!(expected.contains("tagged house fp1"), "{expected}");
    assert!(expected.contains("tagged house fp2"), "{expected}");
    for seed in 1..20 {
        assert_eq!(replay(&shuffled(&both, seed)), expected, "seed {seed}");
    }
}

#[test]
fn clocks_never_go_back() {
    let mut hlc = Hlc::default();
    assert_eq!(hlc.tick(100), (100, 0));
    assert_eq!(hlc.tick(100), (100, 1), "same millisecond: counter");
    assert_eq!(hlc.tick(90), (100, 2), "wall clock went back");
    hlc.observe(&clock::format(500, 7, DEV_B));
    assert_eq!(hlc.tick(120), (500, 8), "after an op from the future");
    let mut full = Hlc::default();
    full.tick(1);
    let last = (0..10_000).map(|_| full.tick(1)).last().expect("ticks");
    assert_eq!(
        last,
        (2, 0),
        "counter overflow moves to the next millisecond"
    );
}

#[test]
fn fractional_index_always_fits_between() {
    // Insert at pseudo-random places; the keys must stay strictly ordered and never collide.
    let mut keys: Vec<String> = Vec::new();
    let mut seed = 7_u64;
    for _ in 0..600 {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let at = usize::try_from(seed >> 33).expect("usize") % (keys.len() + 1);
        let before = at.checked_sub(1).map(|i| keys[i].as_str());
        let after = keys.get(at).map(String::as_str);
        let key = frac::between(before, after);
        assert!(
            before.is_none_or(|b| b < key.as_str()),
            "{before:?} < {key}"
        );
        assert!(after.is_none_or(|a| key.as_str() < a), "{key} < {after:?}");
        assert!(!key.ends_with('0'));
        keys.insert(at, key);
    }
    // The hard cases: always at the front, always at the end, always in the same gap.
    let mut front = vec!["V".to_owned()];
    let mut back = vec!["V".to_owned()];
    let mut gap = ["V".to_owned(), "W".to_owned()];
    for _ in 0..200 {
        front.insert(0, frac::between(None, Some(&front[0])));
        back.push(frac::between(back.last().map(String::as_str), None));
        let mid = frac::between(Some(&gap[0]), Some(&gap[1]));
        assert!(gap[0] < mid && mid < gap[1]);
        gap[1] = mid;
    }
    assert!(front.windows(2).all(|w| w[0] < w[1]));
    assert!(back.windows(2).all(|w| w[0] < w[1]));
    let many = frac::spread(None, None, 5000);
    assert!(many.windows(2).all(|w| w[0] < w[1]));
    assert!(many.iter().all(|k| k.len() <= 4), "spread keeps keys short");
}

#[test]
fn chunks_round_trip_and_keep_what_they_do_not_understand() {
    let ops = vec![
        op(1, DEV_A, "tag", "t", "name", json!("A")),
        op(
            2,
            DEV_A,
            "from_the_future",
            "x",
            "y",
            json!({"deep": [1, 2]}),
        ),
    ];
    let mut bytes = remote::encode(&ops).expect("encode");
    let (back, bad) = remote::decode(&bytes).expect("decode");
    assert_eq!((back, bad), (ops, 0));
    assert_eq!(remote::parse_chunk_name(&remote::chunk_name(12)), Some(12));
    assert_eq!(remote::parse_chunk_name("00000012.jsonl.gz.part"), None);
    bytes.truncate(bytes.len() / 2);
    assert!(
        remote::decode(&bytes).is_err(),
        "a cut chunk is an error, not silence"
    );
}

// ---- two devices -------------------------------------------------------------

#[derive(Default)]
struct Memory(Mutex<BTreeMap<ChunkRef, Vec<u8>>>);

#[allow(clippy::unused_async_trait_impl)] // the trait is async; memory never waits
impl ChunkStore for Memory {
    async fn list_chunks(&self) -> Result<Vec<ChunkRef>, Error> {
        Ok(self.0.lock().expect("lock").keys().cloned().collect())
    }

    async fn read_chunk(&self, chunk: &ChunkRef) -> Result<Vec<u8>, Error> {
        self.0
            .lock()
            .expect("lock")
            .get(chunk)
            .cloned()
            .ok_or_else(|| Error::Msg("no such chunk".into()))
    }

    async fn write_chunk(&self, chunk: &ChunkRef, bytes: Vec<u8>) -> Result<(), Error> {
        let mut chunks = self.0.lock().expect("lock");
        if chunks.contains_key(chunk) {
            return Err(Error::Msg("exists".into()));
        }
        chunks.insert(chunk.clone(), bytes);
        Ok(())
    }
}

fn device(songs: usize) -> Mutex<Connection> {
    let mut conn = open();
    library(&conn, songs);
    share(&mut conn);
    Mutex::new(conn)
}

fn track(db: &Mutex<Connection>, n: usize) -> i64 {
    db.lock()
        .expect("lock")
        .query_row(
            "SELECT id FROM tracks WHERE audio_fp = ?1",
            params![format!("fp{n}")],
            |r| r.get(0),
        )
        .expect("track")
}

fn tag(db: &Mutex<Connection>, name: &str, songs: &[usize]) {
    let ids: Vec<i64> = songs.iter().map(|&n| track(db, n)).collect();
    db::tag_tracks(&mut db.lock().expect("lock"), name, &ids).expect("tag");
}

fn playlist(db: &Mutex<Connection>, name: &str, songs: &[usize]) -> i64 {
    let ids: Vec<i64> = songs.iter().map(|&n| track(db, n)).collect();
    let mut conn = db.lock().expect("lock");
    let id = db::create_playlist(&conn, name).expect("playlist");
    db::add_to_playlist(&mut conn, id, &ids).expect("add");
    id
}

fn add(db: &Mutex<Connection>, list: i64, songs: &[usize]) {
    let ids: Vec<i64> = songs.iter().map(|&n| track(db, n)).collect();
    db::add_to_playlist(&mut db.lock().expect("lock"), list, &ids).expect("add");
}

fn untag(db: &Mutex<Connection>, name: &str, song: usize) {
    let id = track(db, song);
    db::untag_track(&db.lock().expect("lock"), name, id).expect("untag");
}

fn remove(db: &Mutex<Connection>, list: i64, song: usize) {
    let id = track(db, song);
    db::remove_from_playlist(&db.lock().expect("lock"), list, id).expect("remove");
}

fn shown(db: &Mutex<Connection>) -> String {
    dump(&db.lock().expect("lock"))
}

#[tokio::test]
async fn tagging_and_playlists_reach_another_device_in_order() {
    let store = Memory::default();
    let a = device(5);
    let b = device(5);
    tag(&a, "Genre/House", &[1, 3]);
    playlist(&a, "Warmup", &[4, 2, 5]);
    // Added after the others, in the middle of nothing: appended at the end.
    let list = a
        .lock()
        .expect("lock")
        .query_row("SELECT id FROM playlists", [], |r| r.get::<_, i64>(0))
        .expect("id");
    add(&a, list, &[1]);

    let sent = run(&a, &store).await;
    assert!(sent.error.is_none(), "{sent:?}");
    assert!(sent.sent > 0);
    let got = run(&b, &store).await;
    assert!(got.error.is_none(), "{got:?}");
    assert_eq!(got.received, sent.sent);

    assert_eq!(shown(&a), shown(&b));
    let text = shown(&b);
    assert!(text.contains("tagged Genre/House fp1"), "{text}");
    assert!(text.contains("tagged Genre/House fp3"), "{text}");
    assert!(text.contains("Warmup [fp4,fp2,fp5,fp1]"), "{text}");
    // Parent levels came along as tags of their own.
    assert!(text.contains(" Genre shared"), "{text}");
}

#[tokio::test]
async fn devices_that_edit_at_once_converge() {
    let store = Memory::default();
    let a = device(6);
    let b = device(6);
    tag(&a, "Mood/Calm", &[1]);
    let pa = playlist(&a, "Shared", &[1, 2]);
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());

    // Both edit before hearing from each other.
    let pb: i64 = b
        .lock()
        .expect("lock")
        .query_row("SELECT id FROM playlists", [], |r| r.get(0))
        .expect("id");
    add(&a, pa, &[3]);
    add(&b, pb, &[4]);
    db::rename_playlist(&a.lock().expect("lock"), pa, "From A").expect("rename");
    db::rename_playlist(&b.lock().expect("lock"), pb, "From B").expect("rename");
    tag(&a, "Mood/Calm", &[5]);
    tag(&b, "Mood/Calm", &[6]);
    untag(&b, "Mood/Calm", 1);
    remove(&b, pb, 2);

    for _ in 0..2 {
        assert!(run(&a, &store).await.error.is_none());
        assert!(run(&b, &store).await.error.is_none());
    }
    assert_eq!(shown(&a), shown(&b));
    let text = shown(&a);
    assert!(text.contains("From B") || text.contains("From A"), "{text}");
    assert!(text.contains("tagged Mood/Calm fp5") && text.contains("tagged Mood/Calm fp6"));
    assert!(
        !text.contains("tagged Mood/Calm fp1"),
        "B's removal arrived: {text}"
    );
    assert!(
        text.contains("fp3") && text.contains("fp4") && !text.contains(",fp2"),
        "{text}"
    );
}

#[tokio::test]
async fn both_devices_creating_the_same_tag_end_with_one() {
    let store = Memory::default();
    let a = device(3);
    let b = device(3);
    tag(&a, "House", &[1]);
    tag(&b, "House", &[2]);
    for _ in 0..2 {
        assert!(run(&a, &store).await.error.is_none());
        assert!(run(&b, &store).await.error.is_none());
    }
    assert_eq!(shown(&a), shown(&b));
    let text = shown(&a);
    assert_eq!(
        text.lines().filter(|l| l.starts_with("tag ")).count(),
        1,
        "{text}"
    );
    assert!(
        text.contains("tagged House fp1") && text.contains("tagged House fp2"),
        "{text}"
    );
}

#[tokio::test]
async fn deletes_and_tag_moves_travel() {
    let store = Memory::default();
    let a = device(4);
    let b = device(4);
    tag(&a, "Old/Sub", &[1, 2]);
    playlist(&a, "Temp", &[1]);
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    assert_eq!(shown(&a), shown(&b));

    db::migrate_tags(&mut b.lock().expect("lock"), &["Old".into()], Some("New")).expect("move");
    let list: i64 = b
        .lock()
        .expect("lock")
        .query_row("SELECT id FROM playlists", [], |r| r.get(0))
        .expect("id");
    db::delete_playlist(&b.lock().expect("lock"), list).expect("delete");
    assert!(run(&b, &store).await.error.is_none());
    assert!(run(&a, &store).await.error.is_none());
    assert_eq!(shown(&a), shown(&b));
    let text = shown(&a);
    assert!(
        text.contains("tagged New/Sub fp1") && !text.contains("Old"),
        "{text}"
    );
    assert!(!text.contains("Temp"), "{text}");
}

#[tokio::test]
async fn nothing_is_written_until_library_data_is_switched_on() {
    let mut conn = open();
    let ids = library(&conn, 2);
    db::tag_tracks(&mut conn, "Quiet", &ids).expect("tag");
    let pl = db::create_playlist(&conn, "Quiet").expect("playlist");
    db::add_to_playlist(&mut conn, pl, &ids).expect("add");
    let logged: i64 = conn
        .query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0))
        .expect("count");
    assert_eq!(logged, 0);

    // Switching on writes what already exists, once.
    share(&mut conn);
    let logged: i64 = conn
        .query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0))
        .expect("count");
    // 1 tag name, 2 memberships, 1 playlist name, 2 x (present, pos).
    assert_eq!(logged, 1 + 2 + 1 + 4);
    assert_eq!(
        seed::seed(&mut conn).expect("seed"),
        0,
        "nothing new the second time"
    );

    // And a second device that gets that log sees the same library.
    let store = Memory::default();
    let a = Mutex::new(conn);
    let b = device(2);
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    assert_eq!(shown(&a), shown(&b));
}

#[tokio::test]
async fn local_items_never_write_ops() {
    let mut conn = open();
    library(&conn, 2);
    db::set_setting(&conn, "default_scope", Some("local")).expect("setting");
    share(&mut conn);
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM tracks")
        .expect("stmt")
        .query_map([], |r| r.get(0))
        .expect("rows")
        .map(|r| r.expect("row"))
        .collect();
    db::tag_tracks(&mut conn, "Mine/Only", &ids).expect("tag");
    let pl = db::create_playlist(&conn, "Mine").expect("playlist");
    db::add_to_playlist(&mut conn, pl, &ids).expect("add");
    let logged: i64 = conn
        .query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0))
        .expect("count");
    assert_eq!(logged, 0);
}

#[tokio::test]
async fn a_chunk_is_written_once_and_the_log_resumes_after_it() {
    let store = Memory::default();
    let a = device(3);
    tag(&a, "One", &[1]);
    assert_eq!(run(&a, &store).await.sent, 2);
    assert_eq!(run(&a, &store).await.sent, 0, "nothing new, no chunk");
    tag(&a, "Two", &[2]);
    assert_eq!(run(&a, &store).await.sent, 2);
    let seqs: Vec<u64> = store
        .list_chunks()
        .await
        .expect("list")
        .iter()
        .map(|c| c.seq)
        .collect();
    assert_eq!(seqs, vec![1, 2]);
    let me = super::write::device_id(&a.lock().expect("lock")).expect("id");
    assert_eq!(
        state::cursor(&a.lock().expect("lock"), &me).expect("cursor"),
        2
    );
}

#[tokio::test]
async fn a_gap_in_a_devices_chunks_stops_the_reader_there() {
    let store = Memory::default();
    let a = device(3);
    let b = device(3);
    for name in ["One", "Two", "Three"] {
        tag(&a, name, &[1]);
        assert!(run(&a, &store).await.error.is_none());
    }
    let me = super::write::device_id(&a.lock().expect("lock")).expect("id");
    let second = ChunkRef { dev: me, seq: 2 };
    store.0.lock().expect("lock").remove(&second);
    assert!(run(&b, &store).await.error.is_none());
    let text = shown(&b);
    assert!(
        text.contains("One") && !text.contains("Two") && !text.contains("Three"),
        "{text}"
    );
}

#[test]
fn legacy_playlists_get_position_keys_and_every_item_a_uid() {
    let path =
        std::env::temp_dir().join(format!("manplay-libsync-legacy-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    {
        let conn = db::open(&path).expect("open");
        let ids = library(&conn, 3);
        conn.execute("INSERT INTO playlists (name) VALUES ('Old')", [])
            .expect("playlist");
        for (position, id) in ids.iter().enumerate() {
            conn.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (1, ?1, ?2)",
                params![id, i64::try_from(position).expect("i64")],
            )
            .expect("member");
        }
        // As a database from before this version looks.
        conn.execute("UPDATE playlists SET uid = NULL", [])
            .expect("clear");
        conn.execute("UPDATE playlist_tracks SET pos = NULL", [])
            .expect("clear");
    }
    let reopened = db::open(&path).expect("reopen");
    let uid: String = reopened
        .query_row("SELECT uid FROM playlists", [], |r| r.get(0))
        .expect("uid");
    let pos: Vec<String> = reopened
        .prepare("SELECT pos FROM playlist_tracks ORDER BY position")
        .expect("stmt")
        .query_map([], |r| r.get(0))
        .expect("rows")
        .map(|r| r.expect("row"))
        .collect();
    assert_eq!(uid.len(), 36);
    assert_eq!(pos.len(), 3);
    assert!(pos.windows(2).all(|w| w[0] < w[1]), "{pos:?}");
    let _ = std::fs::remove_file(&path);
}
