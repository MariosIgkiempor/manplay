//! Snapshots: the whole shared state in one file, so the log can be cleaned up and a new device
//! does not replay years of edits.
//!
//! `.manplay/snapshot/<clock>.jsonl.gz` (the clock is the writer's, so the name sorts by time and
//! names the writer). Line 1 is a [`Header`]; every other line is an op: the winning op of each
//! `(entity, id, field)` this device holds, tombstones included until they are 90 days old.
//! `covers` says up to which chunk of each device the snapshot knows everything. Readers use the
//! newest snapshot and then the chunks past `covers`. See
//! `docs/plans/shared-library/06-compaction.md`.

use std::collections::{BTreeMap, HashSet};
use std::io::{Read, Write};
use std::sync::Mutex;

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::apply::{self, apply_ops};
use super::entities;
use super::ops::{F_DELETE, F_MERGE, F_PRESENT, F_RULES, FORMAT, Op};
use super::remote::ChunkStore;
use super::state;
use super::{clock, write};
use crate::db;
use crate::error::Error;

/// Folder under `.manplay` that holds snapshots.
pub const DIR: &str = "snapshot";
/// Version of the snapshot file layout this build writes and reads.
pub const SNAPSHOT_FORMAT: u32 = 1;
/// How long a tombstone is kept: a device away for longer starts over from the snapshot.
pub const TOMBSTONE_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const SUFFIX: &str = ".jsonl.gz";
/// What this device last knew of the newest snapshot (so it is not downloaded again).
const SETTING_KNOWN: &str = "libsync_snapshot";
/// When this device last synced library data completely, UTC ms.
pub const SETTING_LAST_SYNC: &str = "libsync_last_sync";

fn lock(db: &Mutex<Connection>) -> Result<std::sync::MutexGuard<'_, Connection>, Error> {
    db.lock().map_err(|_| Error::Lock)
}

fn json_err(e: &serde_json::Error) -> Error {
    Error::Msg(e.to_string())
}

/// The first line of a snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Header {
    /// Version of the snapshot layout.
    pub v: u32,
    /// Version of the op format of the lines.
    pub format: u32,
    /// For each device, the last chunk whose ops the snapshot holds.
    pub covers: BTreeMap<String, u64>,
    /// When it was written (the writer's clock); the newest snapshot wins.
    pub clock: String,
    /// Tombstones made before this (UTC ms) are not in the snapshot.
    #[serde(default)]
    pub horizon: i64,
}

/// A snapshot read from the destination.
pub struct Loaded {
    pub header: Header,
    pub ops: Vec<Op>,
}

/// The newest snapshot a device has seen: enough to know what chunks it covers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Known {
    pub clock: String,
    pub covers: BTreeMap<String, u64>,
}

pub fn path(clock: &str) -> String {
    format!("{DIR}/{clock}{SUFFIX}")
}

/// The clock a snapshot file name stands for; anything else in the folder is not a snapshot.
pub fn parse_name(name: &str) -> Option<String> {
    let clock = name.strip_suffix(SUFFIX)?;
    clock::parse(clock)?;
    Some(clock.to_owned())
}

pub fn encode(header: &Header, ops: &[Op]) -> Result<Vec<u8>, Error> {
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    serde_json::to_writer(&mut gz, header).map_err(|e| json_err(&e))?;
    gz.write_all(b"\n")?;
    for op in ops {
        serde_json::to_writer(&mut gz, op).map_err(|e| json_err(&e))?;
        gz.write_all(b"\n")?;
    }
    Ok(gz.finish()?)
}

/// A snapshot file. A line that cannot be read is skipped; a file from a newer layout is an error.
pub fn decode(bytes: &[u8]) -> Result<Loaded, Error> {
    let mut text = String::new();
    GzDecoder::new(bytes).read_to_string(&mut text)?;
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let header: Header = serde_json::from_str(lines.next().unwrap_or_default())
        .map_err(|e| Error::Msg(format!("snapshot header: {e}")))?;
    if header.v > SNAPSHOT_FORMAT {
        return Err(Error::Msg(
            "A snapshot on the destination was written by a newer manplay. Update to read it."
                .into(),
        ));
    }
    let ops = lines
        .filter_map(|l| serde_json::from_str::<Op>(l).ok())
        .collect();
    Ok(Loaded { header, ops })
}

/// The snapshots on the destination, as clocks, oldest first.
pub async fn list<S: ChunkStore>(store: &S) -> Result<Vec<String>, Error> {
    let mut clocks: Vec<String> = store
        .list_meta(DIR)
        .await?
        .iter()
        .filter_map(|n| parse_name(n))
        .collect();
    clocks.sort();
    Ok(clocks)
}

