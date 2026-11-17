//! Waveforms on the destination: files, not ops. They are big, never edited, and the same audio
//! gives the same waveform, so a file is written once and whoever uploads first wins.
//!
//! Path: `.manplay/waveforms/<first 2 of audio_fp>/<audio_fp>-v<analysis version>.bin`, holding
//! the raw `analysis.waveform` blob.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use super::remote::ChunkStore;
use crate::analysis;
use crate::error::Error;

/// Folder under `.manplay` that holds the waveform files.
pub const DIR: &str = "waveforms";
/// A waveform larger than this is neither uploaded nor fetched.
pub const MAX_BYTES: usize = 1024 * 1024;

/// One waveform file on the destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaveformRef {
    pub audio_fp: String,
    pub version: i64,
}

impl WaveformRef {
    /// For a song with this analysis row version; audio whose row only holds hand edits
    /// (version 0) has a waveform of the current analysis.
    pub fn new(audio_fp: &str, row_version: i64) -> Self {
        Self {
            audio_fp: audio_fp.to_owned(),
            version: if row_version > 0 {
                row_version
            } else {
                analysis::VERSION
            },
        }
    }

    /// The folder below `waveforms` and the file name; `None` for a print that is not safe to
    /// put in a path. Prints look like `a1:<hex>`: the `:` becomes `_` in the name (`WebDAV` and
    /// Windows paths refuse `:`), and the folder is the first two characters of the hash, so files
    /// spread over folders instead of all landing in `a1`.
    pub fn rel(&self) -> Option<(String, String)> {
        let safe = !self.audio_fp.is_empty()
            && self
                .audio_fp
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b':');
        let hash = self.audio_fp.rsplit(':').next()?;
        (safe && hash.len() >= 2).then(|| {
            (
                hash.chars().take(2).collect(),
                format!("{}-v{}.bin", self.audio_fp.replace(':', "_"), self.version),
            )
        })
    }

    /// The waveform a file name stands for (see [`Self::rel`]); `None` for any other name.
    pub fn from_file_name(name: &str) -> Option<Self> {
        let stem = name.strip_suffix(".bin")?;
        let (fp, version) = stem.rsplit_once("-v")?;
        let w = Self {
            audio_fp: fp.replace('_', ":"),
            version: version.parse().ok()?,
        };
        (w.rel()?.1 == name).then_some(w)
    }
}

/// Waveforms that were not found on the destination (or could not be asked for) since the last
/// sync, so showing the same song again does not ask again.
#[derive(Default)]
pub struct Misses(Mutex<HashSet<String>>);

impl Misses {
    pub fn clear(&self) {
        if let Ok(mut set) = self.0.lock() {
            set.clear();
        }
    }

    pub fn contains(&self, fp: &str) -> bool {
        self.0.lock().is_ok_and(|set| set.contains(fp))
    }

    fn add(&self, fp: &str) {
        if let Ok(mut set) = self.0.lock() {
            set.insert(fp.to_owned());
        }
    }
}

fn lock(db: &Mutex<Connection>) -> Result<std::sync::MutexGuard<'_, Connection>, Error> {
    db.lock().map_err(|_| Error::Lock)
}

/// What an upload pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PushSummary {
    pub sent: usize,
    /// Already on the destination (written by this or another device).
    pub existed: usize,
    /// Over the size cap, never uploaded.
    pub too_big: usize,
}

/// How many waveforms [`push`] still has to check or send.
pub fn push_pending(db: &Mutex<Connection>) -> Result<usize, Error> {
    let n: i64 = lock(db)?.query_row(
        "SELECT COUNT(*) FROM analysis
         WHERE waveform IS NOT NULL AND wf_pushed = 0 AND audio_fp <> ''",
        [],
        |r| r.get(0),
    )?;
    Ok(usize::try_from(n).unwrap_or(0))
}

/// How many waveforms [`fill`] would still try to download (songs missing one, not known to be
/// absent from the destination).
pub fn fill_pending(db: &Mutex<Connection>, misses: &Misses) -> Result<usize, Error> {
    Ok(wanted(db)?.iter().filter(|fp| !misses.contains(fp)).count())
}

/// Prints of present songs whose analysis came from ops but whose waveform is not here yet.
fn wanted(db: &Mutex<Connection>) -> Result<Vec<String>, Error> {
    let conn = lock(db)?;
    let mut stmt = conn.prepare(
        "SELECT a.audio_fp FROM analysis a
         WHERE a.waveform IS NULL AND a.version > 0 AND a.audio_fp <> ''
           AND EXISTS (SELECT 1 FROM tracks t WHERE t.audio_fp = a.audio_fp
                       AND t.missing_since IS NULL)
         ORDER BY a.audio_fp",
    )?;
    Ok(stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?)
}

