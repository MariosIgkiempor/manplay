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
use super::waveforms::{self, Misses, WaveformRef};
use super::{clashes, share};
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
fn same_name_from_two_devices_is_a_clash_and_nothing_merges() {
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
    // Two tags: the lower uid has the name, the other is held under another.
    assert_eq!(expected.matches("tag u-").count(), 2, "{expected}");
    assert!(expected.contains("tag u-1 house shared"), "{expected}");
    assert!(
        expected.contains("tag u-2 House (shared) shared"),
        "{expected}"
    );
    assert!(expected.contains("tagged house fp2"), "{expected}");
    assert!(expected.contains("tagged House (shared) fp1"), "{expected}");
    for seed in 1..20 {
        assert_eq!(replay(&shuffled(&both, seed)), expected, "seed {seed}");
    }
}

#[test]
fn a_local_tag_meeting_a_shared_one_of_the_same_name_is_a_clash() {
    let mut conn = open();
    library(&conn, 2);
    share(&mut conn);
    db::set_setting(&conn, "default_scope", Some("local")).expect("setting");
    let ids: Vec<i64> = vec![1];
    db::tag_tracks(&mut conn, "Techno", &ids).expect("tag");
    let tx = conn.transaction().expect("tx");
    apply_ops(
        &tx,
        &[
            op(10, DEV_B, "tag", "shared-1", "name", json!("Techno")),
            op(
                11,
                DEV_B,
                "track_tag",
                "shared-1/fp2",
                "present",
                json!(true),
            ),
        ],
    )
    .expect("apply");
    tx.commit().expect("commit");
    let text = dump(&conn);
    assert!(
        text.contains("tag shared-1 Techno (shared) shared"),
        "{text}"
    );
    assert!(
        text.contains("tagged Techno fp1"),
        "mine stays mine: {text}"
    );
    assert!(
        text.contains("tagged Techno (shared) fp2"),
        "nothing merged: {text}"
    );
    let clashes = clashes::list(&conn).expect("list");
    assert_eq!(clashes.len(), 1);
    assert_eq!(clashes[0].keeps.scope, "local");
    assert_eq!(clashes[0].held.scope, "shared");
    assert_eq!(clashes[0].name, "Techno");
}

