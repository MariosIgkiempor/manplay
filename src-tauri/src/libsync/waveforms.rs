//! Waveforms on the destination: files, not ops. They are big, never edited, and the same audio
//! gives the same waveform, so a file is written once and whoever uploads first wins.
//!
//! Path: `.manplay/waveforms/<first 2 of audio_fp>/<audio_fp>-v<analysis version>.bin`, holding
//! the raw `analysis.waveform` blob.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};

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
    /// put in a path.
    pub fn rel(&self) -> Option<(String, String)> {
        let safe = !self.audio_fp.is_empty()
            && self
                .audio_fp
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        safe.then(|| {
            (
                self.audio_fp.chars().take(2).collect(),
                format!("{}-v{}.bin", self.audio_fp, self.version),
            )
        })
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
    let wanted: Vec<String> = {
        let conn = lock(db)?;
        let mut stmt = conn.prepare(
            "SELECT a.audio_fp FROM analysis a
             WHERE a.waveform IS NULL AND a.version > 0 AND a.audio_fp <> ''
               AND EXISTS (SELECT 1 FROM tracks t WHERE t.audio_fp = a.audio_fp
                           AND t.missing_since IS NULL)
             ORDER BY a.audio_fp",
        )?;
        stmt.query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?
    };
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