/// One snapshot; `None` when the file is gone.
pub async fn read<S: ChunkStore>(store: &S, clock: &str) -> Result<Option<Loaded>, Error> {
    match store.read_meta(&path(clock)).await? {
        Some(bytes) => decode(&bytes).map(Some),
        None => Ok(None),
    }
}

// ---- what this device remembers ---------------------------------------------------

pub fn known(conn: &Connection) -> Result<Option<Known>, Error> {
    Ok(db::get_setting(conn, SETTING_KNOWN)?.and_then(|s| serde_json::from_str(&s).ok()))
}

pub fn set_known(conn: &Connection, known: &Known) -> Result<(), Error> {
    let json = serde_json::to_string(known).map_err(|e| json_err(&e))?;
    db::set_setting(conn, SETTING_KNOWN, Some(&json))
}

pub fn last_sync(conn: &Connection) -> Result<Option<i64>, Error> {
    Ok(db::get_setting(conn, SETTING_LAST_SYNC)?.and_then(|s| s.parse().ok()))
}

pub fn set_last_sync(conn: &Connection, ms: i64) -> Result<(), Error> {
    db::set_setting(conn, SETTING_LAST_SYNC, Some(&ms.to_string()))
}

/// Forgets the snapshot state: this device no longer belongs to the library it describes.
pub fn forget(conn: &Connection) -> Result<(), Error> {
    db::set_setting(conn, SETTING_KNOWN, None)?;
    db::set_setting(conn, SETTING_LAST_SYNC, None)
}

// ---- writing ----------------------------------------------------------------------

const ITEM_ENTITIES: [(&str, &str); 3] = [
    ("tag", "track_tag"),
    ("playlist", "playlist_track"),
    ("smart_playlist", ""),
];

/// Smart playlist rules with every tag that was merged into another replaced by what it became,
/// so the rules stay right when the `_merge` tombstone is dropped.
fn follow_merges(conn: &Connection, mut rules: Value) -> Result<Value, Error> {
    if let Some(object) = rules.as_object_mut() {
        for key in ["allTags", "anyTags", "noneTags"] {
            let Some(list) = object.get_mut(key).and_then(Value::as_array_mut) else {
                continue;
            };
            let mut moved: Vec<Value> = Vec::new();
            for entry in list.iter() {
                let next = match entry.as_str() {
                    Some(uid) if crate::smart::is_uid(uid) => {
                        Value::String(state::merge_target(conn, "tag", uid)?)
                    }
                    _ => entry.clone(),
                };
                if !moved.contains(&next) {
                    moved.push(next);
                }
            }
            *list = moved;
        }
    }
    Ok(rules)
}

/// The ops of a snapshot: every register this device holds, except what has aged out. Tombstones
/// (`_delete`, `_merge`) and removed memberships older than `TOMBSTONE_MS` go, with everything
/// else the entity had, so nothing is left to bring it back. Ops of kinds this build does not
/// know, and ops from a newer format, are carried over untouched.
pub fn build(conn: &Connection, now_ms: i64) -> Result<Vec<Op>, Error> {
    let old = clock::before_ms(now_ms - TOMBSTONE_MS);
    let mut gone: HashSet<(String, String)> = HashSet::new();
    let mut gone_parents: HashSet<(&str, String)> = HashSet::new();
    {
        let mut stmt = conn.prepare(
            "SELECT e, id, f, val FROM op_state
             WHERE clock < ?1 AND f IN ('_delete', '_merge', 'present')",
        )?;
        let rows = stmt.query_map(params![old], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        for row in rows {
            let (e, id, f, val) = row?;
            let item = ITEM_ENTITIES.iter().find(|(item, _)| *item == e);
            match (f.as_str(), item) {
                (F_MERGE, Some((_, members))) => {
                    gone_parents.insert((*members, id.clone()));
                    gone.insert((e, id));
                }
                (F_DELETE, Some((_, members))) if val != "false" => {
                    gone_parents.insert((*members, id.clone()));
                    gone.insert((e, id));
                }
                (F_PRESENT, None)
                    if val == "false"
                        && matches!(e.as_str(), "track_tag" | "playlist_track" | "tag_custom") =>
                {
                    gone.insert((e, id));
                }
                _ => {}
            }
        }
    }
    let mut ops = Vec::new();
    let mut stmt = conn.prepare("SELECT e, id, f, clock, val FROM op_state ORDER BY e, id, f")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;
    for row in rows {
        let (e, id, f, clk, raw) = row?;
        let member_parent = id.split_once('/').map(|(parent, _)| parent);
        let belongs_to_gone = ITEM_ENTITIES.iter().any(|(_, members)| {
            *members == e
                && !members.is_empty()
                && member_parent.is_some_and(|p| gone_parents.contains(&(*members, p.to_owned())))
        });
        if belongs_to_gone || gone.contains(&(e.clone(), id.clone())) {
            continue;
        }
        // A restore older than the horizon is the same as never having been deleted.
        if f == F_DELETE && raw == "false" && clk < old {
            continue;
        }
        let mut val: Value = serde_json::from_str(&raw).unwrap_or_default();
        if e == "smart_playlist" && f == F_RULES {
            val = follow_merges(conn, val)?;
        }
        ops.push(Op {
            v: FORMAT,
            dev: clock::device_of(&clk).unwrap_or_default().to_owned(),
            clock: clk,
            e,
            id,
            f,
            val,
        });
    }
    drop(stmt);
    let mut stmt = conn.prepare("SELECT op FROM op_unknown ORDER BY clock")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    for raw in rows {
        if let Ok(op) = serde_json::from_str::<Op>(&raw?) {
            ops.push(op);
        }
    }
    Ok(ops)
}

/// The cursors of this device: how far it has applied each device's chunks.
pub fn cursors(conn: &Connection) -> Result<BTreeMap<String, u64>, Error> {
    let mut stmt = conn.prepare("SELECT dev, seq FROM op_cursor WHERE seq > 0")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (dev, seq) = row?;
        out.insert(dev, u64::try_from(seq).unwrap_or(0));
    }
    Ok(out)
}

