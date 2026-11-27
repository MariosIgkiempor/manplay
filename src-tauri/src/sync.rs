use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use reqwest::Client;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use unicode_normalization::UnicodeNormalization;

use crate::db::{Base, BaseUpdate, Exact, SyncTarget, Synced};
use crate::error::Error;
use crate::fsops;
use crate::libsync;
use crate::r2::{self, R2};
use crate::tags::{FieldMerge, Side};
use crate::webdav;

#[cfg(test)]
mod dup_repro;
pub mod lock;
pub mod transfer;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    target_id: i64,
    done: usize,
    total: usize,
    current: &'a str,
}

/// A library file that exists on disk.
pub struct Item {
    pub track_id: i64,
    pub local: PathBuf,
    /// Path relative to the library root, e.g. `["artist", "album", "01.wav"]`.
    pub rel: Vec<String>,
    pub size: u64,
    /// What recognises the same song under another path or tags: see [`library_identity`].
    pub identity: Option<String>,
    /// Last modification time of the local file (unix seconds).
    pub modified: i64,
}

/// What the library knows about a destination path: a track record, and whether it is only
/// missing for now (still inside the grace period) or streamed.
#[derive(Clone, Copy)]
pub struct Known {
    pub track_id: i64,
    /// Marked missing by a scan (whether or not still inside the grace period).
    pub missing: bool,
    pub in_grace: bool,
    /// Played from the destination, with no file here (`db::FileState::Streamed`): its file there
    /// is the song itself, never offered for removal or pull.
    pub streamed: bool,
}

const MAX_REPORTED_FAILURES: usize = 20;

fn is_r2(target: &SyncTarget) -> bool {
    target.tailnet.starts_with(r2::TARGET_PREFIX)
}

/// Path segments of the destination folder as the backend addresses them.
fn base_of(target: &SyncTarget) -> Vec<String> {
    if is_r2(target) {
        return target.path.clone();
    }
    [target.tailnet.clone(), target.machine.clone()]
        .into_iter()
        .chain(target.path.iter().cloned())
        .collect()
}

pub fn target_name(target: &SyncTarget) -> String {
    std::iter::once(target.machine.as_str())
        .chain(target.path.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" / ")
}

enum Backend<'a> {
    Dav(&'a Client),
    R2(&'a Client, R2),
}

impl<'a> Backend<'a> {
    fn for_target(client: &'a Client, target: &SyncTarget) -> Result<Self, Error> {
        if is_r2(target) {
            let account = target.tailnet.trim_start_matches(r2::TARGET_PREFIX);
            Ok(Self::R2(
                client,
                R2::load(account, &target.machine, target.id)?,
            ))
        } else {
            Ok(Self::Dav(client))
        }
    }

    async fn exists(&self, base: &[String]) -> Result<bool, Error> {
        match self {
            Self::Dav(c) => webdav::exists(c, base).await,
            Self::R2(c, r) => r.check(c).await.map(|()| true),
        }
    }

    async fn remote_size(&self, dest: &[String]) -> Result<Option<u64>, Error> {
        match self {
            Self::Dav(c) => webdav::remote_size(c, dest).await,
            Self::R2(c, r) => r.remote_size(c, dest).await,
        }
    }

    async fn mkdir(&self, dir: &[String]) -> Result<(), Error> {
        match self {
            Self::Dav(c) => webdav::mkcol(c, dir).await,
            Self::R2(..) => Ok(()),
        }
    }

    async fn put(&self, dest: &[String], file: &std::path::Path) -> Result<(), Error> {
        match self {
            Self::Dav(c) => webdav::put(c, dest, file).await,
            Self::R2(c, r) => r.put(c, dest, file).await,
        }
    }

    /// Uploads `file` so that `dest` is never seen half written: on `WebDAV` it goes to a
    /// [`PART_SUFFIX`] file next to `dest` first and is renamed once complete (R2 only ever shows
    /// whole objects). Unless `overwrite`, fails when something is already at `dest`.
    async fn put_whole(
        &self,
        dest: &[String],
        file: &std::path::Path,
        overwrite: bool,
    ) -> Result<(), Error> {
        match self {
            Self::Dav(c) => {
                let mut part = dest.to_vec();
                if let Some(name) = part.last_mut() {
                    name.push_str(PART_SUFFIX);
                }
                webdav::put(c, &part, file).await?;
                let moved = webdav::move_file(c, &part, dest, overwrite).await;
                if moved.is_err() {
                    let _ = webdav::delete(c, &part).await;
                }
                moved
            }
            Self::R2(c, r) => r.put(c, dest, file).await,
        }
    }

    /// Uploads `file` to `dest` only if nothing is there yet, in one step on the server, so two
    /// devices racing for `dest` cannot both win. Returns `false` when something already is.
    /// `nonce` keeps this device's temporary `WebDAV` file apart from another's.
    async fn put_new(
        &self,
        dest: &[String],
        file: &std::path::Path,
        nonce: &str,
    ) -> Result<bool, Error> {
        match self {
            Self::Dav(c) => {
                let mut part = dest.to_vec();
                if let Some(name) = part.last_mut() {
                    name.push('.');
                    name.push_str(nonce);
                    name.push_str(PART_SUFFIX);
                }
                webdav::put(c, &part, file).await?;
                let moved = webdav::move_new(c, &part, dest).await;
                if !matches!(moved, Ok(true)) {
                    let _ = webdav::delete(c, &part).await;
                }
                moved
            }
            Self::R2(c, r) => r.put_new(c, dest, file).await,
        }
    }

    /// The folders and files directly inside `dir`, folders first, then by name.
    async fn list_dir(&self, dir: &[String]) -> Result<Vec<webdav::Entry>, Error> {
        match self {
            Self::Dav(c) => webdav::list(c, dir).await,
            Self::R2(c, r) => {
                let mut entries = r.list_dir(c, dir).await?;
                entries.sort_by(|a, b| {
                    b.is_dir
                        .cmp(&a.is_dir)
                        .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                });
                Ok(entries)
            }
        }
    }

    /// Every file below `base`, relative to it.
    async fn list(&self, base: &[String]) -> Result<Vec<Remote>, Error> {
        match self {
            Self::Dav(c) => Ok(webdav::list_files(c, base)
                .await?
                .into_iter()
                .map(|(rel, size, modified)| Remote {
                    rel,
                    size,
                    version: modified.map(|m| m.to_string()),
                })
                .collect()),
            Self::R2(c, r) => Ok(r
                .list(c, base)
                .await?
                .into_iter()
                .filter_map(|(key, size, etag)| {
                    let rel: Vec<String> =
                        key.split('/').skip(base.len()).map(str::to_owned).collect();
                    // Folder placeholder keys end in "/" and leave an empty last segment.
                    rel.iter().all(|s| !s.is_empty()).then_some(Remote {
                        rel,
                        size,
                        version: etag,
                    })
                })
                .collect()),
        }
    }

    async fn get(&self, src: &[String], dest: &Path) -> Result<(), Error> {
        match self {
            Self::Dav(c) => webdav::get(c, src, dest).await,
            Self::R2(c, r) => r.get(c, src, dest).await,
        }
    }

    async fn get_range(&self, src: &[String], start: u64, len: u64) -> Result<Vec<u8>, Error> {
        match self {
            Self::Dav(c) => webdav::get_range(c, src, start, len).await,
            Self::R2(c, r) => r.get_range(c, src, start, len).await,
        }
    }

    /// Renames a file on the destination. Never overwrites an existing file.
    async fn rename(&self, from: &[String], to: &[String]) -> Result<(), Error> {
        match self {
            Self::Dav(c) => webdav::move_file(c, from, to, false).await,
            Self::R2(c, r) => {
                r.copy(c, from, to).await?;
                r.delete(c, from).await
            }
        }
    }

    async fn delete(&self, dest: &[String]) -> Result<(), Error> {
        match self {
            Self::Dav(c) => webdav::delete(c, dest).await,
            Self::R2(c, r) => r.delete(c, dest).await,
        }
    }
}

// ---- library data ------------------------------------------------------------

/// The op log folder (`.manplay/log`) of a destination, as a place for chunks.
struct LogStore<'a, 'b> {
    backend: &'b Backend<'a>,
    base: Vec<String>,
}

impl LogStore<'_, '_> {
    fn dir(&self, dev: Option<&str>) -> Vec<String> {
        let mut dir = self.base.clone();
        dir.extend([
            libsync::remote::DIR.to_owned(),
            libsync::remote::LOG_DIR.to_owned(),
        ]);
        dir.extend(dev.map(str::to_owned));
        dir
    }
}

/// A safe single path segment from a destination listing.
fn plain_segment(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('.') && !s.contains(['/', '\\'])
}

impl libsync::ChunkStore for LogStore<'_, '_> {
    async fn list_chunks(&self) -> Result<Vec<libsync::remote::ChunkInfo>, Error> {
        let files = self.backend.list(&self.dir(None)).await?;
        Ok(files
            .into_iter()
            .filter_map(|f| match f.rel.as_slice() {
                [dev, name] if plain_segment(dev) => Some(libsync::remote::ChunkInfo {
                    chunk: libsync::ChunkRef {
                        dev: dev.clone(),
                        seq: libsync::remote::parse_chunk_name(name)?,
                    },
                    size: f.size,
                }),
                _ => None,
            })
            .collect())
    }

    async fn delete_chunk(&self, chunk: &libsync::ChunkRef) -> Result<(), Error> {
        let mut dest = self.dir(Some(&chunk.dev));
        dest.push(libsync::remote::chunk_name(chunk.seq));
        self.backend.delete(&dest).await
    }

    async fn list_waveforms(&self) -> Result<Vec<libsync::waveforms::WaveformRef>, Error> {
        let mut dir = self.base.clone();
        dir.extend([
            libsync::remote::DIR.to_owned(),
            libsync::waveforms::DIR.to_owned(),
        ]);
        let files = self.backend.list(&dir).await?;
        Ok(files
            .into_iter()
            .filter_map(|f| match f.rel.as_slice() {
                [sub, name] => {
                    let w = libsync::compact::parse_waveform_name(name)?;
                    (w.rel()? == (sub.clone(), name.clone())).then_some(w)
                }
                _ => None,
            })
            .collect())
    }

    async fn delete_waveform(&self, w: &libsync::waveforms::WaveformRef) -> Result<(), Error> {
        let (_, path) = self.waveform_path(w)?;
        self.backend.delete(&path).await
    }

    async fn read_chunk(&self, chunk: &libsync::ChunkRef) -> Result<Vec<u8>, Error> {
        let mut src = self.dir(Some(&chunk.dev));
        src.push(libsync::remote::chunk_name(chunk.seq));
        let tmp = std::env::temp_dir().join(format!(
            "manplay-chunk-{}-{}-{}",
            std::process::id(),
            chunk.dev,
            chunk.seq
        ));
        let got = self.backend.get(&src, &tmp).await;
        let bytes = match got {
            Ok(()) => tokio::fs::read(&tmp).await.map_err(Error::from),
            Err(e) => Err(e),
        };
        let _ = tokio::fs::remove_file(&tmp).await;
        bytes
    }

    async fn write_chunk(&self, chunk: &libsync::ChunkRef, bytes: Vec<u8>) -> Result<(), Error> {
        let dir = self.dir(Some(&chunk.dev));
        for depth in self.base.len() + 1..=dir.len() {
            self.backend.mkdir(&dir[..depth]).await?;
        }
        let name = libsync::remote::chunk_name(chunk.seq);
        let mut dest = dir.clone();
        dest.push(name.clone());
        if self.backend.remote_size(&dest).await?.is_some() {
            return Err(Error::Msg(format!(
                "chunk {name} of this device already exists on the destination"
            )));
        }
        let tmp = std::env::temp_dir().join(format!(
            "manplay-chunk-{}-{}-{}.up",
            std::process::id(),
            chunk.dev,
            chunk.seq
        ));
        tokio::fs::write(&tmp, &bytes).await?;
        // A reader never sees half a chunk.
        let sent = self.backend.put_whole(&dest, &tmp, false).await;
        let _ = tokio::fs::remove_file(&tmp).await;
        sent
    }

    async fn read_meta(&self, path: &str) -> Result<Option<Vec<u8>>, Error> {
        let full = self.meta_path(path)?;
        if self.backend.remote_size(&full).await?.is_none() {
            return Ok(None);
        }
        let tmp = Self::meta_tmp("get");
        let got = self.backend.get(&full, &tmp).await;
        let bytes = match got {
            Ok(()) => tokio::fs::read(&tmp).await.map(Some).map_err(Error::from),
            Err(e) => Err(e),
        };
        let _ = tokio::fs::remove_file(&tmp).await;
        bytes
    }

    async fn write_meta(&self, path: &str, bytes: Vec<u8>) -> Result<(), Error> {
        let full = self.meta_path(path)?;
        for depth in self.base.len() + 1..full.len() {
            self.backend.mkdir(&full[..depth]).await?;
        }
        let tmp = Self::meta_tmp("put");
        tokio::fs::write(&tmp, &bytes).await?;
        // A snapshot is big: written under a temporary name and renamed, so a reader never
        // takes half of one for the newest.
        let sent = if path.starts_with(libsync::snapshot::DIR) {
            self.backend.put_whole(&full, &tmp, false).await
        } else {
            self.backend.put(&full, &tmp).await
        };
        let _ = tokio::fs::remove_file(&tmp).await;
        sent
    }

    async fn delete_meta(&self, path: &str) -> Result<(), Error> {
        let full = self.meta_path(path)?;
        self.backend.delete(&full).await
    }

    async fn list_meta(&self, dir: &str) -> Result<Vec<String>, Error> {
        let full = self.meta_path(dir)?;
        let files = self.backend.list(&full).await?;
        Ok(files
            .into_iter()
            .filter_map(|f| match f.rel.as_slice() {
                [name] if plain_segment(name) => Some(name.clone()),
                _ => None,
            })
            .collect())
    }

    async fn waveform_exists(&self, w: &libsync::waveforms::WaveformRef) -> Result<bool, Error> {
        let (_, path) = self.waveform_path(w)?;
        Ok(self.backend.remote_size(&path).await?.is_some())
    }

    async fn read_waveform(
        &self,
        w: &libsync::waveforms::WaveformRef,
    ) -> Result<Option<Vec<u8>>, Error> {
        let (_, path) = self.waveform_path(w)?;
        match self.backend.remote_size(&path).await? {
            None => return Ok(None),
            Some(size) if size > libsync::waveforms::MAX_BYTES as u64 => return Ok(None),
            Some(_) => {}
        }
        let tmp = std::env::temp_dir().join(format!(
            "manplay-wf-{}-{}-{}",
            std::process::id(),
            w.audio_fp,
            w.version
        ));
        let got = self.backend.get(&path, &tmp).await;
        let bytes = match got {
            Ok(()) => tokio::fs::read(&tmp).await.map(Some).map_err(Error::from),
            Err(e) => Err(e),
        };
        let _ = tokio::fs::remove_file(&tmp).await;
        bytes
    }

    async fn write_waveform(
        &self,
        w: &libsync::waveforms::WaveformRef,
        bytes: Vec<u8>,
    ) -> Result<(), Error> {
        let (dir, dest) = self.waveform_path(w)?;
        for depth in self.base.len() + 1..=dir.len() {
            self.backend.mkdir(&dir[..depth]).await?;
        }
        // First writer wins: a file that appeared meanwhile is the same waveform.
        if self.backend.remote_size(&dest).await?.is_some() {
            return Ok(());
        }
        let tmp = std::env::temp_dir().join(format!(
            "manplay-wf-{}-{}-{}.up",
            std::process::id(),
            w.audio_fp,
            w.version
        ));
        tokio::fs::write(&tmp, &bytes).await?;
        let sent = self.backend.put_whole(&dest, &tmp, false).await;
        let _ = tokio::fs::remove_file(&tmp).await;
        match sent {
            // Lost the race to another device: its file is the same.
            Err(_) if self.backend.remote_size(&dest).await?.is_some() => Ok(()),
            other => other,
        }
    }
}

impl LogStore<'_, '_> {
    /// Full path of a small file under `.manplay/`, from its `/`-separated path there.
    fn meta_path(&self, path: &str) -> Result<Vec<String>, Error> {
        let mut full = self.base.clone();
        full.push(libsync::remote::DIR.to_owned());
        for seg in path.split('/') {
            if seg.is_empty() || seg == ".." || seg.contains('\\') {
                return Err(Error::Msg(format!("unsafe path under .manplay: {path}")));
            }
            full.push(seg.to_owned());
        }
        Ok(full)
    }

    fn meta_tmp(what: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "manplay-meta-{}-{}-{what}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    /// The folder and the full path of a waveform file.
    fn waveform_path(
        &self,
        w: &libsync::waveforms::WaveformRef,
    ) -> Result<(Vec<String>, Vec<String>), Error> {
        let (sub, name) = w
            .rel()
            .ok_or_else(|| Error::Msg("this song's audio print cannot name a file".into()))?;
        let mut dir = self.base.clone();
        dir.extend([
            libsync::remote::DIR.to_owned(),
            libsync::waveforms::DIR.to_owned(),
            sub,
        ]);
        let mut path = dir.clone();
        path.push(name);
        Ok((dir, path))
    }
}

/// What library data did on one destination.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryOutcome {
    pub target_id: i64,
    pub name: String,
    pub sent: usize,
    pub received: usize,
    pub unreadable: usize,
    /// Ops kept back because the device that wrote them has a clock far ahead.
    pub held: usize,
    /// Another device says this device's clock is wrong.
    pub clock_wrong: bool,
    /// This install found a second copy of itself and took a new device ID.
    pub new_device_id: bool,
    /// Deletions another device made that wait for the user's word (`libsync::brake`).
    pub delete_hold: Option<libsync::brake::Hold>,
    pub error: Option<String>,
}

impl LibraryOutcome {
    fn empty(target: &SyncTarget) -> Self {
        Self {
            target_id: target.id,
            name: target_name(target),
            sent: 0,
            received: 0,
            unreadable: 0,
            held: 0,
            clock_wrong: false,
            new_device_id: false,
            delete_hold: None,
            error: None,
        }
    }

    /// Nothing was exchanged with the destination, for `reason`.
    pub fn failed(target: &SyncTarget, reason: String) -> Self {
        Self {
            error: Some(reason),
            ..Self::empty(target)
        }
    }
}

/// Waveforms moved between progress reports, after a sync.
pub(crate) const WAVEFORM_BATCH: usize = 20;
/// How many cover pictures go each way after one sync.
pub(crate) const COVER_BATCH: usize = 200;
/// Pause between waveform downloads, so the destination is not hammered.
pub(crate) const FILL_PAUSE: std::time::Duration = std::time::Duration::from_millis(100);

/// Sends this device's new library edits to the destination and applies everyone else's. Runs
/// before the files so tags and playlists are in place when songs arrive.
pub async fn run_library_data(
    client: &Client,
    target: &SyncTarget,
    db: &std::sync::Mutex<rusqlite::Connection>,
) -> LibraryOutcome {
    let mut out = LibraryOutcome::empty(target);
    let base = base_of(target);
    let backend = match Backend::for_target(client, target) {
        Ok(b) => b,
        Err(e) => {
            out.error = Some(e.to_string());
            return out;
        }
    };
    match backend.exists(&base).await {
        Ok(true) => {}
        Ok(false) => {
            out.error = Some("destination folder not found (is the machine online?)".to_owned());
            return out;
        }
        Err(e) => {
            out.error = Some(format!("destination unreachable: {e}"));
            return out;
        }
    }
    let store = LogStore {
        backend: &backend,
        base,
    };
    let summary = libsync::membership::run_joined(db, &store, &target_name(target)).await;
    out.sent = summary.sent;
    out.received = summary.received;
    out.unreadable = summary.unreadable;
    out.held = summary.held;
    out.clock_wrong = summary.clock_wrong;
    out.new_device_id = summary.new_device_id;
    out.delete_hold = summary.delete_hold;
    out.error = summary.error;
    out
}

/// Checks that the destination folder is there and the machine answers, for the join and leave
/// flows that talk to it directly.
async fn reachable(backend: &Backend<'_>, base: &[String]) -> Result<(), Error> {
    match backend.exists(base).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(Error::Msg(
            "destination folder not found (is the machine online?)".to_owned(),
        )),
        Err(e) => Err(Error::Msg(format!("destination unreachable: {e}"))),
    }
}

