use std::collections::HashSet;
use std::path::PathBuf;

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
