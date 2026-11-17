//! Chunk files on the destination, and a sync run over them.
//!
//! Layout: `.manplay/log/<device>/<seq>.jsonl.gz`, `seq` zero-padded, never rewritten. A device
//! only ever writes under its own folder.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::io::{Read, Write};
use std::sync::Mutex;

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use rusqlite::{Connection, params};
use serde::Serialize;

use super::apply::apply_ops;
use super::clock;
use super::ops::Op;
use super::snapshot;
use super::state;
use super::waveforms::WaveformRef;
use super::write::device_id;
use crate::error::Error;

/// Folder under the library root that holds everything manplay shares.
pub const DIR: &str = ".manplay";
pub const LOG_DIR: &str = "log";
const SUFFIX: &str = ".jsonl.gz";

/// One chunk on the destination.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ChunkRef {
    pub dev: String,
    pub seq: u64,
}

/// A chunk and how big its file is, for deciding when the log is big enough to compact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkInfo {
    pub chunk: ChunkRef,
    pub size: u64,
}

pub fn chunk_name(seq: u64) -> String {
    format!("{seq:08}{SUFFIX}")
}

/// `seq` of a chunk file name; anything else in the folder (temp files) is not a chunk.
pub fn parse_chunk_name(name: &str) -> Option<u64> {
    let digits = name.strip_suffix(SUFFIX)?;
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
        .then(|| digits.parse().ok())
        .flatten()
}

/// Where chunks live. The real one is a `WebDAV` or R2 destination (`sync.rs`); tests use memory.
pub trait ChunkStore {
    /// Every chunk of every device.
    fn list_chunks(&self) -> impl Future<Output = Result<Vec<ChunkInfo>, Error>> + Send;
    /// Removes a chunk; one that is already gone counts as removed.
    fn delete_chunk(&self, chunk: &ChunkRef) -> impl Future<Output = Result<(), Error>> + Send;
    /// Every waveform file on the destination.
    fn list_waveforms(&self) -> impl Future<Output = Result<Vec<WaveformRef>, Error>> + Send;
    /// Removes a waveform file; one that is already gone counts as removed.
    fn delete_waveform(
        &self,
        waveform: &WaveformRef,
    ) -> impl Future<Output = Result<(), Error>> + Send;
    fn read_chunk(&self, chunk: &ChunkRef) -> impl Future<Output = Result<Vec<u8>, Error>> + Send;
    /// Stores a new chunk. Fails if that chunk exists: chunks are never replaced.
    fn write_chunk(
        &self,
        chunk: &ChunkRef,
        bytes: Vec<u8>,
    ) -> impl Future<Output = Result<(), Error>> + Send;
    /// Whether a waveform file is on the destination (a HEAD request, no download).
    fn waveform_exists(
        &self,
        waveform: &WaveformRef,
    ) -> impl Future<Output = Result<bool, Error>> + Send;
    /// The waveform file, or `None` when it is not there.
    fn read_waveform(
        &self,
        waveform: &WaveformRef,
    ) -> impl Future<Output = Result<Option<Vec<u8>>, Error>> + Send;
    /// Stores a waveform file. Files are written once: one that exists is left as it is.
    fn write_waveform(
        &self,
        waveform: &WaveformRef,
        bytes: Vec<u8>,
    ) -> impl Future<Output = Result<(), Error>> + Send;
    /// A small file under `.manplay/` (`library.json`, `devices/<id>.json`, `.ignore`), by its
    /// `/`-separated path there; `None` when it is not there.
    fn read_meta(&self, path: &str) -> impl Future<Output = Result<Option<Vec<u8>>, Error>> + Send;
    /// Writes (or replaces) a small file under `.manplay/`.
    fn write_meta(
        &self,
        path: &str,
        bytes: Vec<u8>,
    ) -> impl Future<Output = Result<(), Error>> + Send;
    /// Removes a small file under `.manplay/`; one that is already gone counts as removed.
    fn delete_meta(&self, path: &str) -> impl Future<Output = Result<(), Error>> + Send;
    /// The names of the files directly inside a folder of `.manplay/`; empty when it is missing.
    fn list_meta(&self, dir: &str) -> impl Future<Output = Result<Vec<String>, Error>> + Send;
}