#[test]
fn a_held_item_takes_its_name_when_the_other_is_renamed_or_removed() {
    let mut conn = open();
    library(&conn, 2);
    share(&mut conn);
    db::set_setting(&conn, "default_scope", Some("local")).expect("setting");
    db::create_playlist(&conn, "Warmup").expect("playlist");
    let tx = conn.transaction().expect("tx");
    apply_ops(
        &tx,
        &[op(10, DEV_B, "playlist", "p-1", "name", json!("Warmup"))],
    )
    .expect("apply");
    tx.commit().expect("commit");
    assert_eq!(clashes::count(&conn).expect("count"), 1);
    let id: i64 = conn
        .query_row("SELECT id FROM playlists WHERE scope = 'local'", [], |r| {
            r.get(0)
        })
        .expect("id");
    db::rename_playlist(&conn, id, "Warmup old").expect("rename");
    assert_eq!(clashes::count(&conn).expect("count"), 0, "the name is free");
    let names: Vec<String> = conn
        .prepare("SELECT name FROM playlists ORDER BY name")
        .expect("stmt")
        .query_map([], |r| r.get(0))
        .expect("rows")
        .map(|r| r.expect("row"))
        .collect();
    assert_eq!(names, vec!["Warmup", "Warmup old"]);
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

/// A destination in memory: chunks and waveform files, counting waveform writes.
#[derive(Default)]
struct Memory {
    chunks: Mutex<BTreeMap<ChunkRef, Vec<u8>>>,
    waves: Mutex<BTreeMap<String, Vec<u8>>>,
    wave_writes: std::sync::atomic::AtomicUsize,
}

impl Memory {
    fn wave_key(w: &WaveformRef) -> Result<String, Error> {
        let (dir, name) = w
            .rel()
            .ok_or_else(|| Error::Msg("unsafe waveform name".into()))?;
        Ok(format!("{dir}/{name}"))
    }
}

#[allow(clippy::unused_async_trait_impl)] // the trait is async; memory never waits
impl ChunkStore for Memory {
    async fn list_chunks(&self) -> Result<Vec<ChunkRef>, Error> {
        Ok(self.chunks.lock().expect("lock").keys().cloned().collect())
    }

    async fn read_chunk(&self, chunk: &ChunkRef) -> Result<Vec<u8>, Error> {
        self.chunks
            .lock()
            .expect("lock")
            .get(chunk)
            .cloned()
            .ok_or_else(|| Error::Msg("no such chunk".into()))
    }

    async fn write_chunk(&self, chunk: &ChunkRef, bytes: Vec<u8>) -> Result<(), Error> {
        let mut chunks = self.chunks.lock().expect("lock");
        if chunks.contains_key(chunk) {
            return Err(Error::Msg("exists".into()));
        }
        chunks.insert(chunk.clone(), bytes);
        Ok(())
    }

    async fn waveform_exists(&self, w: &WaveformRef) -> Result<bool, Error> {
        Ok(self
            .waves
            .lock()
            .expect("lock")
            .contains_key(&Self::wave_key(w)?))
    }

    async fn read_waveform(&self, w: &WaveformRef) -> Result<Option<Vec<u8>>, Error> {
        Ok(self
            .waves
            .lock()
            .expect("lock")
            .get(&Self::wave_key(w)?)
            .cloned())
    }

    async fn write_waveform(&self, w: &WaveformRef, bytes: Vec<u8>) -> Result<(), Error> {
        self.waves
            .lock()
            .expect("lock")
            .entry(Self::wave_key(w)?)
            .or_insert(bytes);
        self.wave_writes
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
async fn both_devices_creating_the_same_tag_end_with_a_clash_they_agree_on() {
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
        2,
        "{text}"
    );
    assert_eq!(clashes::count(&a.lock().expect("lock")).expect("count"), 1);
    assert_eq!(clashes::count(&b.lock().expect("lock")).expect("count"), 1);
}

#[tokio::test]
async fn combining_two_shared_tags_converges_on_both_devices() {
    let store = Memory::default();
    let a = device(4);
    let b = device(4);
    tag(&a, "House", &[1]);
    tag(&b, "House", &[2]);
    // A rule over the tag that will be merged away, on the device that does not combine.
    smart(&a, "Mine", &["House"]);
    smart(&b, "Theirs", &["House"]);
    for _ in 0..2 {
        assert!(run(&a, &store).await.error.is_none());
        assert!(run(&b, &store).await.error.is_none());
    }
    // Only A resolves it.
    let id = clashes::list(&a.lock().expect("lock")).expect("list")[0].id;
    clashes::resolve(&a.lock().expect("lock"), id, clashes::Choice::Combine, None)
        .expect("combine");
    // B adds a song to the tag that is merged away, before it hears about the merge.
    for _ in 0..3 {
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
        "both sets of memberships: {text}"
    );
    assert_eq!(clashes::count(&a.lock().expect("lock")).expect("count"), 0);
    assert_eq!(clashes::count(&b.lock().expect("lock")).expect("count"), 0);
    // Rules on both devices point at the one tag, and match both songs.
    assert_eq!(smart_shown(&a), smart_shown(&b));
    let rules = smart_shown(&b);
    assert!(rules.contains("\"fp1\", \"fp2\""), "{rules}");
    assert!(!rules.contains('?'), "no unknown tag: {rules}");
}

#[tokio::test]
async fn a_late_edit_of_a_merged_tag_lands_on_the_one_it_became() {
    let store = Memory::default();
    let a = device(4);
    let b = device(4);
    tag(&a, "House", &[1]);
    tag(&b, "House", &[2]);
    for _ in 0..2 {
        assert!(run(&a, &store).await.error.is_none());
        assert!(run(&b, &store).await.error.is_none());
    }
    let id = clashes::list(&a.lock().expect("lock")).expect("list")[0].id;
    clashes::resolve(&a.lock().expect("lock"), id, clashes::Choice::Combine, None)
        .expect("combine");
    // B has not heard of the merge: it tags song 3 on what it knows as the other uid.
    tag(&b, "House (shared)", &[3]);
    tag(&b, "House", &[4]);
    for _ in 0..3 {
        assert!(run(&a, &store).await.error.is_none());
        assert!(run(&b, &store).await.error.is_none());
    }
    assert_eq!(shown(&a), shown(&b));
    let text = shown(&a);
    for fp in ["fp1", "fp2", "fp4"] {
        assert!(text.contains(&format!("tagged House {fp}")), "{text}");
    }
}

#[tokio::test]
async fn renaming_a_tag_moves_rules_on_a_device_that_had_not_heard() {
    let store = Memory::default();
    let a = device(3);
    let b = device(3);
    tag(&a, "Old", &[1]);
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    // B writes a rule over Old while A renames it.
    smart(&b, "Rule", &["Old"]);
    db::migrate_tags(&mut a.lock().expect("lock"), &["Old".into()], Some("New")).expect("move");
    for _ in 0..3 {
        assert!(run(&a, &store).await.error.is_none());
        assert!(run(&b, &store).await.error.is_none());
    }
    assert_eq!(smart_shown(&a), smart_shown(&b));
    let rules = smart_shown(&b);
    assert!(
        rules.contains("[\"New\"]") && !rules.contains('?'),
        "{rules}"
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
    store.chunks.lock().expect("lock").remove(&second);
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

// ---- smart playlists, Tag Database values, analysis, waveforms ----------------

fn smart(db: &Mutex<Connection>, name: &str, tags: &[&str]) -> i64 {
    let rules = crate::smart::Rules {
        all_tags: tags.iter().map(|&t| t.to_owned()).collect(),
        ..crate::smart::Rules::default()
    };
    db::save_smart_playlist(
        &db.lock().expect("lock"),
        &crate::smart::SmartPlaylist {
            id: 0,
            name: name.to_owned(),
            rules,
        },
    )
    .expect("save")
    .id
}

/// Names and rules of every smart playlist and the songs (by audio) its rules pick.
fn smart_shown(db: &Mutex<Connection>) -> String {
    let conn = db.lock().expect("lock");
    let tracks = db::list(&conn).expect("list");
    let mut out = Vec::new();
    for p in db::smart_playlists(&conn).expect("smart") {
        let mut picked: Vec<String> = crate::smart::resolve(&p.rules, &tracks, 0)
            .into_iter()
            .map(|id| db::audio_fp_of(&conn, id).expect("fp").unwrap_or_default())
            .collect();
        picked.sort();
        out.push(format!("{} {:?} -> {picked:?}", p.name, p.rules.all_tags));
    }
    out.join("\n")
}

fn finished(bpm: f64) -> (crate::analysis::Analysis, crate::anlz::Stored) {
    (
        crate::analysis::Analysis {
            bpm: Some(bpm),
            key: Some("Am".to_owned()),
        },
        crate::anlz::Stored {
            grid_bpm: Some(bpm),
            first_beat: 0.25,
            bar_offset: 1,
            duration: 3.0,
            detail: vec![0x5f; 450],
        },
    )
}

type AnalysisRow = (
    Option<f64>,
    Option<String>,
    i64,
    Option<f64>,
    Option<f64>,
    bool,
    bool,
);

fn analysis_row(db: &Mutex<Connection>, fp: &str) -> Option<AnalysisRow> {
    db.lock()
        .expect("lock")
        .query_row(
            "SELECT bpm, musical_key, version, grid_bpm, first_beat, bpm_edited, waveform IS NOT NULL
             FROM analysis WHERE audio_fp = ?1",
            params![fp],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .ok()
}

#[tokio::test]
async fn a_smart_playlist_rule_survives_renaming_its_tag_and_reaches_other_devices() {
    let store = Memory::default();
    let a = device(4);
    let b = device(4);
    tag(&a, "Genre/House", &[1, 2]);
    tag(&a, "vocal", &[2]);
    let id = smart(&a, "House", &["Genre/House"]);
    assert_eq!(
        smart_shown(&a),
        "House [\"Genre/House\"] -> [\"fp1\", \"fp2\"]"
    );
    // The rules are kept by uid, not by name.
    let stored: String = a
        .lock()
        .expect("lock")
        .query_row(
            "SELECT rules FROM smart_playlists WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .expect("rules");
    assert!(!stored.contains("House"), "{stored}");

    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    assert_eq!(smart_shown(&a), smart_shown(&b));

    // Renaming the tag on A: the rule follows it, here and on B.
    db::migrate_tags(
        &mut a.lock().expect("lock"),
        &["Genre/House".to_owned()],
        Some("Genre/Deep House"),
    )
    .expect("rename");
    assert_eq!(
        smart_shown(&a),
        "House [\"Genre/Deep House\"] -> [\"fp1\", \"fp2\"]"
    );
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    assert_eq!(smart_shown(&a), smart_shown(&b));
    assert_eq!(
        smart_shown(&b),
        "House [\"Genre/Deep House\"] -> [\"fp1\", \"fp2\"]"
    );

    // Renaming and deleting the playlist travel too.
    let mut p = db::smart_playlists(&a.lock().expect("lock"))
        .expect("list")
        .remove(0);
    p.name = "Deep".to_owned();
    db::save_smart_playlist(&a.lock().expect("lock"), &p).expect("save");
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    assert!(smart_shown(&b).starts_with("Deep "), "{}", smart_shown(&b));
    db::delete_smart_playlist(&a.lock().expect("lock"), p.id).expect("delete");
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    assert_eq!(smart_shown(&b), "");
}

#[tokio::test]
async fn a_local_smart_playlist_and_a_tag_this_device_lacks_stay_safe() {
    let store = Memory::default();
    let a = device(2);
    let b = device(2);
    a.lock()
        .expect("lock")
        .execute(
            "INSERT INTO settings (key, value) VALUES ('default_scope', 'local')",
            [],
        )
        .expect("scope");
    tag(&a, "Mine", &[1]);
    smart(&a, "Private", &["Mine"]);
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    assert_eq!(smart_shown(&b), "", "local items are not sent");

    // A shared playlist over a tag that is local to A is refused: B could not name the tag.
    a.lock()
        .expect("lock")
        .execute("DELETE FROM settings WHERE key = 'default_scope'", [])
        .expect("scope");
    let refused = db::save_smart_playlist(
        &a.lock().expect("lock"),
        &crate::smart::SmartPlaylist {
            id: 0,
            name: "Shared".into(),
            rules: crate::smart::Rules {
                all_tags: vec!["Mine".into()],
                ..crate::smart::Rules::default()
            },
        },
    );
    assert!(
        refused.is_err_and(|e| e.to_string().contains("local tags")),
        "blocked until the tag is shared or dropped"
    );

    // A tag deleted on A while B still has a rule on it: B cannot name the tag, and the rule
    // keeps its uid when B saves it again.
    tag(&a, "Pub", &[1]);
    smart(&a, "Shared", &["Pub"]);
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    let pub_id: i64 = a
        .lock()
        .expect("lock")
        .query_row("SELECT id FROM tags WHERE name = 'Pub'", [], |r| r.get(0))
        .expect("tag");
    db::delete_tag(&a.lock().expect("lock"), pub_id).expect("delete");
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    let seen = db::smart_playlists(&b.lock().expect("lock"))
        .expect("list")
        .remove(0);
    assert!(seen.rules.all_tags[0].starts_with('?'), "{:?}", seen.rules);
    db::save_smart_playlist(&b.lock().expect("lock"), &seen).expect("save back");
    let stored: String = b
        .lock()
        .expect("lock")
        .query_row("SELECT rules FROM smart_playlists", [], |r| r.get(0))
        .expect("rules");
    assert!(stored.contains(&seen.rules.all_tags[0][1..]), "{stored}");
}

fn analysis_ops(ops: &[(i64, &str, &str, Value)]) -> Vec<Op> {
    ops.iter()
        .map(|(t, dev, f, v)| op(*t, dev, "analysis", "fp1", f, v.clone()))
        .collect()
}

#[test]
fn a_hand_edited_bpm_beats_an_automatic_one_whatever_the_clocks_say() {
    let hand = [
        (10, DEV_A, "bpm_hand", json!(130.0)),
        (10, DEV_A, "bpm_edited", json!(true)),
        (10, DEV_A, "version", json!(2)),
    ];
    let auto = [
        (50, DEV_B, "bpm", json!(128.0)),
        (50, DEV_B, "version", json!(2)),
    ];
    for (first, second) in [(&hand[..], &auto[..]), (&auto[..], &hand[..])] {
        let mut conn = open();
        library(&conn, 1);
        for batch in [first, second] {
            let tx = conn.transaction().expect("tx");
            apply_ops(&tx, &analysis_ops(batch)).expect("apply");
            tx.commit().expect("commit");
        }
        let (bpm, _, _, _, _, edited, _) = analysis_row(&Mutex::new(conn), "fp1").expect("row");
        assert_eq!((bpm, edited), (Some(130.0), true));
    }
    // Resetting the hand edit (a later flag of false) brings the automatic value back.
    let mut conn = open();
    library(&conn, 1);
    let mut all = analysis_ops(&hand);
    all.extend(analysis_ops(&auto));
    all.extend(analysis_ops(&[(90, DEV_A, "bpm_edited", json!(false))]));
    let tx = conn.transaction().expect("tx");
    apply_ops(&tx, &all).expect("apply");
    tx.commit().expect("commit");
    let (bpm, _, _, _, _, edited, _) = analysis_row(&Mutex::new(conn), "fp1").expect("row");
    assert_eq!((bpm, edited), (Some(128.0), false));
}

#[tokio::test]
async fn analysis_and_hand_edits_reach_another_device_without_analysing_there() {
    let store = Memory::default();
    let a = device(2);
    let b = device(2);
    db::store_analysis(
        &a.lock().expect("lock"),
        "fp1",
        &Ok(finished(128.0)),
        100,
        false,
    )
    .expect("analyse");
    // Hand edits: a tempo, and a grid.
    let t1 = track(&a, 1);
    db::set_tempo_key(&a.lock().expect("lock"), t1, Some(Some(126.0)), None).expect("bpm");
    db::mark_grid_edited(&a.lock().expect("lock"), t1).expect("grid");
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());

    let (bpm, key, version, grid, first, edited, has_waveform) =
        analysis_row(&b, "fp1").expect("row on B");
    assert_eq!((bpm, key.as_deref(), version), (Some(126.0), Some("Am"), 2));
    assert_eq!(
        (grid, first, edited, has_waveform),
        (Some(128.0), Some(0.25), true, false)
    );
    // B does not queue it for analysis once the waveform arrives.
    assert!(analysis_row(&b, "fp2").is_none());

    // A later automatic result from B does not undo A's hand edit, on either device.
    db::store_analysis(
        &b.lock().expect("lock"),
        "fp1",
        &Ok(finished(127.0)),
        200,
        false,
    )
    .expect("again");
    assert!(run(&b, &store).await.error.is_none());
    assert!(run(&a, &store).await.error.is_none());
    for d in [&a, &b] {
        assert_eq!(analysis_row(d, "fp1").expect("row").0, Some(126.0));
    }

    // "Replace edits" forgets the hand edit everywhere.
    db::store_analysis(
        &b.lock().expect("lock"),
        "fp1",
        &Ok(finished(127.0)),
        300,
        true,
    )
    .expect("replace");
    assert!(run(&b, &store).await.error.is_none());
    assert!(run(&a, &store).await.error.is_none());
    let row = analysis_row(&a, "fp1").expect("row");
    assert_eq!((row.0, row.5), (Some(127.0), false));
}

#[tokio::test]
async fn waveforms_are_uploaded_once_and_fetched_when_needed() {
    let store = Memory::default();
    let a = device(3);
    let b = device(3);
    for fp in ["fp1", "fp2"] {
        db::store_analysis(&a.lock().expect("lock"), fp, &Ok(finished(120.0)), 1, false)
            .expect("analyse");
    }
    // Too big for the cap: never uploaded.
    db::store_analysis(
        &a.lock().expect("lock"),
        "fp3",
        &Ok(finished(120.0)),
        1,
        false,
    )
    .expect("analyse");
    a.lock()
        .expect("lock")
        .execute(
            "UPDATE analysis SET waveform = zeroblob(?1) WHERE audio_fp = 'fp3'",
            params![i64::try_from(waveforms::MAX_BYTES).expect("fits") + 1],
        )
        .expect("big");
    // fp2's waveform is already on the destination (another device wrote it first).
    let wave2 = WaveformRef::new("fp2", 2);
    store
        .write_waveform(&wave2, vec![7; 10])
        .await
        .expect("other device");
    store
        .wave_writes
        .store(0, std::sync::atomic::Ordering::SeqCst);

    let pushed = waveforms::push(&a, &store, 100).await.expect("push");
    assert_eq!((pushed.sent, pushed.existed, pushed.too_big), (1, 1, 1));
    let again = waveforms::push(&a, &store, 100).await.expect("push again");
    assert_eq!(
        again,
        waveforms::PushSummary::default(),
        "nothing left to check"
    );
    assert_eq!(
        store.wave_writes.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert_eq!(
        store
            .waves
            .lock()
            .expect("lock")
            .get("fp/fp2-v2.bin")
            .map(Vec::len),
        Some(10),
        "first writer wins"
    );

    // B learns the analysis from ops, has no waveform, and fills it when asked.
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    assert!(!analysis_row(&b, "fp1").expect("row").6);
    let misses = Misses::default();
    assert!(
        waveforms::fetch(&b, &store, &misses, "fp1")
            .await
            .expect("fetch")
    );
    assert!(analysis_row(&b, "fp1").expect("row").6);
    let kept = crate::anlz::load(&b.lock().expect("lock"), "fp1").expect("loads");
    assert_eq!(kept.detail, vec![0x5f; 450]);
    assert_eq!(kept.grid_bpm, Some(120.0));
    // A missing file is asked for once until the next sync.
    assert!(
        !waveforms::fetch(&b, &store, &misses, "fp3")
            .await
            .expect("none")
    );
    assert!(misses.contains("fp3"));

    // The background fill takes what is left, up to its limit.
    let filled = waveforms::fill(
        &b,
        &store,
        &Misses::default(),
        10,
        std::time::Duration::ZERO,
    )
    .await
    .expect("fill");
    assert_eq!(filled, 1, "fp2 only: fp3 has no file");
    assert!(analysis_row(&b, "fp2").expect("row").6);
}

#[tokio::test]
async fn hand_made_tag_database_values_travel() {
    let store = Memory::default();
    let a = device(1);
    let b = device(1);
    db::create_tag_value(&a.lock().expect("lock"), "artist", "DJ Foo").expect("add");
    db::create_tag_value(&a.lock().expect("lock"), "genre", "Zouk").expect("add");
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    let values = |d: &Mutex<Connection>, field: &str| {
        db::tag_values(&d.lock().expect("lock"), field)
            .expect("values")
            .into_iter()
            .map(|v| v.value)
            .collect::<Vec<_>>()
    };
    assert_eq!(values(&b, "artist"), ["DJ Foo"]);
    assert_eq!(values(&b, "genre"), ["Zouk"]);
    // Removing one (a migration away from it) removes it everywhere.
    db::migrate_custom_values(
        &a.lock().expect("lock"),
        "genre",
        &["Zouk".to_owned()],
        None,
    )
    .expect("migrate");
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    assert_eq!(values(&b, "genre"), Vec::<String>::new());
}

#[test]
fn switching_sharing_on_covers_smart_playlists_values_and_analysis() {
    let mut conn = open();
    library(&conn, 2);
    tag_direct(&mut conn, "Genre/House", 1);
    db::save_smart_playlist(
        &conn,
        &crate::smart::SmartPlaylist {
            id: 0,
            name: "House".into(),
            rules: crate::smart::Rules {
                all_tags: vec!["Genre/House".into()],
                ..crate::smart::Rules::default()
            },
        },
    )
    .expect("smart");
    db::create_tag_value(&conn, "artist", "DJ Foo").expect("value");
    db::store_analysis(&conn, "fp1", &Ok(finished(124.0)), 5, false).expect("analyse");
    db::set_tempo_key(&conn, 1, Some(Some(125.0)), None).expect("bpm");
    assert_eq!(
        count_ops(&conn),
        0,
        "nothing is written while sharing is off"
    );

    share(&mut conn);
    for (entity, id) in [
        ("smart_playlist", None),
        ("tag_custom", Some("artist/dj foo")),
        ("analysis", Some("fp1")),
    ] {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM oplog WHERE e = ?1 AND (?2 IS NULL OR id = ?2)",
                params![entity, id],
                |r| r.get(0),
            )
            .expect("count");
        assert!(n > 0, "{entity} was not seeded");
    }
    let hand: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM oplog WHERE e = 'analysis' AND f IN ('bpm_hand', 'bpm_edited')",
            [],
            |r| r.get(0),
        )
        .expect("hand");
    assert_eq!(hand, 2, "the hand-set tempo goes as an edit");

    // A library that shared tags and playlists before these were shared is caught up, once.
    let before = count_ops(&conn);
    conn.execute("DELETE FROM settings WHERE key = 'libsync_seeded'", [])
        .expect("old");
    conn.execute(
        "DELETE FROM oplog WHERE e IN ('smart_playlist', 'tag_custom', 'analysis')",
        [],
    )
    .expect("drop");
    conn.execute(
        "DELETE FROM op_state WHERE e IN ('smart_playlist', 'tag_custom', 'analysis')",
        [],
    )
    .expect("drop");
    seed::catch_up(&conn).expect("catch up");
    assert_eq!(count_ops(&conn), before);
    seed::catch_up(&conn).expect("again");
    assert_eq!(count_ops(&conn), before, "only once");
}

fn count_ops(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM oplog", [], |r| r.get(0))
        .expect("count")
}

fn tag_direct(conn: &mut Connection, name: &str, song: i64) {
    db::tag_tracks(conn, name, &[song]).expect("tag");
}

// ---- clashes, sharing and making private ---------------------------------------

fn local_device(songs: usize) -> Mutex<Connection> {
    let d = device(songs);
    db::set_setting(&d.lock().expect("lock"), "default_scope", Some("local")).expect("scope");
    d
}

fn row_id(db: &Mutex<Connection>, table: &str, name: &str) -> i64 {
    db.lock()
        .expect("lock")
        .query_row(
            &format!("SELECT id FROM {table} WHERE name = ?1"),
            params![name],
            |r| r.get(0),
        )
        .expect("row")
}

#[tokio::test]
async fn combining_a_local_tag_into_a_shared_one_shares_its_songs() {
    let store = Memory::default();
    let a = device(4);
    let b = local_device(4);
    tag(&a, "Techno", &[1]);
    tag(&b, "Techno", &[2, 3]);
    for _ in 0..2 {
        assert!(run(&a, &store).await.error.is_none());
        assert!(run(&b, &store).await.error.is_none());
    }
    {
        let conn = b.lock().expect("lock");
        let id = clashes::list(&conn).expect("list")[0].id;
        let preview = clashes::combine_preview(&conn, id).expect("preview");
        assert!(preview.shares_local);
        assert_eq!(preview.songs, 2);
        clashes::resolve(&conn, id, clashes::Choice::Combine, None).expect("combine");
    }
    for _ in 0..2 {
        assert!(run(&b, &store).await.error.is_none());
        assert!(run(&a, &store).await.error.is_none());
    }
    assert_eq!(shown(&a), shown(&b));
    let text = shown(&a);
    assert_eq!(
        text.lines().filter(|l| l.starts_with("tag ")).count(),
        1,
        "{text}"
    );
    for fp in ["fp1", "fp2", "fp3"] {
        assert!(text.contains(&format!("tagged Techno {fp}")), "{text}");
    }
}

#[tokio::test]
async fn renaming_either_side_of_a_clash_settles_it() {
    let store = Memory::default();
    let a = device(3);
    let b = local_device(3);
    playlist(&a, "Warmup", &[1]);
    // Local to B, same name.
    {
        let mut conn = b.lock().expect("lock");
        let id = db::create_playlist(&conn, "Warmup").expect("playlist");
        let ids = [track_in(&conn, 2)];
        db::add_to_playlist(&mut conn, id, &ids).expect("add");
    }
    for _ in 0..2 {
        assert!(run(&a, &store).await.error.is_none());
        assert!(run(&b, &store).await.error.is_none());
    }
    {
        let conn = b.lock().expect("lock");
        let c = clashes::list(&conn).expect("list").remove(0);
        assert_eq!(c.held.name, "Warmup (shared)");
        // Rename shared: everyone gets the new name, mine keeps "Warmup".
        clashes::resolve(&conn, c.id, clashes::Choice::RenameHeld, Some("Warmup 2"))
            .expect("rename");
        assert_eq!(clashes::count(&conn).expect("count"), 0);
    }
    for _ in 0..2 {
        assert!(run(&b, &store).await.error.is_none());
        assert!(run(&a, &store).await.error.is_none());
    }
    let names = |d: &Mutex<Connection>| -> Vec<String> {
        d.lock()
            .expect("lock")
            .prepare("SELECT name FROM playlists ORDER BY name")
            .expect("stmt")
            .query_map([], |r| r.get(0))
            .expect("rows")
            .map(|r| r.expect("row"))
            .collect()
    };
    assert_eq!(names(&a), vec!["Warmup 2"]);
    assert_eq!(names(&b), vec!["Warmup", "Warmup 2"]);
}

fn track_in(conn: &Connection, n: usize) -> i64 {
    conn.query_row(
        "SELECT id FROM tracks WHERE audio_fp = ?1",
        params![format!("fp{n}")],
        |r| r.get(0),
    )
    .expect("track")
}

#[tokio::test]
async fn renaming_mine_keeps_its_scope_and_moves_its_subtags() {
    let b = local_device(3);
    tag(&b, "Techno/Dark", &[1]);
    let tx = b.lock().expect("lock");
    tx.execute_batch("BEGIN").expect("begin");
    apply_ops(&tx, &[op(10, DEV_A, "tag", "s-1", "name", json!("Techno"))]).expect("apply");
    tx.execute_batch("COMMIT").expect("commit");
    let c = clashes::list(&tx).expect("list").remove(0);
    assert_eq!(c.keeps.scope, "local");
    clashes::resolve(&tx, c.id, clashes::Choice::RenameKeeps, Some("Tech")).expect("rename");
    drop(tx);
    let text = shown(&b);
    assert!(!text.contains("Tech shared"), "{text}");
    assert!(text.contains(" Tech local"), "{text}");
    assert!(text.contains(" Tech/Dark local"), "{text}");
    assert!(
        text.contains(" Techno shared"),
        "the shared one has its name now: {text}"
    );
}

#[tokio::test]
async fn a_stopgap_alias_comes_back_as_a_clash_once() {
    let mut conn = open();
    library(&conn, 2);
    // What step 2 left: two uids with one name in the registers, a row for the lower one.
    let tx = conn.transaction().expect("tx");
    for (clk, uid, fp) in [(10, "u-2", "fp1"), (11, "u-1", "fp2")] {
        for o in [
            op(clk, DEV_A, "tag", uid, "name", json!("House")),
            op(
                clk + 2,
                DEV_A,
                "track_tag",
                &format!("{uid}/{fp}"),
                "present",
                json!(true),
            ),
        ] {
            state::put(&tx, &o).expect("put");
        }
    }
    tx.execute(
        "INSERT INTO tags (uid, name, scope) VALUES ('u-1', 'House', 'shared')",
        [],
    )
    .expect("row");
    tx.execute(
        "INSERT INTO track_tags (track_id, tag_id) SELECT id, 1 FROM tracks",
        [],
    )
    .expect("members");
    tx.execute("DELETE FROM settings WHERE key = 'libsync_clashes'", [])
        .expect("reset");
    tx.commit().expect("commit");
    clashes::migrate(&conn).expect("migrate");
    assert_eq!(clashes::count(&conn).expect("count"), 1);
    let again = clashes::migrate(&conn);
    assert!(again.is_ok());
    assert_eq!(clashes::count(&conn).expect("count"), 1, "only once");
}

#[tokio::test]
async fn sharing_an_item_writes_creates_for_it_and_its_songs() {
    let store = Memory::default();
    let a = local_device(3);
    let b = device(3);
    tag(&a, "Mine", &[1, 2]);
    playlist(&a, "Set", &[3, 1]);
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    assert_eq!(shown(&b), "", "private until shared");
    {
        let conn = a.lock().expect("lock");
        let tag_id = row_id_conn(&conn, "tags", "Mine");
        let pl_id = row_id_conn(&conn, "playlists", "Set");
        let preview = share::share_preview(&conn, "tag", tag_id).expect("preview");
        assert_eq!(preview.songs, 2);
        share::share(&conn, "tag", tag_id, &BTreeMap::new()).expect("share tag");
        share::share(&conn, "playlist", pl_id, &BTreeMap::new()).expect("share playlist");
    }
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    assert_eq!(shown(&a), shown(&b));
    let text = shown(&b);
    assert!(
        text.contains("tagged Mine fp1") && text.contains("tagged Mine fp2"),
        "{text}"
    );
    assert!(text.contains("Set [fp3,fp1]"), "{text}");
}

fn row_id_conn(conn: &Connection, table: &str, name: &str) -> i64 {
    conn.query_row(
        &format!("SELECT id FROM {table} WHERE name = ?1"),
        params![name],
        |r| r.get(0),
    )
    .expect("row")
}

#[tokio::test]
async fn making_private_removes_it_for_others_and_keeps_a_local_copy() {
    let store = Memory::default();
    let a = device(3);
    let b = device(3);
    tag(&a, "Gone", &[1, 2]);
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    assert!(shown(&b).contains("tagged Gone fp1"));
    let old_uid: String = {
        let conn = a.lock().expect("lock");
        let id = row_id_conn(&conn, "tags", "Gone");
        let old = conn
            .query_row("SELECT uid FROM tags WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .expect("uid");
        share::make_private(&conn, "tag", id, false).expect("private");
        old
    };
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    let (scope, uid): (String, String) = a
        .lock()
        .expect("lock")
        .query_row("SELECT scope, uid FROM tags WHERE name = 'Gone'", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .expect("copy");
    assert_eq!(scope, "local");
    assert_ne!(uid, old_uid, "a new uid");
    assert!(shown(&a).contains("tagged Gone fp1"), "songs stay here");
    assert!(!shown(&b).contains("Gone"), "gone for everyone else");
    // The copy is private: editing it sends nothing.
    let before = count_ops(&a.lock().expect("lock"));
    tag(&a, "Gone", &[3]);
    assert_eq!(count_ops(&a.lock().expect("lock")), before);
}

#[tokio::test]
async fn a_shared_smart_playlist_and_a_local_tag_need_a_choice() {
    let a = device(3);
    {
        let mut conn = a.lock().expect("lock");
        db::set_setting(&conn, "default_scope", Some("local")).expect("scope");
        let ids = [track_in(&conn, 1)];
        db::tag_tracks(&mut conn, "Mine", &ids).expect("tag");
        db::set_setting(&conn, "default_scope", None).expect("scope");
    }
    // A local smart playlist over a local tag is fine; sharing it asks.
    db::set_setting(&a.lock().expect("lock"), "default_scope", Some("local")).expect("scope");
    let sid = smart(&a, "Playlist", &["Mine"]);
    let conn = a.lock().expect("lock");
    let preview = share::share_preview(&conn, "smart_playlist", sid).expect("preview");
    assert_eq!(preview.local_tags.len(), 1);
    assert_eq!(preview.local_tags[0].tag, "Mine");
    let blocked = share::share(&conn, "smart_playlist", sid, &BTreeMap::new());
    assert!(blocked.is_err(), "blocked until resolved");
    // Remove rule: the playlist is shared without it.
    let choice = BTreeMap::from([("Mine".to_owned(), share::TagChoice::Remove)]);
    share::share(&conn, "smart_playlist", sid, &choice).expect("share");
    let rules: String = conn
        .query_row("SELECT rules FROM smart_playlists", [], |r| r.get(0))
        .expect("rules");
    assert!(!rules.contains("Mine") && !rules.contains('-'), "{rules}");
    let scope: String = conn
        .query_row("SELECT scope FROM tags WHERE name = 'Mine'", [], |r| {
            r.get(0)
        })
        .expect("scope");
    assert_eq!(scope, "local", "the tag stayed private");
}

#[tokio::test]
async fn share_tag_too_shares_the_tag_with_the_playlist() {
    let store = Memory::default();
    let a = local_device(3);
    let b = device(3);
    tag(&a, "Mine", &[1]);
    let sid = smart(&a, "Playlist", &["Mine"]);
    {
        let conn = a.lock().expect("lock");
        let choice = BTreeMap::from([("Mine".to_owned(), share::TagChoice::Share)]);
        share::share(&conn, "smart_playlist", sid, &choice).expect("share");
    }
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    assert!(shown(&b).contains("tagged Mine fp1"));
    assert_eq!(smart_shown(&a), smart_shown(&b));
    assert!(
        smart_shown(&b).contains("[\"Mine\"]"),
        "{}",
        smart_shown(&b)
    );
}

#[tokio::test]
async fn making_a_tag_private_is_refused_while_a_shared_smart_playlist_uses_it() {
    let store = Memory::default();
    let a = device(3);
    let b = device(3);
    tag(&a, "Used", &[1]);
    smart(&a, "Playlist", &["Used"]);
    {
        let conn = a.lock().expect("lock");
        let id = row_id_conn(&conn, "tags", "Used");
        let preview = share::private_preview(&conn, "tag", id).expect("preview");
        assert_eq!(preview.used_by, vec!["Playlist"]);
        assert!(share::make_private(&conn, "tag", id, false).is_err());
        share::make_private(&conn, "tag", id, true).expect("with the rule removed");
    }
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    assert!(!smart_shown(&b).contains('?'), "{}", smart_shown(&b));
    assert!(smart_shown(&b).contains("[]"), "{}", smart_shown(&b));
}

#[tokio::test]
async fn hiding_is_local_and_survives_replay() {
    let store = Memory::default();
    let a = device(2);
    let b = device(2);
    tag(&a, "Quiet", &[1]);
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    let id = row_id(&b, "tags", "Quiet");
    share::set_hidden(&b.lock().expect("lock"), "tag", id, true).expect("hide");
    tag(&a, "Quiet", &[2]);
    assert!(run(&a, &store).await.error.is_none());
    assert!(run(&b, &store).await.error.is_none());
    let tags = db::list_tags(&b.lock().expect("lock")).expect("list");
    assert!(
        tags.iter()
            .any(|t| t.name == "Quiet" && t.hidden && t.track_count == 2)
    );
    let a_tags = db::list_tags(&a.lock().expect("lock")).expect("list");
    assert!(a_tags.iter().all(|t| !t.hidden));
}

#[tokio::test]
async fn same_named_smart_playlists_clash_and_combine() {
    let store = Memory::default();
    let a = device(2);
    let b = device(2);
    smart(&a, "Peak", &[]);
    smart(&b, "Peak", &[]);
    for _ in 0..2 {
        assert!(run(&a, &store).await.error.is_none());
        assert!(run(&b, &store).await.error.is_none());
    }
    assert_eq!(clashes::count(&a.lock().expect("lock")).expect("count"), 1);
    let id = clashes::list(&a.lock().expect("lock")).expect("list")[0].id;
    clashes::resolve(&a.lock().expect("lock"), id, clashes::Choice::Combine, None)
        .expect("combine");
    for _ in 0..3 {
        assert!(run(&a, &store).await.error.is_none());
        assert!(run(&b, &store).await.error.is_none());
    }
    assert_eq!(smart_shown(&a), smart_shown(&b));
    assert_eq!(smart_shown(&a).lines().count(), 1, "{}", smart_shown(&a));
    assert_eq!(clashes::count(&b.lock().expect("lock")).expect("count"), 0);
}