/// Whether this device holds less than the snapshot knows of some device.
fn behind(conn: &Connection, covers: &BTreeMap<String, u64>) -> Result<bool, Error> {
    for (dev, seq) in covers {
        if state::cursor(conn, dev)? < *seq {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A snapshot ready to be written: the header and the lines.
pub struct Draft {
    pub header: Header,
    pub ops: Vec<Op>,
}

/// Builds this device's snapshot from what it holds, stamping it with a fresh clock.
pub fn draft(conn: &mut Connection, now_ms: i64) -> Result<Draft, Error> {
    let tx = conn.transaction()?;
    let covers = cursors(&tx)?;
    let me = write::device_id(&tx)?;
    let mut hlc = clock::load(&tx)?;
    let (ms, counter) = hlc.tick(clock::now_ms());
    clock::save(&tx, hlc)?;
    let ops = build(&tx, now_ms)?;
    tx.commit()?;
    Ok(Draft {
        header: Header {
            v: SNAPSHOT_FORMAT,
            format: FORMAT,
            covers,
            clock: clock::format(ms, counter, &me),
            horizon: now_ms - TOMBSTONE_MS,
        },
        ops,
    })
}

pub async fn write<S: ChunkStore>(store: &S, draft: &Draft) -> Result<(), Error> {
    store
        .write_meta(
            &path(&draft.header.clock),
            encode(&draft.header, &draft.ops)?,
        )
        .await
}

// ---- reading ----------------------------------------------------------------------

/// Takes in a snapshot. `stale` is for a device that was away longer than tombstones live: it
/// drops what it sent in that time, applies the snapshot, and forgets everything the snapshot
/// does not have that is older than its horizon (what was deleted meanwhile), then rebuilds the
/// shared rows from what is left.
fn apply_loaded(conn: &Connection, loaded: &Loaded, stale: bool) -> Result<(), Error> {
    let horizon = clock::before_ms(loaded.header.horizon);
    if stale {
        conn.execute(
            "DELETE FROM op_state WHERE clock IN
                 (SELECT clock FROM oplog WHERE uploaded = 0 AND clock < ?1)",
            params![horizon],
        )?;
        conn.execute(
            "DELETE FROM oplog WHERE uploaded = 0 AND clock < ?1",
            params![horizon],
        )?;
    }
    apply_ops(conn, &loaded.ops)?;
    if stale {
        forget_aged_out(conn, loaded, &horizon)?;
        rebuild_rows(conn)?;
    }
    let mut hlc = clock::load(conn)?;
    hlc.observe(&loaded.header.clock);
    for op in &loaded.ops {
        hlc.observe(&op.clock);
    }
    clock::save(conn, hlc)?;
    for (dev, seq) in &loaded.header.covers {
        state::set_cursor(conn, dev, *seq)?;
    }
    Ok(())
}

/// Removes registers older than the horizon that the snapshot does not have: they belong to
/// entities whose tombstones aged out while this device was away.
fn forget_aged_out(conn: &Connection, loaded: &Loaded, horizon: &str) -> Result<(), Error> {
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS snapshot_keys (
             e TEXT NOT NULL, id TEXT NOT NULL, f TEXT NOT NULL, PRIMARY KEY (e, id, f)
         );
         DELETE FROM snapshot_keys;",
    )?;
    {
        let mut insert =
            conn.prepare("INSERT OR IGNORE INTO snapshot_keys (e, id, f) VALUES (?1, ?2, ?3)")?;
        for op in &loaded.ops {
            insert.execute(params![op.e, op.id, op.f])?;
        }
    }
    conn.execute(
        "DELETE FROM op_state WHERE clock < ?1 AND NOT EXISTS
             (SELECT 1 FROM snapshot_keys k
              WHERE k.e = op_state.e AND k.id = op_state.id AND k.f = op_state.f)",
        params![horizon],
    )?;
    conn.execute_batch("DELETE FROM snapshot_keys;")?;
    Ok(())
}

/// Makes the shared rows match the registers after they were pruned: shared items that are no
/// longer named or were deleted go, memberships are laid down again, values that nothing
/// registers go. Local items and hidden marks stay.
fn rebuild_rows(conn: &Connection) -> Result<(), Error> {
    for (table, entity) in [
        ("tags", "tag"),
        ("playlists", "playlist"),
        ("smart_playlists", "smart_playlist"),
    ] {
        conn.execute(
            &format!(
                "DELETE FROM {table} WHERE scope = 'shared' AND (
                     NOT EXISTS (SELECT 1 FROM op_state s WHERE s.e = ?1
                                 AND s.id = COALESCE({table}.uid, '') AND s.f = 'name')
                     OR EXISTS (SELECT 1 FROM op_state s WHERE s.e = ?1
                                AND s.id = COALESCE({table}.uid, '')
                                AND ((s.f = '_delete' AND s.val <> 'false') OR s.f = '_merge')))"
            ),
            params![entity],
        )?;
    }
    conn.execute_batch(
        "DELETE FROM track_tags WHERE tag_id IN (SELECT id FROM tags WHERE scope = 'shared');
         DELETE FROM playlist_tracks WHERE playlist_id IN
             (SELECT id FROM playlists WHERE scope = 'shared');
         DELETE FROM tag_custom WHERE NOT EXISTS
             (SELECT 1 FROM op_state s WHERE s.e = 'tag_custom'
              AND s.id = tag_custom.field || '/' || lower(tag_custom.value)
              AND s.f = 'present' AND s.val = 'true');",
    )?;
    apply::rematerialize_all(conn)?;
    apply::materialize_pending_in(conn)?;
    let fps: Vec<String> = conn
        .prepare("SELECT DISTINCT id FROM op_state WHERE e = 'analysis'")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for fp in fps {
        entities::materialize_analysis(conn, &fp)?;
    }
    let uids: Vec<String> = conn
        .prepare("SELECT DISTINCT id FROM op_state WHERE e = 'smart_playlist' AND f = 'rules'")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for uid in uids {
        entities::materialize_smart_rules(conn, &uid)?;
    }
    Ok(())
}

/// Before a sync reads chunks: loads the newest snapshot when it knows more than this device
/// (a new device, or one behind chunks that were cleaned up), and returns what the newest
/// snapshot covers. A snapshot already seen is not downloaded again.
pub async fn sync_in<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
) -> Result<Option<Known>, Error> {
    let clocks = list(store).await?;
    let stored = {
        let conn = lock(db)?;
        known(&conn)?
    };
    let Some(newest) = clocks.last() else {
        return Ok(stored);
    };
    if stored.as_ref().is_some_and(|k| &k.clock == newest) {
        return Ok(stored);
    }
    let mut loaded = None;
    let mut failure = None;
    for clock in clocks.iter().rev() {
        match read(store, clock).await {
            Ok(Some(l)) => {
                loaded = Some(l);
                break;
            }
            Ok(None) => {}
            Err(e) => failure = Some(e),
        }
    }
    let Some(loaded) = loaded else {
        return failure.map_or(Ok(stored), Err);
    };
    let mut conn = lock(db)?;
    let tx = conn.transaction()?;
    if behind(&tx, &loaded.header.covers)? {
        let stale = last_sync(&tx)?.is_some_and(|t| t < loaded.header.horizon);
        apply_loaded(&tx, &loaded, stale)?;
    }
    let now_known = Known {
        clock: loaded.header.clock.clone(),
        covers: loaded.header.covers.clone(),
    };
    set_known(&tx, &now_known)?;
    tx.commit()?;
    Ok(Some(now_known))
}

/// A device met a hole in another's chunks (`next` of `dev` is gone, later ones are there).
/// Looks through every snapshot for one that covers it and applies it. True if one did.
pub async fn heal<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    dev: &str,
    next: u64,
) -> Result<bool, Error> {
    for clock in list(store).await?.iter().rev() {
        let Some(loaded) = read(store, clock).await? else {
            continue;
        };
        if loaded.header.covers.get(dev).is_some_and(|c| *c >= next) {
            let mut conn = lock(db)?;
            let tx = conn.transaction()?;
            apply_loaded(&tx, &loaded, false)?;
            tx.commit()?;
            return Ok(true);
        }
    }
    Ok(false)
}