/// What a destination holds: a shared library (its name, members, last change) or none. Reads
/// `.manplay/library.json` and `devices/`; writes nothing.
pub async fn inspect_library(
    client: &Client,
    target: &SyncTarget,
    db: &std::sync::Mutex<rusqlite::Connection>,
) -> Result<Option<libsync::membership::Found>, Error> {
    let backend = Backend::for_target(client, target)?;
    let base = base_of(target);
    reachable(&backend, &base).await?;
    libsync::membership::inspect(
        db,
        &LogStore {
            backend: &backend,
            base,
        },
    )
    .await
}

/// Joins the library on a destination (or starts one there) and does the first sync.
pub async fn join_library(
    client: &Client,
    target: &SyncTarget,
    db: &std::sync::Mutex<rusqlite::Connection>,
    choice: libsync::membership::JoinChoice,
) -> Result<LibraryOutcome, Error> {
    let backend = Backend::for_target(client, target)?;
    let base = base_of(target);
    reachable(&backend, &base).await?;
    let store = LogStore {
        backend: &backend,
        base,
    };
    let name = target_name(target);
    let home = libsync::membership::Home::Target(target.id);
    let summary = libsync::membership::join(db, home, &store, choice, &name).await?;
    let out = LibraryOutcome {
        target_id: target.id,
        name,
        sent: summary.sent,
        received: summary.received,
        unreadable: summary.unreadable,
        held: summary.held,
        clock_wrong: summary.clock_wrong,
        new_device_id: summary.new_device_id,
        delete_hold: summary.delete_hold,
        error: summary.error,
    };
    Ok(out)
}

/// Leaves the library on a destination. With `sync` it first sends and receives one last time
/// and stops if that fails; without it (the destination is out of reach) it leaves at once.
pub async fn leave_library(
    client: &Client,
    target: &SyncTarget,
    db: &std::sync::Mutex<rusqlite::Connection>,
    choice: libsync::membership::LeaveChoice,
    sync: bool,
) -> Result<(), Error> {
    let backend = Backend::for_target(client, target)?;
    let base = base_of(target);
    let store = LogStore {
        backend: &backend,
        base: base.clone(),
    };
    if sync {
        reachable(&backend, &base).await?;
        return libsync::membership::leave(db, &store, choice, true).await;
    }
    // Out of reach: leaving does not wait for it, and the member file is removed if it answers.
    libsync::membership::leave(db, &store, choice, false).await
}

/// Uploads every waveform this device made that the destination lacks, then downloads every one
/// other devices made that this device lacks (see [`libsync::waveforms::transfer`]).
pub async fn transfer_waveforms(
    client: &Client,
    target: &SyncTarget,
    db: &std::sync::Mutex<rusqlite::Connection>,
    misses: &libsync::waveforms::Misses,
    report: impl Fn(libsync::waveforms::Progress),
) -> Result<libsync::waveforms::Transfer, Error> {
    let backend = Backend::for_target(client, target)?;
    let store = LogStore {
        backend: &backend,
        base: base_of(target),
    };
    libsync::waveforms::transfer(db, &store, misses, WAVEFORM_BATCH, FILL_PAUSE, report).await
}

/// Sends the cover pictures other devices need and fetches the ones this device waits for
/// (see [`libsync::covers::transfer`]).
pub async fn transfer_covers(
    client: &Client,
    target: &SyncTarget,
    db: &std::sync::Mutex<rusqlite::Connection>,
    root: &Path,
    cache: &Path,
) -> Result<libsync::covers::Transfer, Error> {
    let backend = Backend::for_target(client, target)?;
    let store = LogStore {
        backend: &backend,
        base: base_of(target),
    };
    libsync::covers::transfer(db, &store, root, cache, COVER_BATCH).await
}

/// Fetches one song's waveform from the destination when it is shown or played and this device
/// has none. True when it was filled.
pub async fn fetch_waveform(
    client: &Client,
    target: &SyncTarget,
    db: &std::sync::Mutex<rusqlite::Connection>,
    misses: &libsync::waveforms::Misses,
    audio_fp: &str,
) -> Result<bool, Error> {
    let backend = Backend::for_target(client, target)?;
    let store = LogStore {
        backend: &backend,
        base: base_of(target),
    };
    libsync::waveforms::fetch(db, &store, misses, audio_fp).await
}

// ---- review plan -------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// Copy a library file that the destination lacks.
    Upload,
    /// Overwrite a destination file whose size differs from the library file.
    Replace,
    /// Rename a destination file whose audio matches a library file stored under another path.
    Move,
    /// Remove a destination file that matches nothing in the library.
    Delete,
    /// Only the destination copy was edited since the last sync: it replaces the library file
    /// (which goes to the Trash first).
    Update,
    /// Both copies had their tags edited since the last sync: fields only one side changed are
    /// combined, fields both changed need a choice. The merged file lands on both sides.
    Merge,
    /// Both copies changed in a way that cannot be combined (audio, artwork): keep one.
    Conflict,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    /// Unique within a plan.
    pub id: u32,
    pub target_id: i64,
    pub kind: Kind,
    /// Destination path affected (for a move, the new path).
    pub rel: Vec<String>,
    /// Move only: the current destination path.
    pub from: Option<Vec<String>>,
    /// Bytes uploaded, or size of the destination file that is moved or removed.
    pub size: u64,
    /// Replace only: size of the destination file being overwritten.
    pub remote_size: Option<u64>,
    /// Why this is proposed, e.g. which library file has the same audio.
    pub note: Option<String>,
    /// Starts unticked in the review: deletions, and uploads of audio the destination already
    /// has under another path (e.g. pushed by someone else).
    pub optional: bool,
    /// Replace only: tags that differ between the destination copy and the library file, from
    /// the destination's value to the library's. `None` when the destination's tags couldn't be read.
    pub tags: Option<Vec<crate::tags::Change>>,
    /// Update, merge and conflict: size of the library file as reviewed.
    pub local_size: Option<u64>,
    /// Merge: every field the two copies disagree on.
    pub merge: Option<Vec<FieldMerge>>,
    /// The library song this file is, so the review can show its album and artwork. A delete
    /// carries the song it was last synced from, which may have left the library.
    pub track_id: Option<i64>,
    /// Delete only: the library song with the same audio, when the file is a duplicate of one.
    pub duplicate_of: Option<i64>,
    #[serde(skip)]
    pub local: Option<PathBuf>,
    /// Update, merge and conflict: [`local_signature`] of the library file as reviewed. The action
    /// is refused if the file changed since.
    #[serde(skip)]
    pub local_seen: Option<String>,
    /// Replace, move and delete: [`remote_signature`] of the destination file as reviewed. The
    /// action is refused if the file no longer matches it (or it could not be read).
    #[serde(skip)]
    pub seen: Option<String>,
}

impl Action {
    pub(crate) fn new(target_id: i64, kind: Kind, rel: &[String]) -> Self {
        Self {
            id: 0,
            target_id,
            kind,
            rel: rel.to_vec(),
            from: None,
            size: 0,
            remote_size: None,
            note: None,
            optional: false,
            tags: None,
            local_size: None,
            merge: None,
            track_id: None,
            duplicate_of: None,
            local: None,
            local_seen: None,
            seen: None,
        }
    }
}

/// How the user settled an action that needed a choice.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    /// Conflict: which copy stays.
    pub keep: Option<Side>,
    /// Merge: the side chosen for each field both copies changed.
    #[serde(default)]
    pub fields: HashMap<String, Side>,
}

/// A folder on the destination and how many files are directly in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFolder {
    pub rel: Vec<String>,
    pub files: usize,
}

/// The folders of a destination listing, in path order, with their file counts.
fn folders_of(remote: &[Remote]) -> Vec<RemoteFolder> {
    let mut counts: std::collections::BTreeMap<&[String], usize> =
        std::collections::BTreeMap::new();
    for file in remote {
        let dir = &file.rel[..file.rel.len().saturating_sub(1)];
        *counts.entry(dir).or_default() += 1;
    }
    counts
        .into_iter()
        .map(|(rel, files)| RemoteFolder {
            rel: rel.to_vec(),
            files,
        })
        .collect()
}

/// A destination file that is left alone on purpose.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Held {
    pub rel: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetPlan {
    pub target_id: i64,
    pub name: String,
    /// Set when the destination could not be read; nothing is planned for it.
    pub error: Option<String>,
    pub actions: Vec<Action>,
    pub held: Vec<Held>,
    /// Files that already match the library.
    pub in_sync: usize,
    /// Destination files examined (audio could not be compared for `unchecked` of them).
    pub remote_total: usize,
    pub unchecked: usize,
    /// Every folder on the destination that holds files, with how many, so the review can show
    /// folders the sync leaves alone.
    pub folders: Vec<RemoteFolder>,
    /// `(track id, size)` of library files already on the destination.
    #[serde(skip)]
    pub present: Vec<(i64, i64)>,
    /// Identical files that have no base yet (or an outdated one): see [`seed_bases`].
    #[serde(skip)]
    pub seeds: Vec<Seed>,
    /// Fingerprints read from the destination this time: `(path, size, fingerprint)`, to cache.
    #[serde(skip)]
    pub fresh_prints: Vec<(String, u64, String)>,
    /// Every destination signature this plan used, read now or cached, to cache for the next.
    #[serde(skip)]
    pub signatures: Vec<RemoteSignature>,
    /// Destination files whose fingerprint matches a library file at another path: the library
    /// already has them, so a pull must not offer them again.
    #[serde(skip)]
    pub in_library: HashSet<Vec<String>>,
}

impl TargetPlan {
    /// A plan with nothing in it yet.
    fn empty(target: &SyncTarget) -> Self {
        Self {
            target_id: target.id,
            name: target_name(target),
            error: None,
            actions: Vec::new(),
            held: Vec::new(),
            in_sync: 0,
            remote_total: 0,
            unchecked: 0,
            folders: Vec::new(),
            present: Vec::new(),
            seeds: Vec::new(),
            fresh_prints: Vec::new(),
            signatures: Vec::new(),
            in_library: HashSet::new(),
        }
    }

    /// A destination that could not be compared, with the reason.
    pub fn failed(target: &SyncTarget, error: String) -> Self {
        Self {
            error: Some(error),
            ..Self::empty(target)
        }
    }
}

struct Diff<'a> {
    in_sync: Vec<&'a Item>,
    uploads: Vec<&'a Item>,
    replaces: Vec<(&'a Item, u64)>,
    extras: Vec<&'a Remote>,
    /// The destination file each library file was matched to, by track id.
    matched: HashMap<i64, &'a Remote>,
}