pub fn encode(ops: &[Op]) -> Result<Vec<u8>, Error> {
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    for op in ops {
        serde_json::to_writer(&mut gz, op).map_err(|e| Error::Msg(e.to_string()))?;
        gz.write_all(b"\n")?;
    }
    Ok(gz.finish()?)
}

/// The ops of a chunk, and how many lines could not be read (kept out, not fatal).
pub fn decode(bytes: &[u8]) -> Result<(Vec<Op>, usize), Error> {
    let mut text = String::new();
    GzDecoder::new(bytes).read_to_string(&mut text)?;
    let mut ops = Vec::new();
    let mut bad = 0;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        match serde_json::from_str::<Op>(line) {
            Ok(op) => ops.push(op),
            Err(_) => bad += 1,
        }
    }
    Ok((ops, bad))
}

/// What one run did.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    /// Own ops uploaded.
    pub sent: usize,
    /// Ops read from other devices.
    pub received: usize,
    /// Lines in other devices' chunks that could not be read.
    pub unreadable: usize,
    /// Set when something stopped the run part-way; what was done before it stays done.
    pub error: Option<String>,
}

fn lock(db: &Mutex<Connection>) -> Result<std::sync::MutexGuard<'_, Connection>, Error> {
    db.lock().map_err(|_| Error::Lock)
}