/// Uploads up to `limit` waveforms the destination may not have: for each, a check that the
/// file does not exist yet, then the write. Whatever is left goes in the next run.
pub async fn push<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    limit: usize,
) -> Result<PushSummary, Error> {
    let todo: Vec<(String, i64, i64)> = {
        let conn = lock(db)?;
        let mut stmt = conn.prepare(
            "SELECT audio_fp, version, length(waveform) FROM analysis
             WHERE waveform IS NOT NULL AND wf_pushed = 0 AND audio_fp <> ''
             ORDER BY analyzed_at DESC LIMIT ?1",
        )?;
        stmt.query_map(params![i64::try_from(limit).unwrap_or(i64::MAX)], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<Result<_, _>>()?
    };
    let mut out = PushSummary::default();
    for (fp, version, len) in todo {
        let w = WaveformRef::new(&fp, version);
        let done = |conn: &Connection| {
            conn.execute(
                "UPDATE analysis SET wf_pushed = 1 WHERE audio_fp = ?1",
                params![fp],
            )
        };
        if usize::try_from(len).map_or(true, |l| l > MAX_BYTES) || w.rel().is_none() {
            done(&*lock(db)?)?;
            out.too_big += 1;
            continue;
        }
        if store.waveform_exists(&w).await? {
            done(&*lock(db)?)?;
            out.existed += 1;
            continue;
        }
        let bytes: Option<Vec<u8>> = lock(db)?
            .query_row(
                "SELECT waveform FROM analysis WHERE audio_fp = ?1",
                params![fp],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        if let Some(bytes) = bytes {
            store.write_waveform(&w, bytes).await?;
            out.sent += 1;
        }
        done(&*lock(db)?)?;
    }
    Ok(out)
}

/// Fetches the waveform of one song from the destination into `analysis.waveform`, if the song
/// has none yet. True when it was filled. A file that is not there (or too big) is remembered in
/// `misses`.
pub async fn fetch<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    misses: &Misses,
    audio_fp: &str,
) -> Result<bool, Error> {
    if misses.contains(audio_fp) {
        return Ok(false);
    }
    let version: Option<i64> = lock(db)?
        .query_row(
            "SELECT version FROM analysis WHERE audio_fp = ?1 AND waveform IS NULL",
            params![audio_fp],
            |r| r.get(0),
        )
        .optional()?;
    let Some(version) = version else {
        return Ok(false);
    };
    let got = store
        .read_waveform(&WaveformRef::new(audio_fp, version))
        .await;
    let bytes = match got {
        Ok(Some(b)) if !b.is_empty() && b.len() <= MAX_BYTES => b,
        Ok(_) => {
            misses.add(audio_fp);
            return Ok(false);
        }
        Err(e) => {
            misses.add(audio_fp);
            return Err(e);
        }
    };
    #[allow(clippy::cast_precision_loss)]
    let seconds = bytes.len() as f64 / analysis::WAVEFORM_RATE;
    lock(db)?.execute(
        "UPDATE analysis SET waveform = ?2, wf_pushed = 1, duration = COALESCE(duration, ?3)
         WHERE audio_fp = ?1 AND waveform IS NULL",
        params![audio_fp, bytes, seconds],
    )?;
    Ok(true)
}

/// Fetches up to `limit` waveforms of songs analysed on other devices (they have a version
/// from their ops but no waveform here), `pause` apart so a big library does not flood the
/// destination. Returns how many were filled.
pub async fn fill<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    misses: &Misses,
    limit: usize,
    pause: Duration,
) -> Result<usize, Error> {
    let wanted = wanted(db)?;
    let mut filled = 0;
    for fp in wanted.iter().filter(|fp| !misses.contains(fp)) {
        if filled >= limit {
            break;
        }
        if fetch(db, store, misses, fp).await? {
            filled += 1;
        }
        if !pause.is_zero() {
            tokio::time::sleep(pause).await;
        }
    }
    Ok(filled)
}

/// Where the waveform transfer after a sync is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Upload,
    Download,
    Done,
}

/// Progress of the waveform transfer after a sync.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: Phase,
    pub done: usize,
    pub total: usize,
}

impl Progress {
    pub fn done() -> Self {
        Self {
            phase: Phase::Done,
            done: 0,
            total: 0,
        }
    }
}

/// What the waveform transfer after a sync did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Transfer {
    pub sent: usize,
    pub fetched: usize,
    /// Why uploading stopped early, if it did.
    pub upload_error: Option<String>,
}

/// Uploads every waveform this device made that the destination lacks, then downloads every one
/// other devices made that this device lacks, `batch` at a time with a report after each. Runs
/// in the background after a sync; stopping halfway loses nothing (the rest go next time).
pub async fn transfer<S: ChunkStore>(
    db: &Mutex<Connection>,
    store: &S,
    misses: &Misses,
    batch: usize,
    pause: Duration,
    report: impl Fn(Progress),
) -> Result<Transfer, Error> {
    let mut out = Transfer::default();
    let total = push_pending(db)?;
    let mut done = 0;
    while done < total {
        report(Progress {
            phase: Phase::Upload,
            done,
            total,
        });
        // A failed upload stops the uploads (the rest go next time) but not the downloads.
        let step = match push(db, store, batch).await {
            Ok(step) => step,
            Err(e) => {
                out.upload_error = Some(e.to_string());
                break;
            }
        };
        let handled = step.sent + step.existed + step.too_big;
        if handled == 0 {
            break;
        }
        out.sent += step.sent;
        done += handled;
    }
    let total = fill_pending(db, misses)?;
    let mut done = 0;
    while done < total {
        report(Progress {
            phase: Phase::Download,
            done,
            total,
        });
        let before = fill_pending(db, misses)?;
        out.fetched += fill(db, store, misses, batch, pause).await?;
        let after = fill_pending(db, misses)?;
        if after >= before {
            break;
        }
        done += before - after;
    }
    report(Progress::done());
    Ok(out)
}