/// A path as a case-insensitive, normalisation-insensitive destination sees it: Taildrive on a
/// Mac or Windows machine treats `Pão` typed composed and decomposed, or `Western` and
/// `western`, as one folder.
pub(crate) fn folded(rel: &[String]) -> Vec<String> {
    rel.iter()
        .map(|segment| segment.nfc().collect::<String>().to_lowercase())
        .collect()
}

/// Splits library and destination into matching files, files to push, and files the library lacks.
/// Paths match exactly first; one that only differs in case or Unicode form still counts as the
/// same file, so it is not planned as a move onto a path that already exists.
fn diff<'a>(items: &'a [Item], remote: &'a [Remote]) -> Diff<'a> {
    let exact: HashMap<&[String], usize> = remote
        .iter()
        .enumerate()
        .map(|(at, r)| (r.rel.as_slice(), at))
        .collect();
    let mut claimed: HashSet<usize> = HashSet::new();
    let mut found: HashMap<i64, usize> = HashMap::new();
    for item in items {
        if let Some(&at) = exact.get(item.rel.as_slice()) {
            claimed.insert(at);
            found.insert(item.track_id, at);
        }
    }
    let mut by_fold: HashMap<Vec<String>, Vec<usize>> = HashMap::new();
    for (at, r) in remote
        .iter()
        .enumerate()
        .filter(|(at, _)| !claimed.contains(at))
    {
        by_fold.entry(folded(&r.rel)).or_default().push(at);
    }
    let unmatched: Vec<&Item> = items
        .iter()
        .filter(|i| !found.contains_key(&i.track_id))
        .collect();
    for item in unmatched {
        if let Some(at) = by_fold.get_mut(&folded(&item.rel)).and_then(Vec::pop) {
            claimed.insert(at);
            found.insert(item.track_id, at);
        }
    }
    let mut out = Diff {
        in_sync: Vec::new(),
        uploads: Vec::new(),
        replaces: Vec::new(),
        extras: Vec::new(),
        matched: HashMap::new(),
    };
    for item in items {
        match found.get(&item.track_id).map(|&at| &remote[at]) {
            Some(r) if r.size == item.size => {
                out.matched.insert(item.track_id, r);
                out.in_sync.push(item);
            }
            Some(r) => {
                out.matched.insert(item.track_id, r);
                out.replaces.push((item, r.size));
            }
            None => out.uploads.push(item),
        }
    }
    out.extras = remote
        .iter()
        .enumerate()
        .filter(|(at, _)| !claimed.contains(at))
        .map(|(_, r)| r)
        .collect();
    out
}

/// Outcome of matching destination extras against the library by audio.
/// A destination file no library song accounts for: the plan offers to remove it.
struct Extra<'a> {
    file: &'a Remote,
    /// Why it is offered, e.g. which library file has the same audio.
    note: Option<String>,
    /// The library song with the same audio, when it is a duplicate of one.
    duplicate_of: Option<i64>,
}

struct Matched<'a> {
    moves: Vec<(&'a Remote, &'a Item)>,
    /// Extras to remove.
    deletes: Vec<Extra<'a>>,
    /// Uploads not replaced by a move.
    uploads: Vec<&'a Item>,
}

/// Pairs each extra whose audio equals a pending upload (one-to-one) and renames it to the
/// library's path, whoever put it there. `extras` holds each file's fingerprint, if it could be
/// read.
fn pair<'a>(
    items: &'a [Item],
    uploads: &[&'a Item],
    extras: &[(&'a Remote, Option<String>)],
) -> Matched<'a> {
    let mut wanting: HashMap<&str, Vec<&'a Item>> = HashMap::new();
    for item in uploads {
        if let Some(fp) = &item.identity {
            wanting.entry(fp.as_str()).or_default().push(item);
        }
    }
    let known: HashMap<&str, &Item> = items
        .iter()
        .filter_map(|i| Some((i.identity.as_deref()?, i)))
        .collect();
    let mut moved: HashSet<i64> = HashSet::new();
    let mut out = Matched {
        moves: Vec::new(),
        deletes: Vec::new(),
        uploads: Vec::new(),
    };
    for (file, print) in extras {
        let Some(fp) = print else {
            let note = is_audio_name(&file.rel).then(|| "Not compared".to_owned());
            out.deletes.push(Extra {
                file,
                note,
                duplicate_of: None,
            });
            continue;
        };
        if let Some(item) = wanting.get_mut(fp.as_str()).and_then(Vec::pop) {
            moved.insert(item.track_id);
            out.moves.push((file, item));
        } else {
            let twin = known.get(fp.as_str());
            out.deletes.push(Extra {
                file,
                note: twin
                    .map(|i| format!("Duplicate of {}", i.rel.last().map_or("", String::as_str))),
                duplicate_of: twin.map(|i| i.track_id),
            });
        }
    }
    out.uploads = uploads
        .iter()
        .filter(|i| !moved.contains(&i.track_id))
        .copied()
        .collect();
    out
}

/// The `extras` that are not at the path of a song this device streams: the file there is the
/// song itself, so it is neither removed from the destination nor offered for pull.
fn not_streamed_paths<'a>(
    extras: &[&'a Remote],
    known: &HashMap<Vec<String>, Known>,
) -> Vec<&'a Remote> {
    extras
        .iter()
        .copied()
        .filter(|r| !known.get(&r.rel).is_some_and(|k| k.streamed))
        .collect()
}

/// The `extras` whose fingerprint is not that of a song this device streams: a streamed song's
/// file at another path than this device expects (another device just moved it) is still it.
fn not_streamed_prints<'a>(
    extras: Vec<(&'a Remote, Option<String>)>,
    streamed: &HashSet<String>,
) -> Vec<(&'a Remote, Option<String>)> {
    extras
        .into_iter()
        .filter(|(_, print)| !print.as_ref().is_some_and(|p| streamed.contains(p)))
        .collect()
}

/// Paths of the `extras` whose fingerprint equals some library file's.
fn in_library(items: &[Item], extras: &[(&Remote, Option<String>)]) -> HashSet<Vec<String>> {
    let prints: HashSet<&str> = items.iter().filter_map(|i| i.identity.as_deref()).collect();
    extras
        .iter()
        .filter(|(_, print)| print.as_deref().is_some_and(|fp| prints.contains(fp)))
        .map(|(file, _)| file.rel.clone())
        .collect()
}

/// Each file with its fingerprint from `prints`, `None` when it has none.
fn with_prints<'a>(
    files: &[&'a Remote],
    prints: &HashMap<&[String], Option<String>>,
) -> Vec<(&'a Remote, Option<String>)> {
    files
        .iter()
        .map(|r| (*r, prints.get(r.rel.as_slice()).cloned().flatten()))
        .collect()
}

fn is_audio_name(rel: &[String]) -> bool {
    rel.last()
        .is_some_and(|n| !n.starts_with('.') && crate::scan::is_audio(Path::new(n)))
}

/// What [`plan_target`] compares the destination with.
#[derive(Clone, Copy)]
pub struct Inputs<'a> {
    pub items: &'a [Item],
    pub known: &'a HashMap<Vec<String>, Known>,
    /// When each track was last confirmed on the destination.
    pub synced_at: &'a HashMap<i64, i64>,
    /// Fingerprints of destination files read on earlier runs, by `(path, size)`.
    pub cached: &'a HashMap<(String, u64), String>,
    /// How each file looked at its last sync.
    pub bases: &'a HashMap<i64, Base>,
    /// Destination signatures read on earlier runs, by path.
    pub signatures: &'a SignatureCache,
    /// The identities ([`library_identity`]) of the songs this device streams, so their files are
    /// recognised wherever another device put them.
    pub streamed: &'a HashSet<String>,
}

/// A [`remote_signature`] read earlier, valid while the file keeps its size and change marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteSignature {
    pub path: String,
    pub size: u64,
    /// [`Remote::version`] when it was read.
    pub version: String,
    pub signature: String,
}

/// Destination signatures read earlier, by path.
pub type SignatureCache = HashMap<String, RemoteSignature>;

/// A library file and the destination copy at the same path.
#[derive(Clone, Copy)]
struct Pair<'a> {
    item: &'a Item,
    remote_size: u64,
    /// [`Remote::version`] of the destination copy.
    remote_version: Option<&'a str>,
}

/// A pair that differs, sorted by who edited it since the last sync.
struct Differing<'a> {
    pair: Pair<'a>,
    /// [`remote_signature`] and [`local_signature`] as read during this review; `None` when the
    /// pair was not compared (different sizes, no base to say who edited).
    sigs: Option<(String, String)>,
}

/// Compares the destination with the library and lists what a sync would do. Reads only.
#[allow(clippy::too_many_lines)]
/// `listing` is the destination's [`list_remote`], read once by the caller so the pull side can use
/// it too.
pub async fn plan_target(
    app: &AppHandle,
    client: &Client,
    target: &SyncTarget,
    inputs: &Inputs<'_>,
    listing: Result<&[Remote], &Error>,
    next_id: &mut u32,
) -> TargetPlan {
    let Inputs {
        items,
        known,
        synced_at,
        cached,
        bases,
        signatures,
        streamed,
    } = *inputs;
    let mut plan = TargetPlan::empty(target);
    let remote = match listing {
        Ok(r) => r,
        Err(e) => {
            plan.error = Some(format!("destination unreachable: {e}"));
            return plan;
        }
    };
    plan.remote_total = remote.len();
    plan.folders = folders_of(remote);
    let d = diff(items, remote);
    let version_of = |item: &Item| {
        d.matched
            .get(&item.track_id)
            .and_then(|r| r.version.as_deref())
    };
    // Every same-size pair is compared: same path and size can still differ in tags or audio.
    // Other pairs are only read when a base says who edited them.
    let pairs: Vec<Pair> = d
        .in_sync
        .iter()
        .map(|i| Pair {
            item: i,
            remote_size: i.size,
            remote_version: version_of(i),
        })
        .chain(
            d.replaces
                .iter()
                .filter(|(i, _)| bases.contains_key(&i.track_id))
                .map(|(i, size)| Pair {
                    item: i,
                    remote_size: *size,
                    remote_version: version_of(i),
                }),
        )
        .collect();
    let (cmps, unreadable) = compare_pairs(app, client, target, &pairs, signatures).await;
    plan.signatures = cmps.values().filter_map(|c| c.signature.clone()).collect();
    let cmps: HashMap<i64, Cmp> = cmps.into_iter().map(|(id, c)| (id, c.cmp)).collect();
    let mut matching: Vec<&Item> = Vec::new();
    let mut pushes: Vec<Differing> = Vec::new();
    let mut updates: Vec<Differing> = Vec::new();
    let mut boths: Vec<Differing> = Vec::new();
    let mut legacy: Vec<Differing> = Vec::new();
    let backend = Backend::for_target(client, target).ok();
    for pair in &pairs {
        let id = pair.item.track_id;
        match cmps.get(&id) {
            Some(cmp) => {
                let (local, remote) = match cmp {
                    Cmp::Same(sig) => (sig, sig),
                    Cmp::Differs { local, remote } => (local, remote),
                };
                let base = bases.get(&id);
                let sides = match (base, &backend) {
                    (Some(base), Some(backend)) => {
                        let dest = dest_of(&base_of(target), &pair.item.rel);
                        changed_since(backend, &dest, *pair, base, local, remote)
                            .await
                            .ok()
                    }
                    _ => None,
                };
                let row = Differing {
                    pair: *pair,
                    sigs: Some((remote.clone(), local.clone())),
                };
                match verdict(local == remote, base.is_some(), sides) {
                    Verdict::Same => {
                        matching.push(pair.item);
                        if base.is_none_or(|b| needs_seed(b, local, *pair)) {
                            plan.seeds.push(Seed {
                                track_id: id,
                                local: pair.item.local.clone(),
                                size: pair.item.size,
                                sig: local.clone(),
                                remote_version: pair.remote_version.map(str::to_owned),
                            });
                        }
                    }
                    Verdict::Push => pushes.push(row),
                    Verdict::Update => updates.push(row),
                    Verdict::Both => boths.push(row),
                    Verdict::Unknown => legacy.push(row),
                }
            }
            // Unreadable: a same-size file counts as matching, as before.
            None if pair.remote_size == pair.item.size => matching.push(pair.item),
            None => legacy.push(Differing {
                pair: *pair,
                sigs: None,
            }),
        }
    }
    legacy.extend(
        d.replaces
            .iter()
            .filter(|(i, _)| !bases.contains_key(&i.track_id))
            .map(|(i, size)| Differing {
                pair: Pair {
                    item: i,
                    remote_size: *size,
                    remote_version: version_of(i),
                },
                sigs: None,
            }),
    );
    plan.in_sync = matching.len();
    plan.present = matching
        .iter()
        .map(|i| (i.track_id, i64::try_from(i.size).unwrap_or(i64::MAX)))
        .collect();

    let unstreamed = not_streamed_paths(&d.extras, known);
    // Files of tracks that went missing only recently are kept: the drive may just be unplugged.
    let (held, candidates): (Vec<&Remote>, Vec<&Remote>) = unstreamed
        .iter()
        .partition(|r| known.get(&r.rel).is_some_and(|k| k.in_grace));
    plan.held = held
        .iter()
        .map(|r| Held {
            rel: r.rel.clone(),
            reason: "Missing from the library for less than 7 days".to_owned(),
        })
        .collect();

    // Audio extras are fingerprinted so a renamed copy is found instead of deleted and re-uploaded.
    // Held ones too: a song retagged and moved locally leaves its old copy held, and it must not
    // be offered for pull as if the library lacked it.
    let audio: Vec<Remote> = candidates
        .iter()
        .chain(&held)
        .filter(|r| is_audio_name(&r.rel))
        .map(|r| (*r).clone())
        .collect();
    // Files already read on an earlier run (same path and size) are not read again.
    let cache_key = |r: &Remote| (r.rel.join("/"), r.size);
    let (known_audio, unread): (Vec<&Remote>, Vec<&Remote>) = audio
        .iter()
        .partition(|r| cached.contains_key(&cache_key(r)));
    let unread_files: Vec<Remote> = unread.into_iter().cloned().collect();
    let prints = if unread_files.is_empty() {
        Vec::new()
    } else {
        fingerprint_remote(app, client, target, &unread_files)
            .await
            .unwrap_or_else(|_| vec![None; unread_files.len()])
    };
    for (r, p) in unread_files.iter().zip(&prints) {
        if let Some(fp) = p {
            plan.fresh_prints
                .push((r.rel.join("/"), r.size, fp.clone()));
        }
    }
    let mut by_rel: HashMap<&[String], Option<String>> = unread_files
        .iter()
        .zip(prints)
        .map(|(r, p)| (r.rel.as_slice(), p))
        .collect();
    for r in known_audio {
        by_rel.insert(r.rel.as_slice(), cached.get(&cache_key(r)).cloned());
    }
    let extras = not_streamed_prints(with_prints(&candidates, &by_rel), streamed);
    plan.unchecked = extras
        .iter()
        .filter(|(r, p)| p.is_none() && is_audio_name(&r.rel))
        .count()
        + unreadable;
    let held_prints = with_prints(&held, &by_rel);
    plan.in_library = in_library(items, &[extras.as_slice(), &held_prints].concat());
    let matched = pair(items, &d.uploads, &extras);
    let resolved = resolve_boths(app, client, target, &boths, bases).await;

    let mut add = |mut a: Action| {
        a.id = *next_id;
        *next_id += 1;
        plan.actions.push(a);
    };
    let new = |kind, rel: &[String]| Action::new(target.id, kind, rel);
    for (file, item) in &matched.moves {
        add(Action {
            from: Some(file.rel.clone()),
            size: file.size,
            track_id: Some(item.track_id),
            local: Some(item.local.clone()),
            ..new(Kind::Move, &item.rel)
        });
    }
    for item in &matched.uploads {
        add(Action {
            size: item.size,
            track_id: Some(item.track_id),
            local: Some(item.local.clone()),
            ..new(Kind::Upload, &item.rel)
        });
    }
    for row in &legacy {
        let item = row.pair.item;
        let same_size = row.pair.remote_size == item.size;
        let edited_here = synced_at
            .get(&item.track_id)
            .is_some_and(|t| item.modified > *t);
        // Same size and nothing says we edited it: most likely the destination copy changed.
        let note = if !same_size {
            (item.size.abs_diff(row.pair.remote_size) <= TAG_SIZED_DELTA)
                .then(|| SIZE_NOTE.to_owned())
        } else if edited_here {
            Some(EDITED_HERE.to_owned())
        } else {
            Some(NO_BASE_NOTE.to_owned())
        };
        add(Action {
            size: item.size,
            remote_size: Some(row.pair.remote_size),
            note,
            optional: same_size && !edited_here,
            track_id: Some(item.track_id),
            local: Some(item.local.clone()),
            seen: row.sigs.as_ref().map(|(remote, _)| remote.clone()),
            ..new(Kind::Replace, &item.rel)
        });
    }
    for row in &pushes {
        let item = row.pair.item;
        add(Action {
            size: item.size,
            remote_size: Some(row.pair.remote_size),
            track_id: Some(item.track_id),
            local: Some(item.local.clone()),
            seen: row.sigs.as_ref().map(|(remote, _)| remote.clone()),
            ..new(Kind::Replace, &item.rel)
        });
    }
    for row in &updates {
        let item = row.pair.item;
        add(Action {
            size: row.pair.remote_size,
            remote_size: Some(row.pair.remote_size),
            local_size: Some(item.size),
            track_id: Some(item.track_id),
            local: Some(item.local.clone()),
            seen: row.sigs.as_ref().map(|(remote, _)| remote.clone()),
            local_seen: row.sigs.as_ref().map(|(_, local)| local.clone()),
            ..new(Kind::Update, &item.rel)
        });
    }
    for (row, how) in boths.iter().zip(resolved) {
        let item = row.pair.item;
        let base = Action {
            size: item.size,
            remote_size: Some(row.pair.remote_size),
            local_size: Some(item.size),
            track_id: Some(item.track_id),
            local: Some(item.local.clone()),
            seen: row.sigs.as_ref().map(|(remote, _)| remote.clone()),
            local_seen: row.sigs.as_ref().map(|(_, local)| local.clone()),
            ..new(Kind::Conflict, &item.rel)
        };
        add(match how {
            Resolved::Merge(fields) => Action {
                kind: Kind::Merge,
                optional: fields.iter().any(|f| f.side.is_none()),
                merge: Some(fields),
                ..base
            },
            Resolved::Conflict(note) => Action {
                optional: true,
                note: Some(note),
                ..base
            },
            Resolved::Unknown => Action {
                kind: Kind::Replace,
                optional: true,
                note: Some(BOTH_NOTE.to_owned()),
                local_size: None,
                local_seen: None,
                ..base
            },
        });
    }
    for Extra {
        file,
        note,
        duplicate_of,
    } in &matched.deletes
    {
        // Suggested: manplay's own leftover, and a song removed from the library since it was
        // synced (its grace period over), which the last sync left here.
        let removed = known.get(&file.rel).filter(|k| k.missing && !k.in_grace);
        let note = if is_unfinished_upload(&file.rel) {
            Some(UNFINISHED_NOTE.to_owned())
        } else if removed.is_some() {
            Some(REMOVED_NOTE.to_owned())
        } else {
            note.clone()
        };
        add(Action {
            size: file.size,
            optional: !(is_unfinished_upload(&file.rel) || removed.is_some()),
            note,
            track_id: known.get(&file.rel).map(|k| k.track_id),
            duplicate_of: *duplicate_of,
            ..new(Kind::Delete, &file.rel)
        });
    }
    record_tag_changes(app, client, target, &mut plan.actions).await;
    record_seen(app, client, target, &mut plan.actions).await;
    plan
}

