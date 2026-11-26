//! What other devices' edits changed here, kept for 30 days: every sync that brought something
//! in is one batch, listed with who made it and what it did, and can be taken back.
//!
//! The register store only keeps the winner of each field, so the value a field had before is
//! written down here as the ops come in. Taking a batch back writes that value again as this
//! device's own op, so everyone gets it; a field someone has changed since is left alone.
//! A snapshot (a new device, a device far behind) is not a batch: it is the whole library.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::Value;

use super::apply;
use super::ops::{Entity, F_DELETE, F_MERGE, F_NAME, F_POS, F_PRESENT, F_RULES, FORMAT, Op};
use super::recent;
use super::state;
use super::write::{self, Field};
use crate::error::Error;

/// How long a batch is kept, UTC ms.
pub const KEEP_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Names one batch: the UTC ms of the sync that applied it.
pub type BatchId = i64;

/// Unix time in seconds, UTC.
pub type UnixSeconds = i64;

type FieldKey = (String, String, String);

struct Noted {
    /// The field's value before the batch, as JSON; `None` when it had none.
    prev: Option<String>,
    clock: String,
    dev: String,
    val: Value,
}

/// Writes down what `ops` are about to change, as batch `batch`. Call it before the ops are
/// applied, in the same transaction. A field several ops change is one line: the value from
/// before the batch and the op that wins.
pub fn note(conn: &Connection, batch: BatchId, ops: &[Op]) -> Result<usize, Error> {
    let mut noted: BTreeMap<FieldKey, Noted> = BTreeMap::new();
    for op in ops {
        if op.v > FORMAT || matches!(op.entity(), Entity::Other(_)) {
            continue;
        }
        let key = (op.e.clone(), op.id.clone(), op.f.clone());
        if let Some(earlier) = noted.get_mut(&key) {
            if op.clock > earlier.clock {
                earlier.clock.clone_from(&op.clock);
                earlier.dev.clone_from(&op.dev);
                earlier.val = op.val.clone();
            }
            continue;
        }
        let current = state::get_clocked(conn, &op.e, &op.id, &op.f)?;
        if current
            .as_ref()
            .is_some_and(|(clock, _)| *clock >= op.clock)
        {
            continue;
        }
        let prev = current
            .map(|(_, val)| serde_json::to_string(&val))
            .transpose()
            .map_err(|e| Error::Msg(e.to_string()))?;
        noted.insert(
            key,
            Noted {
                prev,
                clock: op.clock.clone(),
                dev: op.dev.clone(),
                val: op.val.clone(),
            },
        );
    }
    let mut insert = conn.prepare_cached(
        "INSERT INTO op_journal (batch, clock, dev, e, id, f, val, prev)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    for ((e, id, f), n) in &noted {
        let val = serde_json::to_string(&n.val).map_err(|e| Error::Msg(e.to_string()))?;
        insert.execute(params![batch, n.clock, n.dev, e, id, f, val, n.prev])?;
    }
    Ok(noted.len())
}

/// Forgets batches older than [`KEEP_MS`].
pub fn prune(conn: &Connection, now_ms: i64) -> Result<(), Error> {
    conn.execute(
        "DELETE FROM op_journal WHERE batch < ?1",
        params![now_ms - KEEP_MS],
    )?;
    Ok(())
}

/// Whether a batch made an item, removed it or brought it back.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Standing {
    /// It was there before the batch and still is.
    #[default]
    Existing,
    Created,
    Deleted,
    Restored,
}

/// What a batch did to one tag, playlist or smart playlist, or to the songs' analysis or the
/// Tag Database's values as a whole.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// `tag`, `playlist`, `smart_playlist`, `analysis` or `tag_custom`.
    pub kind: String,
    /// The item's name now; empty for `analysis` and `tag_custom`.
    pub name: String,
    pub standing: Standing,
    pub renamed_from: Option<String>,
    /// The name of the item it was merged into.
    pub merged_into: Option<String>,
    pub rules_changed: bool,
    pub songs_added: usize,
    pub songs_removed: usize,
    pub songs_moved: usize,
    /// `analysis`: songs whose tempo, key or grid changed. `tag_custom`: values added or removed.
    pub count: usize,
}

/// One sync's worth of other devices' edits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: BatchId,
    pub at: UnixSeconds,
    /// The members who made the edits, by name.
    pub by: Vec<String>,
    pub changes: Vec<Change>,
    pub undone: bool,
}