fn unuploaded(conn: &Connection) -> Result<Vec<Op>, Error> {
    let mut stmt = conn
        .prepare("SELECT clock, dev, e, id, f, val FROM oplog WHERE uploaded = 0 ORDER BY clock")?;
    let rows = stmt.query_map([], |r| {
        let val: String = r.get(5)?;
        Ok(Op {
            v: super::ops::FORMAT,
            clock: r.get(0)?,
            dev: r.get(1)?,
            e: r.get(2)?,
            id: r.get(3)?,
            f: r.get(4)?,
            val: serde_json::from_str(&val).unwrap_or_default(),
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// One sync of library data: uploads this device's new ops as a chunk, then downloads and
/// applies the chunks of the other devices. The database lock is held only between awaits.
#[cfg(test)]
pub async fn run<S: ChunkStore>(db: &Mutex<Connection>, store: &S) -> RunSummary {
    run_at(db, store, clock::now_ms()).await
}

/// [`run`] at a given time (UTC ms), which decides whether this device was away so long that it
/// must start over from the snapshot.
pub async fn run_at<S: ChunkStore>(db: &Mutex<Connection>, store: &S, now_ms: i64) -> RunSummary {
    let mut summary = RunSummary::default();
    if let Err(e) = run_inner(db, store, now_ms, &mut summary).await {
        summary.error = Some(e.to_string());
    }
    summary
}

/// Writes `pending` as this device's next chunk and marks the ops uploaded. The number is never
/// one a snapshot already covers: those chunks may have been cleaned up, and a reader would skip
/// a new chunk with an old number.
async fn upload<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    own: &str,
    pending: &[Op],
    listed: &[ChunkRef],
    covered: u64,
) -> Result<(), Error> {
    let remote_max = listed
        .iter()
        .filter(|c| c.dev == own)
        .map(|c| c.seq)
        .max()
        .unwrap_or(0);
    let seq = {
        let conn = lock(db)?;
        state::cursor(&conn, own)?.max(remote_max).max(covered) + 1
    };
    store
        .write_chunk(
            &ChunkRef {
                dev: own.to_owned(),
                seq,
            },
            encode(pending)?,
        )
        .await?;
    let mut conn = lock(db)?;
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE oplog SET uploaded = 1 WHERE clock = ?1")?;
        for op in pending {
            stmt.execute(params![op.clock])?;
        }
    }
    state::set_cursor(&tx, own, seq)?;
    tx.commit()?;
    Ok(())
}

async fn run_inner<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    now_ms: i64,
    summary: &mut RunSummary,
) -> Result<(), Error> {
    // 0. A newer snapshot than this device has seen: load it first, so a device that is behind
    // chunks that were cleaned up, or is new, starts from it. It can also drop what this device
    // sent too long ago, so what is uploaded is read after it.
    let known = snapshot::sync_in(db, store).await?;
    let (own, pending) = {
        let conn = lock(db)?;
        (device_id(&conn)?, unuploaded(&conn)?)
    };
    let listed: Vec<ChunkRef> = store
        .list_chunks()
        .await?
        .into_iter()
        .map(|c| c.chunk)
        .collect();

    // 1. Upload own new ops as one chunk.
    if !pending.is_empty() {
        let covered = known
            .as_ref()
            .and_then(|k| k.covers.get(&own).copied())
            .unwrap_or(0);
        upload(db, store, &own, &pending, &listed, covered).await?;
        summary.sent = pending.len();
    }

    // 2. Download what other devices wrote since the last run, in order, without gaps.
    let mut by_device: BTreeMap<&str, BTreeSet<u64>> = BTreeMap::new();
    for c in listed.iter().filter(|c| c.dev != own) {
        by_device.entry(&c.dev).or_default().insert(c.seq);
    }
    let mut fetched: Vec<(String, u64, Vec<Op>)> = Vec::new();
    let mut failure: Option<Error> = None;
    'devices: for (dev, seqs) in by_device {
        let mut next = {
            let conn = lock(db)?;
            state::cursor(&conn, dev)? + 1
        };
        let mut healed = false;
        loop {
            if !seqs.contains(&next) {
                // Later chunks exist but this one is gone: it was cleaned up after a snapshot
                // that covers it. Another snapshot than the newest may hold what is missing.
                if !healed && seqs.range(next + 1..).next().is_some() {
                    healed = true;
                    if snapshot::heal(db, store, dev, next).await? {
                        next = {
                            let conn = lock(db)?;
                            state::cursor(&conn, dev)? + 1
                        };
                        continue;
                    }
                }
                break;
            }
            let chunk = ChunkRef {
                dev: dev.to_owned(),
                seq: next,
            };
            let read = store
                .read_chunk(&chunk)
                .await
                .and_then(|bytes| decode(&bytes));
            match read {
                Ok((ops, bad)) => {
                    summary.unreadable += bad;
                    fetched.push((chunk.dev, next, ops));
                    next += 1;
                }
                Err(e) => {
                    failure = Some(Error::Msg(format!("{dev} chunk {next}: {e}")));
                    continue 'devices;
                }
            }
        }
    }

    // 3. Apply everything in clock order and move the cursors, in one transaction.
    if !fetched.is_empty() {
        let mut conn = lock(db)?;
        let tx = conn.transaction()?;
        let mut all: Vec<&Op> = fetched.iter().flat_map(|(_, _, ops)| ops).collect();
        all.sort_by(|a, b| a.clock.cmp(&b.clock));
        let mut hlc = clock::load(&tx)?;
        for op in &all {
            hlc.observe(&op.clock);
        }
        clock::save(&tx, hlc)?;
        let ops: Vec<Op> = all.into_iter().cloned().collect();
        summary.received = ops.len();
        apply_ops(&tx, &ops)?;
        for (dev, seq, _) in &fetched {
            state::set_cursor(&tx, dev, *seq)?;
        }
        tx.commit()?;
    }
    if failure.is_none() {
        let conn = lock(db)?;
        snapshot::set_last_sync(&conn, now_ms)?;
    }
    failure.map_or(Ok(()), Err)
}