const EDITED_HERE: &str = "Edited here";
const UNFINISHED_NOTE: &str = "Left by an upload that was cut off";
const REMOVED_NOTE: &str = "Removed from your library";
const NO_BASE_NOTE: &str = "Differs from the destination (no earlier sync to compare with)";
const BOTH_NOTE: &str = "Changed on both sides, nothing earlier to merge from";

/// Replaces compared tag by tag at most; past this the review shows only the size.
const MAX_TAG_DIFFS: usize = 500;

/// Lists which tags each replace changes, reading only the tag region of the destination copy.
/// A note that only guessed at a tag edit is dropped once the actual tags are known.
async fn record_tag_changes(
    app: &AppHandle,
    client: &Client,
    target: &SyncTarget,
    actions: &mut [Action],
) {
    use futures_util::stream::{FuturesUnordered, StreamExt};
    let Ok(backend) = Backend::for_target(client, target) else {
        return;
    };
    let base = base_of(target);
    let mut replaces: Vec<&mut Action> = actions
        .iter_mut()
        .filter(|a| {
            matches!(a.kind, Kind::Replace | Kind::Update) && a.local.is_some() && safe_rel(&a.rel)
        })
        .take(MAX_TAG_DIFFS)
        .collect();
    let jobs: Vec<(Vec<String>, u64, Option<PathBuf>)> = replaces
        .iter()
        .map(|a| {
            (
                dest_of(&base, &a.rel),
                a.remote_size.unwrap_or(a.size),
                a.local.clone(),
            )
        })
        .collect();
    let total = jobs.len();
    let backend = &backend;
    let start = |(i, (dest, size, local)): (usize, (Vec<String>, u64, Option<PathBuf>))| async move {
        (i, tag_changes(backend, &dest, size, local).await)
    };
    let mut queue = jobs.into_iter().enumerate();
    let mut running = FuturesUnordered::new();
    for next in queue.by_ref().take(COMPARE_AT_ONCE) {
        running.push(start(next));
    }
    let mut results = vec![None; total];
    let mut done = 0;
    while let Some((i, changes)) = running.next().await {
        if let Some(next) = queue.next() {
            running.push(start(next));
        }
        done += 1;
        let _ = app.emit(
            "pull-progress",
            PullProgress {
                done,
                total,
                current: "Reading tags",
            },
        );
        results[i] = changes;
    }
    for (a, changes) in replaces.iter_mut().zip(results) {
        if let Some(c) = &changes
            && !c.is_empty()
            && a.note
                .as_deref()
                .is_some_and(|n| n == EDITED_HERE || n == SIZE_NOTE || n == NO_BASE_NOTE)
        {
            a.note = None;
        }
        // An update shows what the library file becomes: from its tags to the destination's.
        a.tags = if a.kind == Kind::Update {
            changes.map(|cs| {
                cs.into_iter()
                    .map(|c| crate::tags::Change {
                        field: c.field,
                        from: c.to,
                        to: c.from,
                    })
                    .collect()
            })
        } else {
            changes
        };
    }
}

/// The primary tag of a destination file, read from its first and last bytes only.
async fn read_remote_tag(
    backend: &Backend<'_>,
    dest: &[String],
    size: u64,
) -> Option<lofty::tag::Tag> {
    use crate::tag_region::{FIRST_HEAD, MAX_HEAD, TAIL, head_needed};
    let mut head = backend
        .get_range(dest, 0, size.min(FIRST_HEAD))
        .await
        .ok()?;
    for _ in 0..8 {
        let need = head_needed(&head).min(size).min(MAX_HEAD);
        let have = head.len() as u64;
        if need <= have {
            break;
        }
        let more = backend.get_range(dest, have, need - have).await.ok()?;
        if more.is_empty() {
            break;
        }
        head.extend(more);
    }
    let have = head.len() as u64;
    let tail = if have >= size {
        Vec::new()
    } else {
        let len = TAIL.min(size - have);
        backend.get_range(dest, size - len, len).await.ok()?
    };
    crate::tag_region::read(size, head, tail)
}

/// Tag differences from the destination file to the library file, or `None` if either can't be read.
async fn tag_changes(
    backend: &Backend<'_>,
    dest: &[String],
    size: u64,
    local: Option<PathBuf>,
) -> Option<Vec<crate::tags::Change>> {
    use lofty::file::TaggedFileExt;
    let remote = read_remote_tag(backend, dest, size).await?;
    let local = local?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = lofty::read_from_path(&local).ok()?;
        Some(crate::tags::diff(Some(&remote), file.primary_tag()))
    })
    .await
    .ok()
    .flatten()
}

/// Reads the tags region and audio samples of every destination file an action would overwrite,
/// rename or remove, so applying can refuse if someone changed it after this review.
async fn record_seen(
    app: &AppHandle,
    client: &Client,
    target: &SyncTarget,
    actions: &mut [Action],
) {
    let Ok(backend) = Backend::for_target(client, target) else {
        return;
    };
    let base = base_of(target);
    let touched: Vec<&mut Action> = actions
        .iter_mut()
        .filter(|a| a.seen.is_none() && matches!(a.kind, Kind::Replace | Kind::Move | Kind::Delete))
        .collect();
    let total = touched.len();
    for (n, a) in touched.into_iter().enumerate() {
        let rel = a.from.clone().unwrap_or_else(|| a.rel.clone());
        let label = rel.join("/");
        let _ = app.emit(
            "pull-progress",
            PullProgress {
                done: n,
                total,
                current: &label,
            },
        );
        let size = a.remote_size.unwrap_or(a.size);
        a.seen = if safe_rel(&rel) {
            remote_signature(&backend, &dest_of(&base, &rel), size)
                .await
                .ok()
        } else {
            None
        };
        if a.seen.is_none() {
            let warn = "Unreadable, will be skipped";
            a.note = Some(
                a.note
                    .take()
                    .map_or(warn.to_owned(), |n| format!("{n}. {warn}")),
            );
        }
    }
}

/// Byte ranges compared to tell whether a file changed: the first and last 64 KiB (where tags
/// and metadata live) and the two inner audio samples. Small files are read whole.
fn signature_ranges(size: u64) -> Vec<(u64, u64)> {
    if size <= EDGE * 4 {
        return vec![(0, size)];
    }
    vec![
        (0, EDGE),
        (size / 3, EDGE),
        (size / 3 * 2, EDGE),
        (size - EDGE, EDGE),
    ]
}

/// Hash of the size, tags region and audio samples of a destination file.
async fn remote_signature(
    backend: &Backend<'_>,
    dest: &[String],
    size: u64,
) -> Result<String, Error> {
    let mut parts = Vec::new();
    for (start, len) in signature_ranges(size) {
        parts.push(if len == 0 {
            Vec::new()
        } else {
            backend.get_range(dest, start, len).await?
        });
    }
    Ok(crate::scan::fingerprint_from_samples(size, &parts))
}

/// Same as [`remote_signature`] for a local file.
async fn local_signature(path: &Path, size: u64) -> Result<String, Error> {
    let path = path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = std::fs::File::open(&path)?;
        let mut parts = Vec::new();
        for (start, len) in signature_ranges(size) {
            let mut buf = vec![0_u8; usize::try_from(len).map_err(|e| Error::Msg(e.to_string()))?];
            file.seek(SeekFrom::Start(start))?;
            file.read_exact(&mut buf)?;
            parts.push(buf);
        }
        Ok(crate::scan::fingerprint_from_samples(size, &parts))
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?
}

/// Fails unless the destination file still has the tags and audio seen during review.
async fn ensure_unchanged(
    backend: &Backend<'_>,
    dest: &[String],
    size: u64,
    seen: Option<&str>,
) -> Result<(), Error> {
    let Some(seen) = seen else {
        return Err(Error::Msg(
            "could not be read during review: review again".to_owned(),
        ));
    };
    if remote_signature(backend, dest, size).await? == seen {
        Ok(())
    } else {
        Err(Error::Msg(
            "tags or audio changed on the destination since review".to_owned(),
        ))
    }
}

/// A size difference this small between a library file and its destination copy is most likely
/// a tag edit rather than different audio.
const TAG_SIZED_DELTA: u64 = 512 * 1024;
const SIZE_NOTE: &str = "Likely a tag edit";
const EDGE: u64 = 64 * 1024;

/// Destination files compared at once while reviewing.
const COMPARE_AT_ONCE: usize = 8;

/// An identical file with no (or an outdated) base: the sync records one so the next review knows
/// who edited what.
#[derive(Debug, Clone)]
pub struct Seed {
    pub track_id: i64,
    pub local: PathBuf,
    pub size: u64,
    /// [`local_signature`] as compared with the destination copy.
    pub sig: String,
    /// The destination copy's change marker when it was compared.
    pub remote_version: Option<String>,
}

/// Reads the tags of each seed's file into a [`Base`]. A file that changed since it was compared
/// gets none.
pub async fn seed_bases(seeds: Vec<Seed>) -> Vec<(i64, Base)> {
    let mut out = Vec::new();
    for s in seeds {
        if let Some(base) = base_for(&s.local, s.size, s.sig, s.remote_version).await {
            out.push((s.track_id, base));
        }
    }
    out
}

/// The base of a library file that is identical to its destination copy: its signature `sig`,
/// tags, and exact check. `None` when the file no longer has that signature. The exact check is
/// left out when the file changes while it is hashed, or cannot be hashed.
async fn base_for(
    local: &Path,
    size: u64,
    sig: String,
    remote_version: Option<String>,
) -> Option<Base> {
    if local_signature(local, size).await.ok().as_deref() != Some(sig.as_str()) {
        return None;
    }
    let path = local.to_path_buf();
    let tags = tauri::async_runtime::spawn_blocking(move || crate::tags::fields_json(&path))
        .await
        .ok()
        .flatten();
    let before = local_modified(local).await;
    let content = content_hash(local).await.ok();
    let exact = match (content, before) {
        (Some(content), Some(at)) if local_modified(local).await == Some(at) => Some(Exact {
            content,
            local_modified: at,
            remote_version,
        }),
        _ => None,
    };
    Some(Base {
        local_sig: sig.clone(),
        remote_sig: sig,
        tags,
        exact,
    })
}

/// A file's modification time in Unix seconds, as [`Item::modified`] has it.
pub fn modified_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0))
}

async fn local_modified(path: &Path) -> Option<i64> {
    tokio::fs::metadata(path)
        .await
        .ok()
        .map(|m| modified_secs(&m))
}

/// Hash of every byte of a library file.
async fn content_hash(path: &Path) -> Result<String, Error> {
    let path = path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let mut hasher = blake3::Hasher::new();
        hasher.update_reader(std::fs::File::open(&path)?)?;
        Ok(hasher.finalize().to_hex().to_string())
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?
}

/// [`content_hash`] of a destination file, which means downloading all of it.
async fn remote_content_hash(backend: &Backend<'_>, dest: &[String]) -> Result<String, Error> {
    let tmp = std::env::temp_dir().join(format!(
        "manplay-content-{}-{}.part",
        std::process::id(),
        blake3::hash(dest.join("/").as_bytes()).to_hex()
    ));
    let got = backend.get(dest, &tmp).await;
    let hash = match got {
        Ok(()) => content_hash(&tmp).await,
        Err(e) => Err(e),
    };
    let _ = tokio::fs::remove_file(&tmp).await;
    hash
}