struct Line {
    batch: BatchId,
    clock: String,
    dev: String,
    e: String,
    id: String,
    f: String,
    val: Value,
    prev: Option<Value>,
    undone: bool,
}

fn lines(conn: &Connection, batch: Option<BatchId>, since: i64) -> Result<Vec<Line>, Error> {
    let mut stmt = conn.prepare(
        "SELECT batch, clock, dev, e, id, f, val, prev, undone FROM op_journal
         WHERE batch >= ?1 AND (?2 IS NULL OR batch = ?2) ORDER BY batch DESC, n",
    )?;
    let rows = stmt.query_map(params![since, batch], |r| {
        let val: String = r.get(6)?;
        let prev: Option<String> = r.get(7)?;
        Ok(Line {
            batch: r.get(0)?,
            clock: r.get(1)?,
            dev: r.get(2)?,
            e: r.get(3)?,
            id: r.get(4)?,
            f: r.get(5)?,
            val: serde_json::from_str(&val).unwrap_or_default(),
            prev: prev.and_then(|p| serde_json::from_str(&p).ok()),
            undone: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The item a membership belongs to: `(its entity, its uid)`.
fn parent_of(line: &Line) -> Option<(&str, &str)> {
    let kind = match line.e.as_str() {
        "track_tag" => "tag",
        "playlist_track" => "playlist",
        _ => return None,
    };
    line.id.split_once('/').map(|(parent, _)| (kind, parent))
}

fn name_of(conn: &Connection, kind: &str, uid: &str) -> Result<String, Error> {
    Ok(state::get_str(conn, kind, uid, F_NAME)?.unwrap_or_default())
}

/// Sums up the lines of one batch per item.
fn changes_of(conn: &Connection, batch: &[&Line]) -> Result<Vec<Change>, Error> {
    let mut items: BTreeMap<(&str, &str), Change> = BTreeMap::new();
    let mut analysed: BTreeSet<&str> = BTreeSet::new();
    let mut values: BTreeSet<&str> = BTreeSet::new();
    // A song added to or taken out of a list also gets a position: that is not a move.
    let came_or_went: BTreeSet<&str> = batch
        .iter()
        .filter(|l| l.f == F_PRESENT)
        .map(|l| l.id.as_str())
        .collect();
    for line in batch {
        match line.e.as_str() {
            "analysis" => {
                analysed.insert(&line.id);
            }
            "tag_custom" => {
                values.insert(&line.id);
            }
            "tag" | "playlist" | "smart_playlist" => {
                let kind: &str = &line.e;
                let change = items.entry((kind, &line.id)).or_default();
                match line.f.as_str() {
                    F_NAME => match line.prev.as_ref().and_then(Value::as_str) {
                        Some(before) if Some(before) != line.val.as_str() => {
                            change.renamed_from = Some(before.to_owned());
                        }
                        Some(_) => {}
                        None => change.standing = Standing::Created,
                    },
                    F_DELETE if line.val == Value::Bool(false) => {
                        change.standing = Standing::Restored;
                    }
                    F_DELETE => change.standing = Standing::Deleted,
                    F_MERGE => {
                        change.merged_into = line
                            .val
                            .as_str()
                            .map(|target| name_of(conn, kind, target))
                            .transpose()?;
                    }
                    F_RULES => change.rules_changed = true,
                    _ => {}
                }
            }
            _ => {
                let Some(parent) = parent_of(line) else {
                    continue;
                };
                let change = items.entry(parent).or_default();
                match line.f.as_str() {
                    F_PRESENT if line.val == Value::Bool(true) => change.songs_added += 1,
                    F_PRESENT => change.songs_removed += 1,
                    F_POS if !came_or_went.contains(line.id.as_str()) => change.songs_moved += 1,
                    _ => {}
                }
            }
        }
    }
    let mut out = Vec::new();
    for ((kind, uid), mut change) in items {
        kind.clone_into(&mut change.kind);
        change.name = name_of(conn, kind, uid)?;
        // A new item's rules say nothing its own line does not.
        if change.standing == Standing::Created {
            change.rules_changed = false;
        }
        out.push(change);
    }
    if !analysed.is_empty() {
        out.push(Change {
            kind: "analysis".to_owned(),
            count: analysed.len(),
            ..Change::default()
        });
    }
    if !values.is_empty() {
        out.push(Change {
            kind: "tag_custom".to_owned(),
            count: values.len(),
            ..Change::default()
        });
    }
    Ok(out)
}

/// The batches of the last 30 days, newest first.
pub fn list(conn: &Connection, now_ms: i64) -> Result<Vec<Batch>, Error> {
    let all = lines(conn, None, now_ms - KEEP_MS)?;
    let mut by_batch: BTreeMap<BatchId, Vec<&Line>> = BTreeMap::new();
    for line in &all {
        by_batch.entry(line.batch).or_default().push(line);
    }
    let mut out = Vec::new();
    for (id, batch) in by_batch.into_iter().rev() {
        let devices: BTreeSet<&str> = batch.iter().map(|l| l.dev.as_str()).collect();
        let by: BTreeSet<String> = devices
            .into_iter()
            .map(|dev| recent::member_name(conn, dev))
            .collect();
        out.push(Batch {
            id,
            at: id / 1000,
            by: by.into_iter().collect(),
            changes: changes_of(conn, &batch)?,
            undone: batch.iter().all(|l| l.undone),
        });
    }
    Ok(out)
}

/// What taking a batch back did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Undone {
    /// Fields put back to what they were.
    pub reverted: usize,
    /// Fields left as they are: someone changed them since, or the change cannot be taken back
    /// (a merge).
    pub skipped: usize,
}

/// What puts one line back, if anything can.
enum Reversal {
    Write(Field),
    /// The line deleted an item: it comes back with its songs (`recent::restore_in`).
    Restore,
    None,
}

fn is_item(e: &str) -> bool {
    matches!(e, "tag" | "playlist" | "smart_playlist")
}

fn reversal(line: &Line) -> Reversal {
    let write = |f: &str, val: Value| {
        Reversal::Write(Field {
            e: line.e.clone(),
            id: line.id.clone(),
            f: f.to_owned(),
            val,
        })
    };
    match (line.f.as_str(), &line.prev) {
        (F_MERGE, _) => Reversal::None,
        (F_DELETE, _) if line.val != Value::Bool(false) => {
            if is_item(&line.e) {
                Reversal::Restore
            } else {
                Reversal::None
            }
        }
        (f, Some(prev)) => write(f, prev.clone()),
        (F_PRESENT, None) => write(F_PRESENT, Value::Bool(false)),
        // The line made the item: taking it back deletes it.
        (F_NAME, None) if is_item(&line.e) => write(F_DELETE, Value::Null),
        _ => Reversal::None,
    }
}

/// Takes a batch back for everyone: each field it changed, and that nobody has changed since,
/// gets the value it had before, written as this device's own edit.
pub fn undo(conn: &mut Connection, batch: BatchId, now_ms: i64) -> Result<Undone, Error> {
    let tx = conn.transaction()?;
    if !write::active(&tx)? {
        return Err(Error::Msg("This device is not in a shared library.".into()));
    }
    let batch_lines = lines(&tx, Some(batch), now_ms - KEEP_MS)?;
    if batch_lines.is_empty() || batch_lines.iter().all(|l| l.undone) {
        return Err(Error::Msg("Those changes can no longer be undone.".into()));
    }
    // A rename or merge of a tag cannot be taken back, so what it moved onto the item it became
    // stays there too: taking that back would leave the songs on neither.
    let merged_into: BTreeSet<(&str, &str)> = batch_lines
        .iter()
        .filter(|l| l.f == F_MERGE)
        .filter_map(|l| Some((l.e.as_str(), l.val.as_str()?)))
        .collect();
    let mut out = Undone::default();
    let mut fields = Vec::new();
    let mut restores: Vec<&Line> = Vec::new();
    for line in &batch_lines {
        let item = parent_of(line).unwrap_or((line.e.as_str(), line.id.as_str()));
        if merged_into.contains(&item) {
            out.skipped += 1;
            continue;
        }
        let still_stands = state::get_clocked(&tx, &line.e, &line.id, &line.f)?
            .is_some_and(|(clock, _)| clock == line.clock);
        match reversal(line) {
            Reversal::Write(field) if still_stands => fields.push(field),
            Reversal::Restore if still_stands => restores.push(line),
            _ => out.skipped += 1,
        }
    }
    let stamped = write::stamp(&tx, &fields)?;
    apply::materialize(&tx, &stamped.iter().collect::<Vec<_>>())?;
    out.reverted = stamped.len();
    for line in restores {
        recent::restore_in(&tx, &line.e, &line.id, now_ms)?;
        out.reverted += 1;
    }
    tx.execute(
        "UPDATE op_journal SET undone = 1 WHERE batch = ?1",
        params![batch],
    )?;
    tx.commit()?;
    Ok(out)
}
