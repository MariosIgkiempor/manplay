use std::collections::HashSet;
use std::path::{Path, PathBuf};

use reqwest::Client;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::db::SyncTarget;
use crate::error::Error;
use crate::r2::{self, R2};
use crate::webdav;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub uploaded: usize,
    pub skipped: usize,
    /// First few failure messages.
    pub failed: Vec<String>,
    /// Total failures, including ones not listed in `failed`.
    pub failed_total: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    target_id: i64,
    done: usize,
    total: usize,
    current: &'a str,
}

pub struct Item {
    pub track_id: i64,
    pub local: PathBuf,
    /// Path relative to the library root, e.g. `["artist", "album", "01.wav"]`.
    pub rel: Vec<String>,
}

/// A synced file whose track has been missing past the grace period.
pub struct Victim {
    pub track_id: i64,
    pub rel: Vec<String>,
}

#[derive(Default)]
pub struct Cleanup {
    /// `(track id, relative path)` of remote copies that are now gone.
    pub deleted: Vec<(i64, Vec<String>)>,
    pub errors: Vec<String>,
}

pub struct Outcome {
    /// False when the destination could not be reached at all.
    pub reachable: bool,
    pub summary: Summary,
    /// `(track_id, size)` for every file confirmed present on the target.
    pub present: Vec<(i64, i64)>,
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

    /// Every file below `base`, relative to it.
    async fn list(&self, base: &[String]) -> Result<Vec<Remote>, Error> {
        match self {
            Self::Dav(c) => Ok(webdav::list_files(c, base)
                .await?
                .into_iter()
                .map(|(rel, size)| Remote { rel, size })
                .collect()),
            Self::R2(c, r) => Ok(r
                .list(c, base)
                .await?
                .into_iter()
                .filter_map(|(key, size)| {
                    let rel: Vec<String> =
                        key.split('/').skip(base.len()).map(str::to_owned).collect();
                    // Folder placeholder keys end in "/" and leave an empty last segment.
                    rel.iter()
                        .all(|s| !s.is_empty())
                        .then_some(Remote { rel, size })
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

    async fn delete(&self, dest: &[String]) -> Result<(), Error> {
        match self {
            Self::Dav(c) => webdav::delete(c, dest).await,
            Self::R2(c, r) => r.delete(c, dest).await,
        }
    }
}

/// One-way mirror: uploads files that are missing or differ in size. Never deletes.
pub async fn run(app: &AppHandle, client: &Client, target: &SyncTarget, items: &[Item]) -> Outcome {
    let base = base_of(target);
    let backend = match Backend::for_target(client, target) {
        Ok(b) => b,
        Err(e) => return unreachable_outcome(&e.to_string()),
    };
    let total = items.len();
    match backend.exists(&base).await {
        Ok(true) => {}
        Ok(false) => {
            return unreachable_outcome(
                "folder not found (is the machine online and the folder still shared?)",
            );
        }
        Err(e) => return unreachable_outcome(&e.to_string()),
    }
    let mut made: HashSet<Vec<String>> = HashSet::new();
    let mut out = Outcome {
        reachable: true,
        summary: Summary::default(),
        present: Vec::new(),
    };

    for (i, item) in items.iter().enumerate() {
        let label = item.rel.join("/");
        // Progress is best-effort; a closed window must not abort the sync.
        let _ = app.emit(
            "sync-progress",
            Progress {
                target_id: target.id,
                done: i,
                total,
                current: &label,
            },
        );
        match upload_one(&backend, &base, item, &mut made).await {
            Ok((uploaded, size)) => {
                if uploaded {
                    out.summary.uploaded += 1;
                } else {
                    out.summary.skipped += 1;
                }
                out.present.push((item.track_id, size));
            }
            Err(e) => {
                out.summary.failed_total += 1;
                if out.summary.failed.len() < MAX_REPORTED_FAILURES {
                    out.summary.failed.push(format!("{label}: {e}"));
                }
            }
        }
    }
    let _ = app.emit(
        "sync-progress",
        Progress {
            target_id: target.id,
            done: total,
            total,
            current: "",
        },
    );
    out
}

/// Removes remote copies that this app previously synced for tracks that are long gone locally.
/// Only exact mapped file paths are deleted; folders and unknown files are never touched.
pub async fn cleanup(client: &Client, target: &SyncTarget, victims: &[Victim]) -> Cleanup {
    let base = base_of(target);
    let mut out = Cleanup::default();
    let backend = match Backend::for_target(client, target) {
        Ok(b) => b,
        Err(e) => {
            out.errors.push(e.to_string());
            return out;
        }
    };
    for v in victims {
        let dest: Vec<String> = base.iter().chain(v.rel.iter()).cloned().collect();
        match backend.delete(&dest).await {
            Ok(()) => out.deleted.push((v.track_id, v.rel.clone())),
            Err(e) => out.errors.push(format!("remove {}: {e}", v.rel.join("/"))),
        }
    }
    out
}

fn unreachable_outcome(reason: &str) -> Outcome {
    Outcome {
        reachable: false,
        summary: Summary {
            failed: vec![format!("destination unreachable: {reason}")],
            failed_total: 1,
            ..Summary::default()
        },
        present: Vec::new(),
    }
}

/// Returns `(uploaded, local size)`.
async fn upload_one(
    backend: &Backend<'_>,
    base: &[String],
    item: &Item,
    made: &mut HashSet<Vec<String>>,
) -> Result<(bool, i64), Error> {
    let dest: Vec<String> = base.iter().chain(item.rel.iter()).cloned().collect();
    let local_len = tokio::fs::metadata(&item.local).await?.len();
    let size = i64::try_from(local_len).unwrap_or(i64::MAX);
    if backend.remote_size(&dest).await? == Some(local_len) {
        return Ok((false, size));
    }
    // Create each parent folder below the target folder once.
    for depth in (base.len() + 1)..dest.len() {
        let dir = dest[..depth].to_vec();
        if !made.contains(&dir) {
            backend.mkdir(&dir).await?;
            made.insert(dir);
        }
    }
    backend.put(&dest, &item.local).await?;
    Ok((true, size))
}

/// A file found on a destination, relative to the destination folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub rel: Vec<String>,
    pub size: u64,
}

/// Everything under the destination folder. Fails if the destination cannot be reached.
pub async fn list_remote(client: &Client, target: &SyncTarget) -> Result<Vec<Remote>, Error> {
    let base = base_of(target);
    let backend = Backend::for_target(client, target)?;
    if !backend.exists(&base).await? {
        return Err(Error::Msg(
            "folder not found (is the machine online and the folder still shared?)".to_owned(),
        ));
    }
    backend.list(&base).await
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
fn safe_rel(rel: &[String]) -> bool {
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
    if tokio::fs::try_exists(&dest).await? {
        return Ok(false);
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut tmp_name = dest.as_os_str().to_owned();
    tmp_name.push(".part");
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
        tokio::fs::rename(&tmp, &dest).await?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result.map(|()| true)
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
    let mut parts = Vec::new();
    let ranges = crate::scan::sample_ranges(file.size)
        .ok_or_else(|| Error::Msg("file too small to fingerprint".to_owned()))?;
    for (start, len) in ranges {
        parts.push(backend.get_range(&src, start, len).await?);
    }
    Ok(crate::scan::fingerprint_from_samples(file.size, &parts))
}