/// Which copies changed since the last sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Sides {
    local: bool,
    remote: bool,
}

/// Which sides must be hashed whole: those whose signature still matches the base although
/// their change marker moved since it, which is where an edit the samples miss would hide. A
/// destination copy written by a sync has no marker in its base yet and is trusted until read.
fn needs_full(base: &Base, pair: Pair<'_>, sigs: Sides) -> Sides {
    let Some(exact) = &base.exact else {
        return Sides {
            local: false,
            remote: false,
        };
    };
    Sides {
        local: !sigs.local && exact.local_modified != pair.item.modified,
        remote: !sigs.remote
            && exact
                .remote_version
                .as_deref()
                .is_some_and(|v| pair.remote_version != Some(v)),
    }
}

/// Which copies changed since `base`, given both signatures read now. Signatures decide where
/// they differ from the base; elsewhere a moved change marker means hashing the whole file.
async fn changed_since(
    backend: &Backend<'_>,
    dest: &[String],
    pair: Pair<'_>,
    base: &Base,
    local_sig: &str,
    remote_sig: &str,
) -> Result<Sides, Error> {
    let by_sig = Sides {
        local: local_sig != base.local_sig,
        remote: remote_sig != base.remote_sig,
    };
    let full = needs_full(base, pair, by_sig);
    let content = base.exact.as_ref().map(|e| e.content.as_str());
    let local_hash = if full.local {
        Some(content_hash(&pair.item.local).await?)
    } else {
        None
    };
    let remote_hash = if full.remote {
        Some(remote_content_hash(backend, dest).await?)
    } else {
        None
    };
    let local = by_sig.local || local_hash.is_some_and(|h| Some(h.as_str()) != content);
    let remote = by_sig.remote || remote_hash.as_deref().is_some_and(|h| Some(h) != content);
    Ok(Sides { local, remote })
}

/// Whether a matching pair's base should be stored again: it is missing pieces, or the change
/// markers it would compare with moved (so the next read does not hash the file again).
fn needs_seed(base: &Base, sig: &str, pair: Pair<'_>) -> bool {
    base.local_sig != sig
        || base.remote_sig != sig
        || base.tags.is_none()
        || base.exact.as_ref().is_none_or(|e| {
            e.local_modified != pair.item.modified
                || e.remote_version.as_deref() != pair.remote_version
        })
}

/// What reading both copies of a pair showed.
enum Cmp {
    /// Same bytes where it counts (tags and audio samples): the signature.
    Same(String),
    Differs {
        local: String,
        remote: String,
    },
}

/// What a compared pair needs, judged against its base.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /// Both copies are the same.
    Same,
    /// Only the library file changed since the last sync.
    Push,
    /// Only the destination copy changed.
    Update,
    /// Both changed.
    Both,
    /// No base to judge by.
    Unknown,
}

/// Decides what a pair needs. `sides` says who changed since the base, `None` when there is no
/// base or the check could not read a copy: then only the signatures decide.
fn verdict(sigs_match: bool, has_base: bool, sides: Option<Sides>) -> Verdict {
    match (sigs_match, has_base, sides) {
        (
            true,
            _,
            None
            | Some(Sides {
                local: false,
                remote: false,
            }),
        ) => Verdict::Same,
        (
            _,
            true,
            Some(Sides {
                local: true,
                remote: false,
            }),
        ) => Verdict::Push,
        (
            _,
            true,
            Some(Sides {
                local: false,
                remote: true,
            }),
        ) => Verdict::Update,
        (
            _,
            true,
            Some(Sides {
                local: true,
                remote: true,
            }),
        ) => Verdict::Both,
        // Differing copies whose base says neither changed: the base is not trusted.
        _ => Verdict::Unknown,
    }
}

/// The cached signature of a destination file, while it has the size and change marker it had
/// when read. A file without a change marker is always read.
fn cached_signature<'c>(
    cache: &'c SignatureCache,
    path: &str,
    size: u64,
    version: Option<&str>,
) -> Option<&'c str> {
    let cached = cache.get(path)?;
    (cached.size == size && version == Some(cached.version.as_str()))
        .then_some(cached.signature.as_str())
}

/// One pair compared, with the destination signature to cache when its file has a change marker.
struct Compared {
    cmp: Cmp,
    signature: Option<RemoteSignature>,
}

/// Compares the tags region and audio samples of every pair. Returns what each showed (a pair
/// that could not be read is missing) and how many could not be read. A destination file whose
/// size and change marker match `cache` is not read again.
async fn compare_pairs(
    app: &AppHandle,
    client: &Client,
    target: &SyncTarget,
    pairs: &[Pair<'_>],
    cache: &SignatureCache,
) -> (HashMap<i64, Compared>, usize) {
    use futures_util::stream::{FuturesUnordered, StreamExt};
    let mut out = HashMap::new();
    let Ok(backend) = Backend::for_target(client, target) else {
        return (out, pairs.len());
    };
    let base = base_of(target);
    let total = pairs.len();
    let mut queue = pairs.iter().copied();
    let mut running = FuturesUnordered::new();
    for pair in queue.by_ref().take(COMPARE_AT_ONCE) {
        running.push(compare_one(&backend, &base, pair, cache));
    }
    let (mut done, mut unreadable) = (0, 0);
    while let Some((item, result)) = running.next().await {
        if let Some(next) = queue.next() {
            running.push(compare_one(&backend, &base, next, cache));
        }
        done += 1;
        let label = item.rel.join("/");
        let _ = app.emit(
            "pull-progress",
            PullProgress {
                done,
                total,
                current: &label,
            },
        );
        match result {
            Ok(cmp) => {
                out.insert(item.track_id, cmp);
            }
            Err(_) => unreadable += 1,
        }
    }
    (out, unreadable)
}

async fn compare_one<'i>(
    backend: &Backend<'_>,
    base: &[String],
    pair: Pair<'i>,
    cache: &SignatureCache,
) -> (&'i Item, Result<Compared, Error>) {
    let result = async {
        let item = pair.item;
        let path = item.rel.join("/");
        let remote = match cached_signature(cache, &path, pair.remote_size, pair.remote_version) {
            Some(sig) => sig.to_owned(),
            None => remote_signature(backend, &dest_of(base, &item.rel), pair.remote_size).await?,
        };
        let local = local_signature(&item.local, item.size).await?;
        let signature = pair.remote_version.map(|version| RemoteSignature {
            path,
            size: pair.remote_size,
            version: version.to_owned(),
            signature: remote.clone(),
        });
        let cmp = if local == remote {
            Cmp::Same(local)
        } else {
            Cmp::Differs { local, remote }
        };
        Ok(Compared { cmp, signature })
    }
    .await;
    (pair.item, result)
}

/// What two edited copies of one file come to.
enum Resolved {
    /// Tags only: every field either side changed, with who wins where only one did.
    Merge(Vec<FieldMerge>),
    /// Cannot be combined; the note says why.
    Conflict(String),
    /// Could not be read or has no base tags.
    Unknown,
}

/// Looks inside every pair both sides edited: tag edits to the same audio merge, anything else is
/// a conflict.
async fn resolve_boths(
    app: &AppHandle,
    client: &Client,
    target: &SyncTarget,
    rows: &[Differing<'_>],
    bases: &HashMap<i64, Base>,
) -> Vec<Resolved> {
    let Ok(backend) = Backend::for_target(client, target) else {
        return rows.iter().map(|_| Resolved::Unknown).collect();
    };
    let base = base_of(target);
    let mut out = Vec::new();
    for (n, row) in rows.iter().enumerate() {
        let item = row.pair.item;
        let _ = app.emit(
            "pull-progress",
            PullProgress {
                done: n,
                total: rows.len(),
                current: &item.rel.join("/"),
            },
        );
        let tags = bases
            .get(&item.track_id)
            .and_then(|b| b.tags.as_deref())
            .and_then(crate::tags::parse_fields);
        out.push(match tags {
            Some(tags) => resolve_both(&backend, &dest_of(&base, &item.rel), row.pair, &tags).await,
            None => Resolved::Unknown,
        });
    }
    out
}

async fn resolve_both(
    backend: &Backend<'_>,
    dest: &[String],
    pair: Pair<'_>,
    base_tags: &BTreeMap<String, String>,
) -> Resolved {
    let Some(remote_tag) = read_remote_tag(backend, dest, pair.remote_size).await else {
        return Resolved::Unknown;
    };
    let theirs = crate::tags::field_values(Some(&remote_tag));
    let local = pair.item.local.clone();
    let Some(mine) = tauri::async_runtime::spawn_blocking(move || crate::tags::file_fields(&local))
        .await
        .ok()
        .flatten()
    else {
        return Resolved::Unknown;
    };
    if mine == theirs {
        return Resolved::Conflict("Artwork or other tag data differs on both sides".to_owned());
    }
    if !same_audio(backend, dest, pair).await {
        return Resolved::Conflict("The audio differs on both sides".to_owned());
    }
    Resolved::Merge(crate::tags::merge(base_tags, &mine, &theirs))
}

/// Whether the library file and the destination copy hold the same audio (tags aside). The
/// destination copy is downloaded to compare; anything unreadable counts as different.
async fn same_audio(backend: &Backend<'_>, dest: &[String], pair: Pair<'_>) -> bool {
    let ext = pair
        .item
        .local
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let tmp = std::env::temp_dir().join(format!(
        "manplay-audio-{}-{}.{ext}",
        std::process::id(),
        pair.item.track_id
    ));
    let local = pair.item.local.clone();
    let result = async {
        backend.get(dest, &tmp).await?;
        let (theirs, mine) = (tmp.clone(), local);
        tauri::async_runtime::spawn_blocking(move || {
            let a = crate::audioprint::audio_print_path(&theirs)?;
            Some(a == crate::audioprint::audio_print_path(&mine)?)
        })
        .await
        .map_err(|e| Error::Msg(e.to_string()))
    }
    .await;
    let _ = tokio::fs::remove_file(&tmp).await;
    matches!(result, Ok(Some(true)))
}

// ---- applying a confirmed plan -------------------------------------------------

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySummary {
    pub target_id: i64,
    pub name: String,
    pub uploaded: usize,
    pub moved: usize,
    pub deleted: usize,
    /// Library files replaced by the destination's copy.
    pub updated: usize,
    /// Files whose tags were merged and pushed.
    pub merged: usize,
    pub failed: Vec<String>,
    pub failed_total: usize,
    /// Where copies of every overwritten or removed file were saved first.
    pub backup_dir: Option<String>,
}

pub struct Applied {
    pub summary: ApplySummary,
    /// Every library file now confirmed on the destination.
    pub present: Vec<Synced>,
    /// Track ids whose destination copy is now gone.
    pub removed: Vec<i64>,
}

impl ApplySummary {
    /// A destination where nothing ran, with the reason.
    pub fn refused(target_id: i64, name: String, reason: String) -> Self {
        let mut out = Self {
            target_id,
            name,
            ..Self::default()
        };
        out.fail(reason);
        out
    }

    fn fail(&mut self, msg: String) {
        self.failed_total += 1;
        if self.failed.len() < MAX_REPORTED_FAILURES {
            self.failed.push(msg);
        }
    }
}

fn emit(app: &AppHandle, target_id: i64, done: usize, total: usize, current: &str) {
    // Progress is best-effort; a closed window must not abort the sync.
    let _ = app.emit(
        "sync-progress",
        Progress {
            target_id,
            done,
            total,
            current,
        },
    );
}

fn dest_of(base: &[String], rel: &[String]) -> Vec<String> {
    base.iter().chain(rel.iter()).cloned().collect()
}

/// What the user chose in the review, and where things go.
pub struct Review<'a> {
    pub selected: &'a HashSet<u32>,
    pub resolutions: &'a HashMap<u32, Resolution>,
    /// Where copies of everything overwritten or removed are saved first.
    pub backup_dir: &'a Path,
    /// The library folder: files replaced by an update are moved to the Trash from here.
    pub root: &'a Path,
}

/// A selected action with the choice that settles it.
struct Job<'a> {
    a: &'a Action,
    /// What it does: a conflict is a push or an update once a side is kept.
    kind: Kind,
    res: Option<&'a Resolution>,
}

/// What a finished action leaves behind for the next review.
struct Done {
    /// Size of the library file now.
    size: u64,
    base: BaseUpdate,
}

/// Executes the chosen actions of a reviewed plan. A file is only overwritten or removed after a
/// copy of it was saved under `backup_dir` (a replaced library file goes to the Trash); if that
/// fails, the file is left alone.
#[allow(clippy::too_many_lines)]
pub async fn apply_target(
    app: &AppHandle,
    client: &Client,
    target: &SyncTarget,
    plan: &TargetPlan,
    review: &Review<'_>,
) -> Applied {
    let mut out = Applied {
        summary: ApplySummary {
            target_id: target.id,
            name: plan.name.clone(),
            ..ApplySummary::default()
        },
        present: plan
            .present
            .iter()
            .map(|(id, size)| Synced::kept(*id, *size))
            .collect(),
        removed: Vec::new(),
    };
    let mut jobs: Vec<Job> = Vec::new();
    for a in plan
        .actions
        .iter()
        .filter(|a| review.selected.contains(&a.id))
    {
        let res = review.resolutions.get(&a.id);
        let kind = match (a.kind, res.and_then(|r| r.keep)) {
            (Kind::Conflict, Some(Side::Mine)) => Kind::Replace,
            (Kind::Conflict, Some(Side::Theirs)) => Kind::Update,
            (Kind::Conflict, None) => {
                out.summary.fail(format!(
                    "{}: not changed, choose which copy to keep",
                    a.rel.join("/")
                ));
                continue;
            }
            (k, _) => k,
        };
        jobs.push(Job { a, kind, res });
    }
    let total = jobs.len();
    let base = base_of(target);
    let backend = match Backend::for_target(client, target) {
        Ok(b) => b,
        Err(e) => {
            out.summary.fail(e.to_string());
            return out;
        }
    };
    match backend.exists(&base).await {
        Ok(true) => {}
        Ok(false) => {
            out.summary
                .fail("destination folder not found (is the machine online?)".to_owned());
            return out;
        }
        Err(e) => {
            out.summary.fail(format!("destination unreachable: {e}"));
            return out;
        }
    }

    let mut done = 0;
    // 1. Save a copy of everything that will be overwritten or removed.
    let mut backed_up: HashSet<u32> = HashSet::new();
    let target_backup = review.backup_dir.join(format!("target-{}", target.id));
    for job in &jobs {
        let a = job.a;
        if !matches!(job.kind, Kind::Delete | Kind::Replace | Kind::Merge) {
            continue;
        }
        let label = a.rel.join("/");
        emit(app, target.id, done, total, &format!("Backing up {label}"));
        let expected = a.remote_size.unwrap_or(a.size);
        match backup_one(
            &backend,
            &base,
            &a.rel,
            expected,
            a.seen.as_deref(),
            &target_backup,
        )
        .await
        {
            Ok(()) => {
                backed_up.insert(a.id);
                out.summary.backup_dir = Some(review.backup_dir.to_string_lossy().into_owned());
            }
            Err(e) => out
                .summary
                .fail(format!("{label}: not changed, backup failed: {e}")),
        }
    }

    // 2. Renames, uploads, updates, then removals.
    let mut made: HashSet<Vec<String>> = HashSet::new();
    let order = [
        Kind::Move,
        Kind::Upload,
        Kind::Update,
        Kind::Replace,
        Kind::Merge,
        Kind::Delete,
    ];
    for kind in order {
        for job in jobs.iter().filter(|j| j.kind == kind) {
            let a = job.a;
            let label = a.rel.join("/");
            emit(app, target.id, done, total, &label);
            done += 1;
            if matches!(kind, Kind::Delete | Kind::Replace | Kind::Merge)
                && !backed_up.contains(&a.id)
            {
                continue; // already reported above
            }
            match run_action(&backend, &base, job, &mut made, review, &target_backup).await {
                Ok(d) => record_done(&mut out, job, d),
                Err(e) => out.summary.fail(format!("{label}: {e}")),
            }
        }
    }
    emit(app, target.id, total, total, "");
    out
}

