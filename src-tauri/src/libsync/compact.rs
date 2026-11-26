//! Keeping the destination small: writing a snapshot when the log has grown, and removing what
//! a snapshot made unnecessary.
//!
//! Every device deletes only its own chunks and its own older snapshots. The one exception is a
//! device that is gone for good (no `devices/<id>.json`, nothing newer than 90 days): whoever
//! compacts removes its chunks once a snapshot covers them. See
//! `docs/plans/shared-library/06-compaction.md`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Mutex;

use rusqlite::Connection;

use super::membership::{self, DEVICES_DIR, DeviceFile};
use super::remote::{ChunkInfo, ChunkRef, ChunkStore, decode};
use super::snapshot::{self, Known, TOMBSTONE_MS};
use super::waveforms::WaveformRef;
use super::write::device_id;
use super::{clock, ops};
use crate::error::Error;

/// A snapshot is written when the chunks it would cover add up to more than this (gzipped).
pub const THRESHOLD: u64 = 2 * 1024 * 1024;

/// What one pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// The clock of the snapshot written, if this pass wrote one.
    pub snapshot: Option<String>,
    pub chunks_deleted: usize,
    pub snapshots_deleted: usize,
    pub waveforms_deleted: usize,
    pub covers_deleted: usize,
    /// Rows of this device's own op log dropped because a snapshot holds what they said.
    pub ops_pruned: usize,
}

fn lock(db: &Mutex<Connection>) -> Result<std::sync::MutexGuard<'_, Connection>, Error> {
    db.lock().map_err(|_| Error::Lock)
}

/// After a sync: writes a snapshot if the chunks past the newest one add up to more than
/// `threshold` bytes, then cleans up what the newest snapshot covers. A library written by a
/// newer format is left alone.
pub async fn maybe<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    now_ms: i64,
    threshold: u64,
) -> Result<Outcome, Error> {
    let mut out = Outcome::default();
    if membership::library_format(store)
        .await?
        .is_some_and(|f| f > membership::LIBRARY_FORMAT)
    {
        return Ok(out);
    }
    let listed = store.list_chunks().await?;
    let known = {
        let conn = lock(db)?;
        snapshot::known(&conn)?
    };
    let covers = known.as_ref().map(|k| k.covers.clone()).unwrap_or_default();
    let past_covers = |c: &ChunkInfo| c.chunk.seq > covers.get(&c.chunk.dev).copied().unwrap_or(0);
    let uncovered: u64 = listed
        .iter()
        .filter(|c| past_covers(c))
        .map(|c| c.size)
        .sum();
    let mut wrote = false;
    if uncovered > threshold {
        let cursors = {
            let conn = lock(db)?;
            snapshot::cursors(&conn)?
        };
        let advances = cursors
            .iter()
            .any(|(dev, seq)| *seq > covers.get(dev).copied().unwrap_or(0));
        // A snapshot this device has not read yet: let the next sync take it in first.
        let newer = snapshot::list(store)
            .await?
            .last()
            .is_some_and(|top| known.as_ref().is_none_or(|k| *top > k.clock));
        if advances && !newer {
            let draft = {
                let mut conn = lock(db)?;
                snapshot::draft(&mut conn, now_ms)?
            };
            snapshot::write(store, &draft).await?;
            {
                let conn = lock(db)?;
                snapshot::set_known(
                    &conn,
                    &Known {
                        clock: draft.header.clock.clone(),
                        covers: draft.header.covers.clone(),
                    },
                )?;
            }
            out.snapshot = Some(draft.header.clock);
            wrote = true;
        }
    }
    clean_up(db, store, now_ms, &listed, wrote, &mut out).await?;
    Ok(out)
}

/// The most every snapshot on the destination agrees is covered, per device: chunks at or below
/// it are in all of them, so whichever a reader picks it does not need them. `None` when a
/// snapshot cannot be read (nothing is deleted then).
async fn safe_covers<S: ChunkStore>(
    store: &S,
    known: &Known,
    clocks: &[String],
) -> Option<BTreeMap<String, u64>> {
    let mut covers = known.covers.clone();
    for clock in clocks.iter().filter(|c| **c != known.clock) {
        let loaded = snapshot::read(store, clock).await.ok().flatten()?;
        for (dev, seq) in &mut covers {
            *seq = (*seq).min(loaded.header.covers.get(dev).copied().unwrap_or(0));
        }
    }
    Some(covers)
}

async fn clean_up<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    now_ms: i64,
    listed: &[ChunkInfo],
    wrote: bool,
    out: &mut Outcome,
) -> Result<(), Error> {
    let (me, known, cursor) = {
        let conn = lock(db)?;
        let me = device_id(&conn)?;
        let cursor = super::state::cursor(&conn, &me)?;
        (me, snapshot::known(&conn)?, cursor)
    };
    let Some(known) = known else {
        return Ok(());
    };
    let clocks = snapshot::list(store).await?;
    // The snapshot this device knows is gone (someone replaced it): the next sync reads the new
    // one, and nothing is deleted on a guess.
    if !clocks.contains(&known.clock) {
        return Ok(());
    }
    let Some(covers) = safe_covers(store, &known, &clocks).await else {
        return Ok(());
    };
    // Own older snapshots.
    let top = clocks.last().cloned();
    for clock in &clocks {
        if clock::device_of(clock) == Some(me.as_str()) && Some(clock) != top.as_ref() {
            store.delete_meta(&snapshot::path(clock)).await?;
            out.snapshots_deleted += 1;
        }
    }
    // Own chunks the snapshot holds.
    let upto = covers.get(&me).copied().unwrap_or(0).min(cursor);
    for c in listed
        .iter()
        .filter(|c| c.chunk.dev == me && c.chunk.seq <= upto)
    {
        store.delete_chunk(&c.chunk).await?;
        out.chunks_deleted += 1;
    }
    // The local log only has to hold what is not on the destination yet: what an uploaded chunk
    // said is now in the snapshot (and in `op_state`).
    {
        let conn = lock(db)?;
        out.ops_pruned = conn.execute(
            "DELETE FROM oplog WHERE uploaded = 1 AND seq IS NOT NULL AND seq <= ?1 AND dev = ?2",
            rusqlite::params![i64::try_from(upto).unwrap_or(i64::MAX), me],
        )?;
    }
    if wrote {
        out.chunks_deleted += clean_abandoned(store, &me, &covers, listed, now_ms).await?;
        out.waveforms_deleted += clean_waveforms(db, store).await?;
        let aging = {
            let conn = lock(db)?;
            super::skew::old_things_may_go(&conn, now_ms)?
        };
        if aging {
            out.covers_deleted += super::covers::clean(db, store, now_ms).await?;
        }
    }
    Ok(())
}