fn record_done(out: &mut Applied, job: &Job<'_>, done: Done) {
    let a = job.a;
    let size = i64::try_from(done.size).unwrap_or(i64::MAX);
    let confirm = |out: &mut Applied| {
        if let Some(id) = a.track_id {
            out.present.push(Synced {
                track_id: id,
                size,
                base: done.base.clone(),
            });
        }
    };
    match job.kind {
        Kind::Upload | Kind::Replace => {
            out.summary.uploaded += 1;
            confirm(out);
        }
        Kind::Merge => {
            out.summary.merged += 1;
            confirm(out);
        }
        Kind::Update => {
            out.summary.updated += 1;
            confirm(out);
        }
        Kind::Move => {
            out.summary.moved += 1;
            confirm(out);
        }
        Kind::Delete => {
            out.summary.deleted += 1;
            if let Some(id) = a.track_id {
                out.removed.push(id);
            }
        }
        Kind::Conflict => {}
    }
}

/// The base to store after a library file and its destination copy were made identical:
/// `sig` is the file's signature before the transfer, and the file must still have it after.
async fn base_after(local: &Path, size: u64, sig: Option<String>) -> BaseUpdate {
    let Some(sig) = sig else {
        return BaseUpdate::Clear;
    };
    // The destination copy's marker is learned on the next read.
    base_for(local, size, sig, None)
        .await
        .map_or(BaseUpdate::Clear, BaseUpdate::Set)
}

async fn run_action(
    backend: &Backend<'_>,
    base: &[String],
    job: &Job<'_>,
    made: &mut HashSet<Vec<String>>,
    review: &Review<'_>,
    backups: &Path,
) -> Result<Done, Error> {
    let a = job.a;
    if !safe_rel(&a.rel) || a.from.as_deref().is_some_and(|f| !safe_rel(f)) {
        return Err(Error::Msg("unsafe path".to_owned()));
    }
    let dest = dest_of(base, &a.rel);
    let plain = |size| Done {
        size,
        base: BaseUpdate::Keep,
    };
    match job.kind {
        Kind::Upload | Kind::Replace => {
            let local = a
                .local
                .as_deref()
                .ok_or_else(|| Error::Msg("no local file".to_owned()))?;
            let current = backend.remote_size(&dest).await?;
            let before = local_signature(local, a.size).await.ok();
            // The destination must still look as it did when it was reviewed.
            if let (Kind::Upload, Some(size)) = (job.kind, current) {
                // Only an identical copy (same tags and audio) counts as already uploaded.
                let same = size == a.size
                    && remote_signature(backend, &dest, size).await?
                        == local_signature(local, a.size).await?;
                return if same {
                    Ok(Done {
                        size: a.size,
                        base: base_after(local, a.size, before).await,
                    })
                } else {
                    Err(Error::Msg(
                        "appeared on the destination since review".to_owned(),
                    ))
                };
            }
            if job.kind == Kind::Replace {
                if current != a.remote_size {
                    return Err(Error::Msg(
                        "changed on the destination since review".to_owned(),
                    ));
                }
                let size = a.remote_size.unwrap_or(a.size);
                ensure_unchanged(backend, &dest, size, a.seen.as_deref()).await?;
            }
            ensure_dirs(backend, base, &dest, made).await?;
            backend
                .put_whole(&dest, local, job.kind == Kind::Replace)
                .await?;
            Ok(Done {
                size: a.size,
                base: base_after(local, a.size, before).await,
            })
        }
        Kind::Move => {
            let from = dest_of(base, a.from.as_deref().unwrap_or_default());
            if backend.remote_size(&from).await? != Some(a.size) {
                return Err(Error::Msg("source changed since review".to_owned()));
            }
            ensure_unchanged(backend, &from, a.size, a.seen.as_deref()).await?;
            if backend.remote_size(&dest).await?.is_some() {
                return Err(Error::Msg("destination path already exists".to_owned()));
            }
            ensure_dirs(backend, base, &dest, made).await?;
            backend.rename(&from, &dest).await?;
            // The moved copy is the reviewed one; it is a base only if the library file matches it.
            let state = match a.local.as_deref() {
                Some(local) => {
                    let sig = local_signature(local, a.size).await.ok();
                    if sig.is_some() && sig.as_deref() == a.seen.as_deref() {
                        base_after(local, a.size, sig).await
                    } else {
                        BaseUpdate::Clear
                    }
                }
                None => BaseUpdate::Clear,
            };
            Ok(Done {
                size: a.size,
                base: state,
            })
        }
        Kind::Delete => match backend.remote_size(&dest).await? {
            None => Ok(plain(a.size)),
            Some(size) if size == a.size => {
                ensure_unchanged(backend, &dest, size, a.seen.as_deref()).await?;
                backend.delete(&dest).await?;
                Ok(plain(a.size))
            }
            Some(_) => Err(Error::Msg(
                "changed on the destination since review".to_owned(),
            )),
        },
        Kind::Update => update_library(backend, &dest, a, review.root).await,
        Kind::Merge => merge_library(backend, &dest, job, &backups.join("library")).await,
        Kind::Conflict => Err(Error::Msg("choose which copy to keep".to_owned())),
    }
}

/// Fails unless the library file is still the one that was reviewed.
async fn ensure_local_unchanged(a: &Action) -> Result<PathBuf, Error> {
    let local = a
        .local
        .clone()
        .ok_or_else(|| Error::Msg("no local file".to_owned()))?;
    let size = tokio::fs::metadata(&local).await?.len();
    let unchanged = Some(size) == a.local_size
        && local_signature(&local, size).await.ok().as_deref() == a.local_seen.as_deref()
        && a.local_seen.is_some();
    if unchanged {
        Ok(local)
    } else {
        Err(Error::Msg(
            "changed in your library since review: review again".to_owned(),
        ))
    }
}

/// Fails unless the destination copy still has the size and signature that were reviewed.
async fn ensure_remote_unchanged(
    backend: &Backend<'_>,
    dest: &[String],
    a: &Action,
) -> Result<u64, Error> {
    let size = a.remote_size.unwrap_or(a.size);
    if backend.remote_size(dest).await? != Some(size) {
        return Err(Error::Msg(
            "changed on the destination since review".to_owned(),
        ));
    }
    ensure_unchanged(backend, dest, size, a.seen.as_deref()).await?;
    Ok(size)
}

/// Replaces the library file with the destination copy. The new file is downloaded beside the old
/// one and checked against the review first; the old one goes to the Trash before it is swapped in.
async fn update_library(
    backend: &Backend<'_>,
    dest: &[String],
    a: &Action,
    root: &Path,
) -> Result<Done, Error> {
    let local = ensure_local_unchanged(a).await?;
    let size = ensure_remote_unchanged(backend, dest, a).await?;
    let tmp = part_path(&local);
    let root = root.to_path_buf();
    let installed = async {
        backend.get(dest, &tmp).await?;
        install_update(&local, &tmp, size, a.seen.as_deref(), move |old| {
            fsops::trash(&root, &[old.to_path_buf()])
        })
        .await
    }
    .await;
    if let Err(e) = installed {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(Done {
        size,
        base: base_after(&local, size, a.seen.clone()).await,
    })
}

/// Checks the downloaded `tmp` is the copy that was reviewed (`size`, signature `seen`), then
/// moves the library file `local` to the Trash and puts `tmp` in its place.
async fn install_update(
    local: &Path,
    tmp: &Path,
    size: u64,
    seen: Option<&str>,
    trash: impl FnOnce(&Path) -> Result<(), Error> + Send + 'static,
) -> Result<(), Error> {
    let got = tokio::fs::metadata(tmp).await?.len();
    if got != size || seen.is_none() || local_signature(tmp, got).await.ok().as_deref() != seen {
        return Err(Error::Msg("download differs from review".to_owned()));
    }
    let (old, new) = (local.to_path_buf(), tmp.to_path_buf());
    tauri::async_runtime::spawn_blocking(move || replace_library_file(&old, &new, trash))
        .await
        .map_err(|e| Error::Msg(e.to_string()))?
}

/// Swaps `new` in for the library file `old`. `old` is first handed to `trash`; if that fails
/// nothing is changed.
fn replace_library_file(
    old: &Path,
    new: &Path,
    trash: impl FnOnce(&Path) -> Result<(), Error>,
) -> Result<(), Error> {
    trash(old)?;
    std::fs::rename(new, old).map_err(|e| {
        Error::Msg(format!(
            "the old file is in the Trash; the new one stays at {}: {e}",
            new.display()
        ))
    })
}

/// A hidden download name beside `file`.
fn part_path(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

/// The edits that bring the library file's tags to the merged result: the fields whose winning
/// side is the destination's. A field both sides changed needs a choice in `res`.
fn merge_edits(
    fields: &[FieldMerge],
    res: Option<&Resolution>,
) -> Result<BTreeMap<String, String>, Error> {
    let mut edits = BTreeMap::new();
    for f in fields {
        let side = f
            .side
            .or_else(|| res.and_then(|r| r.fields.get(&f.field).copied()))
            .ok_or_else(|| Error::Msg(format!("choose a value for {}", f.field)))?;
        if side == Side::Theirs {
            edits.insert(f.field.clone(), f.theirs.clone().unwrap_or_default());
        }
    }
    Ok(edits)
}

/// Writes the fields taken from the destination into the library file, then pushes it. A copy
/// of the library file is saved under `library_backup` first.
async fn merge_library(
    backend: &Backend<'_>,
    dest: &[String],
    job: &Job<'_>,
    library_backup: &Path,
) -> Result<Done, Error> {
    let a = job.a;
    let local = ensure_local_unchanged(a).await?;
    ensure_remote_unchanged(backend, dest, a).await?;
    let edits = merge_edits(a.merge.as_deref().unwrap_or_default(), job.res)?;
    let copy = a
        .rel
        .iter()
        .fold(library_backup.to_path_buf(), |p, s| p.join(s));
    if let Some(parent) = copy.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::copy(&local, &copy).await?;
    let file = local.clone();
    tauri::async_runtime::spawn_blocking(move || crate::tags::write_file(&file, &edits))
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;
    let size = tokio::fs::metadata(&local).await?.len();
    let sig = local_signature(&local, size).await.ok();
    backend.put_whole(dest, &local, true).await?;
    Ok(Done {
        size,
        base: base_after(&local, size, sig).await,
    })
}

/// Creates each parent folder below the target folder once.
async fn ensure_dirs(
    backend: &Backend<'_>,
    base: &[String],
    dest: &[String],
    made: &mut HashSet<Vec<String>>,
) -> Result<(), Error> {
    for depth in (base.len() + 1)..dest.len() {
        let dir = dest[..depth].to_vec();
        if !made.contains(&dir) {
            backend.mkdir(&dir).await?;
            made.insert(dir);
        }
    }
    Ok(())
}

/// Downloads one destination file into `dir`, checking it is the file that was reviewed.
async fn backup_one(
    backend: &Backend<'_>,
    base: &[String],
    rel: &[String],
    expected: u64,
    seen: Option<&str>,
    dir: &Path,
) -> Result<(), Error> {
    if !safe_rel(rel) {
        return Err(Error::Msg("unsafe path on destination".to_owned()));
    }
    let src = dest_of(base, rel);
    let dest = rel.iter().fold(dir.to_path_buf(), |p, s| p.join(s));
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut tmp_name = dest.as_os_str().to_owned();
    tmp_name.push(".part");
    let tmp = PathBuf::from(tmp_name);
    let result = async {
        backend.get(&src, &tmp).await?;
        let got = tokio::fs::metadata(&tmp).await?.len();
        if got != expected {
            return Err(Error::Msg(format!(
                "size differs from review ({got} of {expected} bytes)"
            )));
        }
        let copied = local_signature(&tmp, got).await.ok();
        if seen.is_none() || copied.as_deref() != seen {
            return Err(Error::Msg("tags or audio differ from review".to_owned()));
        }
        tokio::fs::rename(&tmp, &dest).await?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result
}

/// Removes backup folders (named by their unix timestamp) older than `keep_secs`.
pub fn prune_backups(root: &Path, now: i64, keep_secs: i64) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for e in entries.filter_map(Result::ok) {
        let stamp = e.file_name().to_str().and_then(|n| n.parse::<i64>().ok());
        if stamp.is_some_and(|s| s <= now - keep_secs) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// A file found on a destination, relative to the destination folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub rel: Vec<String>,
    pub size: u64,
    /// What the destination says changes whenever the file does (modified time or `ETag`), when it
    /// says anything.
    #[serde(skip)]
    pub version: Option<String>,
}

/// Every song and file under the destination folder, without the shared library's own data
/// (`.manplay/`). Fails if the destination cannot be reached.
pub async fn list_remote(client: &Client, target: &SyncTarget) -> Result<Vec<Remote>, Error> {
    let base = base_of(target);
    let backend = Backend::for_target(client, target)?;
    if !backend.exists(&base).await? {
        return Err(Error::Msg(
            "folder not found (is the machine online and the folder still shared?)".to_owned(),
        ));
    }
    let mut files = backend.list(&base).await?;
    files.retain(|r| !is_library_data(&r.rel));
    Ok(files)
}

/// Appended to a file's name while it uploads to a `WebDAV` destination.
const PART_SUFFIX: &str = ".part";

/// A file left behind by an upload that was cut off.
fn is_unfinished_upload(rel: &[String]) -> bool {
    rel.last().is_some_and(|n| n.ends_with(PART_SUFFIX))
}

/// A file of the shared library's own data (`.manplay/`), which the library data sync reads and
/// writes. File sync never pulls, pushes or deletes it.
fn is_library_data(rel: &[String]) -> bool {
    rel.first()
        .is_some_and(|s| s == crate::libsync::remote::DIR)
}

/// Total size of the files inside each subfolder of `rel`, by folder name.
pub async fn remote_dir_sizes(
    client: &Client,
    target: &SyncTarget,
    rel: &[String],
) -> Result<HashMap<String, u64>, Error> {
    let dir: Vec<String> = base_of(target)
        .into_iter()
        .chain(rel.iter().cloned())
        .collect();
    let mut out: HashMap<String, u64> = HashMap::new();
    for file in Backend::for_target(client, target)?.list(&dir).await? {
        // Files directly in `rel` belong to no subfolder.
        if let (Some(folder), true) = (file.rel.first(), file.rel.len() > 1)
            && !folder.starts_with('.')
        {
            *out.entry(folder.clone()).or_default() += file.size;
        }
    }
    Ok(out)
}

/// Size of one file on a destination, `None` when it is not there.
pub async fn remote_file_size(
    client: &Client,
    target: &SyncTarget,
    rel: &[String],
) -> Result<Option<u64>, Error> {
    let path: Vec<String> = base_of(target)
        .into_iter()
        .chain(rel.iter().cloned())
        .collect();
    Backend::for_target(client, target)?
        .remote_size(&path)
        .await
}

/// `len` bytes of one destination file starting at `start`, for streaming playback.
pub async fn read_remote_range(
    client: &Client,
    target: &SyncTarget,
    rel: &[String],
    start: u64,
    len: u64,
) -> Result<Vec<u8>, Error> {
    let path: Vec<String> = base_of(target)
        .into_iter()
        .chain(rel.iter().cloned())
        .collect();
    Backend::for_target(client, target)?
        .get_range(&path, start, len)
        .await
}

/// One level of a destination, for browsing. `rel` is relative to the destination folder.
pub async fn browse_remote(
    client: &Client,
    target: &SyncTarget,
    rel: &[String],
) -> Result<Vec<webdav::Entry>, Error> {
    let dir: Vec<String> = base_of(target)
        .into_iter()
        .chain(rel.iter().cloned())
        .collect();
    let backend = Backend::for_target(client, target)?;
    backend.list_dir(&dir).await
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullOutcome {
    pub pulled: usize,
    pub skipped: usize,
    pub failed: Vec<String>,
    pub failed_total: usize,
}

#[derive(Clone, Serialize)]
struct PullProgress<'a> {
    done: usize,
    total: usize,
    current: &'a str,
}

/// A remote path is only trusted if every segment is a plain file or folder name.
pub(crate) fn safe_rel(rel: &[String]) -> bool {
    !rel.is_empty()
        && rel
            .iter()
            .all(|s| !s.is_empty() && s != "." && s != ".." && !s.contains(['/', '\\', '\0']))
}

/// Downloads `files` from the destination into the library folder. Never overwrites an
/// existing file; each download lands in a `.part` file first and is renamed once complete.
pub async fn pull(
    app: &AppHandle,
    client: &Client,
    target: &SyncTarget,
    root: &Path,
    files: &[Remote],
) -> PullOutcome {
    let mut out = PullOutcome::default();
    let base = base_of(target);
    let backend = match Backend::for_target(client, target) {
        Ok(b) => b,
        Err(e) => {
            out.failed_total = 1;
            out.failed.push(e.to_string());
            return out;
        }
    };
    let total = files.len();
    for (i, file) in files.iter().enumerate() {
        let label = file.rel.join("/");
        let _ = app.emit(
            "pull-progress",
            PullProgress {
                done: i,
                total,
                current: &label,
            },
        );
        match pull_one(&backend, &base, root, file).await {
            Ok(true) => out.pulled += 1,
            Ok(false) => out.skipped += 1,
            Err(e) => {
                out.failed_total += 1;
                if out.failed.len() < MAX_REPORTED_FAILURES {
                    out.failed.push(format!("{label}: {e}"));
                }
            }
        }
    }
    let _ = app.emit(
        "pull-progress",
        PullProgress {
            done: total,
            total,
            current: "",
        },
    );
    out
}

/// Returns `true` if downloaded, `false` if a local file already exists.
async fn pull_one(
    backend: &Backend<'_>,
    base: &[String],
    root: &Path,
    file: &Remote,
) -> Result<bool, Error> {
    if !safe_rel(&file.rel) {
        return Err(Error::Msg("unsafe path on destination".to_owned()));
    }
    let dest = file.rel.iter().fold(root.to_path_buf(), |p, s| p.join(s));
    pull_file(backend, base, file, &dest).await
}

/// Downloads one destination file to exactly `dest`. Returns `false` if a file is already there.
async fn pull_file(
    backend: &Backend<'_>,
    base: &[String],
    file: &Remote,
    dest: &Path,
) -> Result<bool, Error> {
    if tokio::fs::try_exists(dest).await? {
        return Ok(false);
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    // A name no song has, so the download cannot land on a file of the user's.
    let mut tmp_name = dest.as_os_str().to_owned();
    tmp_name.push(".manplay-part");
    let tmp = PathBuf::from(tmp_name);
    let src: Vec<String> = base.iter().chain(file.rel.iter()).cloned().collect();
    let result = async {
        backend.get(&src, &tmp).await?;
        let got = tokio::fs::metadata(&tmp).await?.len();
        if file.size != 0 && got != file.size {
            return Err(Error::Msg(format!(
                "incomplete download ({got} of {} bytes)",
                file.size
            )));
        }
        // A file that appeared at `dest` while this one came down stays.
        let (from, to) = (tmp.clone(), dest.to_path_buf());
        let placed =
            tokio::task::spawn_blocking(move || crate::fsops::move_to_free_place(&from, &to))
                .await
                .map_err(|e| Error::Msg(e.to_string()))?;
        match placed {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                tokio::fs::remove_file(&tmp).await?;
                Ok(false)
            }
            Err(e) => Err(e.into()),
        }
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result
}

/// What fetching songs from a destination did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Fetched {
    /// Songs downloaded.
    pub downloaded: usize,
    /// Songs the destination does not have (yet), or a file is already at their place here.
    pub waiting: usize,
    pub failed: usize,
}

/// How far the download of songs other devices added is: `done` of the `total` songs the
/// destination has. A `total` of 0 says no download is running.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct FetchProgress {
    pub done: usize,
    pub total: usize,
}

/// More songs than this and the destination is listed once instead of asked about each.
const LIST_ABOVE: usize = 20;

/// Downloads the songs at `wanted` (paths below the destination folder) to the same paths in
/// the library folder `root`, telling `report` before each one and once at the end. Never writes
/// over a file; a song the destination does not have is left for another time.
pub async fn fetch_songs(
    client: &Client,
    target: &SyncTarget,
    root: &Path,
    wanted: &[Vec<String>],
    report: impl Fn(FetchProgress),
) -> Result<Fetched, Error> {
    let base = base_of(target);
    let backend = Backend::for_target(client, target)?;
    let listed: Option<HashMap<Vec<String>, u64>> = if wanted.len() > LIST_ABOVE {
        Some(
            backend
                .list(&base)
                .await?
                .into_iter()
                .map(|file| (file.rel, file.size))
                .collect(),
        )
    } else {
        None
    };
    let mut out = Fetched::default();
    let mut there: Vec<Remote> = Vec::new();
    for rel in wanted.iter().filter(|rel| safe_rel(rel)) {
        let size = match &listed {
            Some(listed) => listed.get(rel).copied(),
            None => backend
                .remote_size(&dest_of(&base, rel))
                .await
                .unwrap_or(None),
        };
        match size {
            Some(size) => there.push(Remote {
                rel: rel.clone(),
                size,
                version: None,
            }),
            None => out.waiting += 1,
        }
    }
    let total = there.len();
    for (done, file) in there.iter().enumerate() {
        report(FetchProgress { done, total });
        let dest = file
            .rel
            .iter()
            .fold(root.to_path_buf(), |at, part| at.join(part));
        match pull_file(&backend, &base, file, &dest).await {
            Ok(true) => out.downloaded += 1,
            Ok(false) => out.waiting += 1,
            Err(e) => {
                log::warn!("could not fetch {}: {e}", file.rel.join("/"));
                out.failed += 1;
            }
        }
    }
    if total > 0 {
        report(FetchProgress { done: total, total });
    }
    Ok(out)
}

/// Downloads the file at `rel` below the destination folder to `dest`, by way of a part file next
/// to it. False when the destination does not have it, or a file appeared at `dest` meanwhile
/// (that file stays).
pub async fn fetch_file(
    client: &Client,
    target: &SyncTarget,
    rel: &[String],
    dest: &Path,
) -> Result<bool, Error> {
    if !safe_rel(rel) {
        return Err(Error::Msg("unsafe path on destination".to_owned()));
    }
    let base = base_of(target);
    let backend = Backend::for_target(client, target)?;
    let Some(size) = backend.remote_size(&dest_of(&base, rel)).await? else {
        return Ok(false);
    };
    let file = Remote {
        rel: rel.to_vec(),
        size,
        version: None,
    };
    pull_file(&backend, &base, &file, dest).await
}

/// Puts `file` at `rel` below the destination folder, whole, replacing what is there. The caller
/// saves what was there first.
pub async fn replace_file(
    client: &Client,
    target: &SyncTarget,
    rel: &[String],
    file: &Path,
) -> Result<(), Error> {
    if !safe_rel(rel) {
        return Err(Error::Msg("unsafe path on destination".to_owned()));
    }
    let base = base_of(target);
    let backend = Backend::for_target(client, target)?;
    backend.put_whole(&dest_of(&base, rel), file, true).await
}

/// Fingerprints of remote files, fetched with small range reads (never the whole file).
/// Each entry is `None` when that file could not be sampled.
pub async fn fingerprint_remote(
    app: &AppHandle,
    client: &Client,
    target: &SyncTarget,
    files: &[Remote],
) -> Result<Vec<Option<String>>, Error> {
    let base = base_of(target);
    let backend = Backend::for_target(client, target)?;
    let total = files.len();
    let mut out = Vec::with_capacity(total);
    for (i, file) in files.iter().enumerate() {
        let label = file.rel.join("/");
        let _ = app.emit(
            "pull-progress",
            PullProgress {
                done: i,
                total,
                current: &label,
            },
        );
        out.push(fingerprint_one(&backend, &base, file).await.ok());
    }
    let _ = app.emit(
        "pull-progress",
        PullProgress {
            done: total,
            total,
            current: "",
        },
    );
    Ok(out)
}

async fn fingerprint_one(
    backend: &Backend<'_>,
    base: &[String],
    file: &Remote,
) -> Result<String, Error> {
    if !safe_rel(&file.rel) {
        return Err(Error::Msg("unsafe path on destination".to_owned()));
    }
    let src: Vec<String> = base.iter().chain(file.rel.iter()).cloned().collect();
    let audio = crate::audioprint::audio_print_fetching(file.size, |start, len| {
        let src = &src;
        async move { backend.get_range(src, start, len).await.ok() }
    })
    .await;
    if audio.is_some() {
        return Ok(library_identity(audio, None).unwrap_or_default());
    }
    let mut parts = Vec::new();
    let ranges = crate::scan::sample_ranges(file.size)
        .ok_or_else(|| Error::Msg("file too small to fingerprint".to_owned()))?;
    for (start, len) in ranges {
        parts.push(backend.get_range(&src, start, len).await?);
    }
    let whole = crate::scan::fingerprint_from_samples(file.size, &parts);
    library_identity(None, Some(whole)).ok_or_else(|| Error::Msg("no identity".to_owned()))
}

/// A song's identity: the fingerprint of its audio alone (`audioprint`), so it is recognised
/// after a move, rename or tag edit. For formats `audioprint` doesn't know, the fingerprint of
/// the whole file (`scan::fingerprint`), marked `file:`, which a tag edit changes.
pub fn library_identity(audio_fp: Option<String>, fingerprint: Option<String>) -> Option<String> {
    audio_fp.or_else(|| fingerprint.map(|f| format!("file:{f}")))
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    fn rel(p: &str) -> Vec<String> {
        p.split('/').map(str::to_owned).collect()
    }

    #[test]
    fn only_part_files_count_as_unfinished_uploads() {
        for (path, unfinished) in [
            ("a/song.mp3.part", true),
            ("song.part", true),
            ("a/song.mp3", false),
            ("a/part/song.mp3", false),
            ("a/song.partial", false),
        ] {
            assert_eq!(is_unfinished_upload(&rel(path)), unfinished, "{path}");
        }
    }

    #[test]
    fn library_data_is_not_a_file_to_sync() {
        assert!(is_library_data(&rel(".manplay/library.json")));
        assert!(is_library_data(&rel(".manplay/log/a/00000001.jsonl.gz")));
        assert!(!is_library_data(&rel("Artist/.manplay/x.mp3")));
        assert!(!is_library_data(&rel("Artist/Album/01.mp3")));
    }

    fn item(id: i64, p: &str, size: u64, fp: Option<&str>) -> Item {
        Item {
            track_id: id,
            local: PathBuf::from(p),
            rel: rel(p),
            size,
            identity: fp.map(str::to_owned),
            modified: 0,
        }
    }

    #[test]
    fn a_cached_signature_holds_while_the_file_is_unchanged() {
        let cache: SignatureCache = [(
            "a/one.mp3".to_owned(),
            RemoteSignature {
                path: "a/one.mp3".to_owned(),
                size: 10,
                version: "v1".to_owned(),
                signature: "sig".to_owned(),
            },
        )]
        .into();
        let cases = [
            CachedCase {
                name: "unchanged",
                path: "a/one.mp3",
                size: 10,
                version: Some("v1"),
                expected: Some("sig"),
            },
            CachedCase {
                name: "new change marker",
                path: "a/one.mp3",
                size: 10,
                version: Some("v2"),
                expected: None,
            },
            CachedCase {
                name: "resized",
                path: "a/one.mp3",
                size: 11,
                version: Some("v1"),
                expected: None,
            },
            CachedCase {
                name: "no change marker",
                path: "a/one.mp3",
                size: 10,
                version: None,
                expected: None,
            },
            CachedCase {
                name: "never read",
                path: "b/two.mp3",
                size: 10,
                version: Some("v1"),
                expected: None,
            },
        ];
        for case in cases {
            assert_eq!(
                cached_signature(&cache, case.path, case.size, case.version),
                case.expected,
                "{}",
                case.name
            );
        }
    }

    struct CachedCase {
        name: &'static str,
        path: &'static str,
        size: u64,
        version: Option<&'static str>,
        expected: Option<&'static str>,
    }

    fn remote(p: &str, size: u64) -> Remote {
        Remote {
            rel: rel(p),
            size,
            version: None,
        }
    }

    fn known_at(track_id: i64, streamed: bool, in_grace: bool) -> Known {
        Known {
            track_id,
            missing: in_grace,
            in_grace,
            streamed,
        }
    }

    #[test]
    fn a_destination_file_at_a_streamed_songs_path_is_never_an_extra() {
        let files = [
            remote("a/streamed.mp3", 1),
            remote("a/kept-missing.mp3", 1),
            remote("a/unknown.mp3", 1),
        ];
        let known = HashMap::from([
            (rel("a/streamed.mp3"), known_at(1, true, false)),
            (rel("a/kept-missing.mp3"), known_at(2, false, true)),
        ]);
        let extras: Vec<&Remote> = files.iter().collect();
        let left: Vec<&[String]> = not_streamed_paths(&extras, &known)
            .iter()
            .map(|r| r.rel.as_slice())
            .collect();
        assert_eq!(
            left,
            [rel("a/kept-missing.mp3"), rel("a/unknown.mp3")],
            "only the streamed song's file is taken out; the missing one is held elsewhere"
        );
    }

    #[test]
    fn a_destination_file_with_a_streamed_songs_audio_is_never_an_extra() {
        let files = [
            remote("moved/streamed.mp3", 1),
            remote("other.mp3", 1),
            remote("unread.mp3", 1),
        ];
        let streamed = HashSet::from(["audio-streamed".to_owned()]);
        let cases: [(&Remote, Option<&str>, bool); 3] = [
            (&files[0], Some("audio-streamed"), false),
            (&files[1], Some("audio-other"), true),
            (&files[2], None, true),
        ];
        for (file, print, stays) in cases {
            let left = not_streamed_prints(vec![(file, print.map(str::to_owned))], &streamed);
            assert_eq!(!left.is_empty(), stays, "{:?}", file.rel);
        }
    }

    #[test]
    fn diff_splits_matching_new_changed_and_extra() {
        let items = [
            item(1, "a/same.wav", 10, None),
            item(2, "a/new.wav", 10, None),
            item(3, "a/changed.wav", 10, None),
        ];
        let rem = [
            remote("a/same.wav", 10),
            remote("a/changed.wav", 99),
            remote("a/extra.wav", 5),
        ];
        let d = diff(&items, &rem);
        assert_eq!(d.in_sync.len(), 1);
        assert_eq!(d.uploads.len(), 1);
        assert_eq!(d.replaces.len(), 1);
        assert_eq!(d.replaces[0].1, 99);
        assert_eq!(d.extras.len(), 1);
        assert_eq!(d.extras[0].rel, rel("a/extra.wav"));
    }

    #[test]
    fn diff_matches_paths_that_differ_only_in_case_or_unicode_form() {
        let items = [
            item(1, "Loefah/Western (Did A Skank)/a.wav", 10, None),
            item(2, "Jammz/P\u{e3}o/b.wav", 10, None),
        ];
        let rem = [
            remote("Loefah/western (did a skank)/a.wav", 10),
            remote("Jammz/Pa\u{303}o/b.wav", 10),
        ];
        let d = diff(&items, &rem);
        assert_eq!(d.in_sync.len(), 2);
        assert!(d.uploads.is_empty());
        assert!(d.extras.is_empty());
    }

    #[test]
    fn diff_prefers_the_exact_path_when_a_case_variant_also_exists() {
        let items = [
            item(1, "a/Song.wav", 10, None),
            item(2, "a/song.wav", 10, None),
        ];
        let rem = [remote("a/song.wav", 10), remote("a/Song.wav", 10)];
        let d = diff(&items, &rem);
        assert_eq!(d.in_sync.len(), 2);
        assert_eq!(d.matched[&1].rel, rel("a/Song.wav"));
        assert!(d.extras.is_empty());
    }

    #[test]
    fn same_audio_under_another_name_is_a_move_not_delete_and_upload() {
        let items = [item(1, "new/song.wav", 10, Some("fp1"))];
        let up: Vec<&Item> = items.iter().collect();
        let old = remote("old/track.wav", 10);
        let m = pair(&items, &up, &[(&old, Some("fp1".to_owned()))]);
        assert_eq!(m.moves.len(), 1);
        assert!(m.deletes.is_empty());
        assert!(m.uploads.is_empty());
    }

    #[test]
    fn same_audio_in_another_folder_counts_as_in_the_library() {
        let items = [item(1, "house/song.wav", 10, Some("fp1"))];
        let elsewhere = remote("techno/song.wav", 10);
        let unknown = remote("techno/other.wav", 10);
        let unread = remote("techno/unread.wav", 10);
        let found = in_library(
            &items,
            &[
                (&elsewhere, Some("fp1".to_owned())),
                (&unknown, Some("fp2".to_owned())),
                (&unread, None),
            ],
        );
        assert_eq!(found, HashSet::from([rel("techno/song.wav")]));
    }

    #[test]
    fn folders_count_the_files_directly_in_each() {
        let listing = [
            remote("a/b/1.mp3", 1),
            remote("a/b/2.mp3", 1),
            remote("a/3.mp3", 1),
            remote("top.mp3", 1),
        ];
        let folder = |rel: &[&str], files| RemoteFolder {
            rel: rel.iter().map(|s| (*s).to_owned()).collect(),
            files,
        };
        assert_eq!(
            folders_of(&listing),
            vec![folder(&[], 1), folder(&["a"], 1), folder(&["a", "b"], 2)]
        );
    }

    #[test]
    fn someone_elses_copy_is_renamed_to_the_library_path() {
        let items = [item(1, "mine/song.wav", 10, Some("fp"))];
        let up: Vec<&Item> = items.iter().collect();
        let theirs = remote("theirs/track.wav", 10);
        let m = pair(&items, &up, &[(&theirs, Some("fp".to_owned()))]);
        assert_eq!(m.moves.len(), 1);
        assert!(m.deletes.is_empty());
        assert!(m.uploads.is_empty());
    }

    #[test]
    fn one_extra_never_serves_two_uploads() {
        let items = [
            item(1, "a.wav", 10, Some("fp")),
            item(2, "b.wav", 10, Some("fp")),
        ];
        let up: Vec<&Item> = items.iter().collect();
        let old = remote("old.wav", 10);
        let m = pair(&items, &up, &[(&old, Some("fp".to_owned()))]);
        assert_eq!(m.moves.len(), 1);
        assert_eq!(m.uploads.len(), 1);
    }

    #[test]
    fn extra_matching_an_already_synced_file_is_a_noted_delete() {
        let items = [item(1, "a.wav", 10, Some("fp"))];
        let old = remote("copy.wav", 10);
        let m = pair(&items, &[], &[(&old, Some("fp".to_owned()))]);
        assert!(m.moves.is_empty());
        assert_eq!(m.deletes.len(), 1);
        assert_eq!(m.deletes[0].note.as_deref(), Some("Duplicate of a.wav"));
        assert_eq!(m.deletes[0].duplicate_of, Some(1));
    }

    #[test]
    fn unreadable_audio_is_flagged_and_other_files_are_plain_deletes() {
        let items = [item(1, "a.wav", 10, Some("fp"))];
        let audio = remote("x.mp3", 10);
        let art = remote("cover.jpg", 10);
        let m = pair(&items, &[], &[(&audio, None), (&art, None)]);
        assert_eq!(m.deletes[0].note.as_deref(), Some("Not compared"));
        assert_eq!(m.deletes[1].note, None);
    }

    fn base(sig: &str) -> Base {
        Base {
            local_sig: sig.to_owned(),
            remote_sig: sig.to_owned(),
            tags: None,
            exact: Some(Exact {
                content: "whole".to_owned(),
                local_modified: 100,
                remote_version: Some("v1".to_owned()),
            }),
        }
    }

    const fn sides(local: bool, remote: bool) -> Sides {
        Sides { local, remote }
    }

    #[test]
    fn who_edited_is_judged_against_the_base() {
        let cases = [
            ("identical, no base", true, false, None, Verdict::Same),
            (
                "identical, unchanged",
                true,
                true,
                Some(sides(false, false)),
                Verdict::Same,
            ),
            (
                "identical, check unreadable",
                true,
                true,
                None,
                Verdict::Same,
            ),
            (
                "edited here only",
                false,
                true,
                Some(sides(true, false)),
                Verdict::Push,
            ),
            (
                "edited there only",
                false,
                true,
                Some(sides(false, true)),
                Verdict::Update,
            ),
            (
                "edited on both",
                false,
                true,
                Some(sides(true, true)),
                Verdict::Both,
            ),
            // An edit the samples missed: the copies look the same but one changed.
            (
                "hidden edit here",
                true,
                true,
                Some(sides(true, false)),
                Verdict::Push,
            ),
            (
                "hidden edit there",
                true,
                true,
                Some(sides(false, true)),
                Verdict::Update,
            ),
            ("differ, no base", false, false, None, Verdict::Unknown),
            (
                "differ, check unreadable",
                false,
                true,
                None,
                Verdict::Unknown,
            ),
            (
                "differ, base says unchanged",
                false,
                true,
                Some(sides(false, false)),
                Verdict::Unknown,
            ),
        ];
        for (case, sigs_match, has_base, found, expected) in cases {
            assert_eq!(verdict(sigs_match, has_base, found), expected, "{case}");
        }
    }

    #[test]
    fn a_whole_file_is_hashed_only_where_a_marker_moved_but_the_samples_did_not() {
        let item = |modified| Item {
            modified,
            ..item(1, "a.mp3", 10, None)
        };
        let unmoved = item(100);
        let moved = item(200);
        let pair = |item, version| Pair {
            item,
            remote_size: 10,
            remote_version: version,
        };
        let without_marker = Base {
            exact: Some(Exact {
                remote_version: None,
                ..base("s").exact.expect("exact")
            }),
            ..base("s")
        };
        let legacy = Base {
            exact: None,
            ..base("s")
        };
        let cases = [
            (
                "nothing moved",
                &base("s"),
                pair(&unmoved, Some("v1")),
                sides(false, false),
                sides(false, false),
            ),
            (
                "library file touched",
                &base("s"),
                pair(&moved, Some("v1")),
                sides(false, false),
                sides(true, false),
            ),
            (
                "destination copy touched",
                &base("s"),
                pair(&unmoved, Some("v2")),
                sides(false, false),
                sides(false, true),
            ),
            (
                "destination lost its marker",
                &base("s"),
                pair(&unmoved, None),
                sides(false, false),
                sides(false, true),
            ),
            (
                "both touched",
                &base("s"),
                pair(&moved, Some("v2")),
                sides(false, false),
                sides(true, true),
            ),
            (
                "signatures already differ",
                &base("s"),
                pair(&moved, Some("v2")),
                sides(true, true),
                sides(false, false),
            ),
            (
                "written by a sync, marker not yet seen",
                &without_marker,
                pair(&unmoved, Some("v9")),
                sides(false, false),
                sides(false, false),
            ),
            (
                "base from before exact checks",
                &legacy,
                pair(&moved, Some("v2")),
                sides(false, false),
                sides(false, false),
            ),
        ];
        for (case, b, p, by_sig, expected) in cases {
            assert_eq!(needs_full(b, p, by_sig), expected, "{case}");
        }
    }

    #[test]
    fn a_matching_pair_is_seeded_again_when_its_base_is_incomplete_or_its_markers_moved() {
        let it = Item {
            modified: 100,
            ..item(1, "a.mp3", 10, None)
        };
        let pair = |version| Pair {
            item: &it,
            remote_size: 10,
            remote_version: version,
        };
        let with_tags = Base {
            tags: Some("{}".to_owned()),
            ..base("s")
        };
        let cases = [
            (
                "complete and current",
                &with_tags,
                "s",
                pair(Some("v1")),
                false,
            ),
            ("signature changed", &with_tags, "t", pair(Some("v1")), true),
            ("no tags", &base("s"), "s", pair(Some("v1")), true),
            (
                "destination marker moved",
                &with_tags,
                "s",
                pair(Some("v2")),
                true,
            ),
            (
                "no exact check yet",
                &Base {
                    exact: None,
                    ..with_tags.clone()
                },
                "s",
                pair(Some("v1")),
                true,
            ),
        ];
        for (case, b, sig, p, expected) in cases {
            assert_eq!(needs_seed(b, sig, p), expected, "{case}");
        }
    }

    #[tokio::test]
    async fn an_update_puts_the_old_library_file_in_the_trash_and_the_new_one_in_place() {
        let dir = std::env::temp_dir().join(format!("manplay-update-{}", std::process::id()));
        let trash_dir = dir.join("trash");
        std::fs::create_dir_all(&trash_dir).expect("mkdir");
        let lib = dir.join("song.flac");
        let new = part_path(&lib);
        std::fs::write(&lib, b"mine").expect("old");
        std::fs::write(&new, b"theirs").expect("new");
        let seen = local_signature(&new, 6).await.expect("sig");
        let to_trash = trash_dir.join("song.flac");
        install_update(&lib, &new, 6, Some(&seen), move |old| {
            std::fs::rename(old, to_trash).map_err(Error::from)
        })
        .await
        .expect("update");
        assert_eq!(std::fs::read(&lib).expect("lib"), b"theirs");
        assert_eq!(
            std::fs::read(trash_dir.join("song.flac")).expect("trash"),
            b"mine"
        );
        assert!(!new.exists());
        // The base written for it describes the new file.
        assert_eq!(
            base_after(&lib, 6, Some(seen.clone())).await,
            BaseUpdate::Set(Base {
                local_sig: seen.clone(),
                remote_sig: seen,
                tags: None,
                exact: Some(Exact {
                    content: blake3::hash(b"theirs").to_hex().to_string(),
                    local_modified: modified_secs(&std::fs::metadata(&lib).expect("meta")),
                    remote_version: None,
                }),
            })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_download_that_is_not_the_reviewed_copy_leaves_the_library_file_alone() {
        let dir = std::env::temp_dir().join(format!("manplay-stale-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let lib = dir.join("song.flac");
        let new = part_path(&lib);
        std::fs::write(&lib, b"mine").expect("old");
        std::fs::write(&new, b"theirs").expect("new");
        let reviewed = local_signature(&lib, 4).await.expect("sig");
        let result = install_update(&lib, &new, 6, Some(&reviewed), |_| {
            Err(Error::Msg("must not trash".to_owned()))
        })
        .await;
        assert!(result.is_err());
        assert_eq!(std::fs::read(&lib).expect("lib"), b"mine");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_takes_the_destinations_fields_and_needs_a_choice_for_clashes() {
        let field = |name: &str, side| FieldMerge {
            field: name.to_owned(),
            base: None,
            mine: Some("m".to_owned()),
            theirs: Some("t".to_owned()),
            side,
        };
        let fields = [
            field("genre", Some(Side::Theirs)),
            field("year", Some(Side::Mine)),
            field("label", None),
        ];
        assert!(merge_edits(&fields, None).is_err());
        let res = Resolution {
            keep: None,
            fields: HashMap::from([("label".to_owned(), Side::Theirs)]),
        };
        let edits = merge_edits(&fields, Some(&res)).expect("edits");
        assert_eq!(
            edits,
            BTreeMap::from([
                ("genre".to_owned(), "t".to_owned()),
                ("label".to_owned(), "t".to_owned())
            ])
        );
    }

    #[test]
    fn nothing_changes_when_the_old_file_cannot_be_trashed() {
        let dir = std::env::temp_dir().join(format!("manplay-notrash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let lib = dir.join("song.flac");
        let new = part_path(&lib);
        std::fs::write(&lib, b"mine").expect("old");
        std::fs::write(&new, b"theirs").expect("new");
        let result = replace_library_file(&lib, &new, |_| Err(Error::Msg("no trash".to_owned())));
        assert!(result.is_err());
        assert_eq!(std::fs::read(&lib).expect("lib"), b"mine");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn old_backups_are_pruned_by_name() {
        let dir = std::env::temp_dir().join(format!("manplay-prune-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("000000000100")).expect("old");
        std::fs::create_dir_all(dir.join("000000009000")).expect("new");
        prune_backups(&dir, 10_000, 5_000);
        assert!(!dir.join("000000000100").exists());
        assert!(dir.join("000000009000").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn signature_covers_tags_and_audio_and_stays_in_bounds() {
        let size = 1_000_000_u64;
        let ranges = signature_ranges(size);
        assert_eq!(ranges.first(), Some(&(0, EDGE)));
        assert_eq!(ranges.last(), Some(&(size - EDGE, EDGE)));
        assert!(ranges.iter().all(|(o, l)| o + l <= size));
        for size in [0, 1, EDGE * 4, EDGE * 4 + 1] {
            assert!(signature_ranges(size).iter().all(|(o, l)| o + l <= size));
        }
    }

    #[tokio::test]
    async fn a_same_size_tag_edit_changes_the_signature() {
        let path = std::env::temp_dir().join(format!("manplay-sig-{}.bin", std::process::id()));
        let mut data = vec![7_u8; 600_000];
        std::fs::write(&path, &data).expect("write");
        let before = local_signature(&path, 600_000).await.expect("sig");
        data[10] = 8; // a tag byte at the start, size unchanged
        std::fs::write(&path, &data).expect("write");
        let after = local_signature(&path, 600_000).await.expect("sig");
        assert_ne!(before, after);
        let _ = std::fs::remove_file(&path);
    }
}