/// Chunks of devices that are gone for good and are covered by the snapshot: no member file, and
/// nothing they wrote in the last 90 days.
async fn clean_abandoned<S: ChunkStore>(
    store: &S,
    me: &str,
    covers: &BTreeMap<String, u64>,
    listed: &[ChunkInfo],
    now_ms: i64,
) -> Result<usize, Error> {
    let members: HashSet<String> = store
        .list_meta(DEVICES_DIR)
        .await?
        .iter()
        .filter_map(|n| n.strip_suffix(".json").map(str::to_owned))
        .collect();
    let mut by_device: BTreeMap<&str, Vec<u64>> = BTreeMap::new();
    for c in listed {
        if c.chunk.dev != me && !members.contains(&c.chunk.dev) {
            by_device.entry(&c.chunk.dev).or_default().push(c.chunk.seq);
        }
    }
    let mut deleted = 0;
    for (dev, mut seqs) in by_device {
        seqs.sort_unstable();
        let covered = covers.get(dev).copied().unwrap_or(0);
        let Some(&newest) = seqs.last() else {
            continue;
        };
        if seqs.first().is_none_or(|first| *first > covered) {
            continue;
        }
        let last = store
            .read_chunk(&ChunkRef {
                dev: dev.to_owned(),
                seq: newest,
            })
            .await
            .ok()
            .and_then(|bytes| decode(&bytes).ok());
        let Some((ops, _)) = last else {
            continue;
        };
        let latest_ms = ops
            .iter()
            .filter_map(|op| clock::parse(&op.clock).map(|(ms, _)| ms))
            .max()
            .unwrap_or(0);
        if now_ms - latest_ms < TOMBSTONE_MS {
            continue;
        }
        for seq in seqs.into_iter().filter(|s| *s <= covered) {
            store
                .delete_chunk(&ChunkRef {
                    dev: dev.to_owned(),
                    seq,
                })
                .await?;
            deleted += 1;
        }
    }
    Ok(deleted)
}

/// Waveform files nothing refers to: audio no op and no track of this library mentions, and
/// analysis versions no device uses any more (and no song's current analysis is on).
async fn clean_waveforms<S: ChunkStore>(db: &Mutex<Connection>, store: &S) -> Result<usize, Error> {
    // Files first, then the chunks: a waveform is uploaded after the chunk that names its audio,
    // so anything listed here has its ops among the chunks listed next. If some of those are
    // not applied yet, this device cannot tell an orphan from a new file and leaves them.
    let files = store.list_waveforms().await?;
    if files.is_empty() {
        return Ok(0);
    }
    let me = {
        let conn = lock(db)?;
        device_id(&conn)?
    };
    for c in store.list_chunks().await? {
        let applied = {
            let conn = lock(db)?;
            super::state::cursor(&conn, &c.chunk.dev)?
        };
        if c.chunk.dev != me && c.chunk.seq > applied {
            return Ok(0);
        }
    }
    let mut in_use: BTreeSet<i64> = BTreeSet::from([crate::analysis::VERSION]);
    let mut versions_known = true;
    for name in store.list_meta(DEVICES_DIR).await? {
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        let device = store
            .read_meta(&format!("{DEVICES_DIR}/{id}.json"))
            .await?
            .and_then(|b| serde_json::from_slice::<DeviceFile>(&b).ok());
        match device {
            Some(d) if d.analysis_version > 0 => {
                in_use.insert(d.analysis_version);
            }
            _ => versions_known = false,
        }
    }
    let (live, current): (HashSet<String>, HashMap<String, i64>) = {
        let conn = lock(db)?;
        let mut live: HashSet<String> = conn
            .prepare("SELECT DISTINCT id FROM op_state WHERE e = 'analysis'")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        live.extend(
            conn.prepare("SELECT DISTINCT audio_fp FROM tracks WHERE audio_fp <> ''")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?,
        );
        let current = conn
            .prepare("SELECT id, val FROM op_state WHERE e = 'analysis' AND f = ?1")?
            .query_map([ops::A_VERSION], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter_map(|(id, val)| Some((id, val.parse().ok()?)))
            .collect();
        (live, current)
    };
    let mut deleted = 0;
    for file in files {
        let orphan = !live.contains(&file.audio_fp);
        let outdated = versions_known
            && !in_use.contains(&file.version)
            && current.get(&file.audio_fp) != Some(&file.version);
        if orphan || outdated {
            store.delete_waveform(&file).await?;
            deleted += 1;
        }
    }
    Ok(deleted)
}

/// Parses a waveform file name (`<audio_fp>-v<version>.bin`).
pub fn parse_waveform_name(name: &str) -> Option<WaveformRef> {
    WaveformRef::from_file_name(name)
}
