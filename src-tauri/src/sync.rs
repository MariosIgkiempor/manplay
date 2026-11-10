use std::collections::HashSet;
use std::path::PathBuf;

use reqwest::Client;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::db::SyncTarget;
use crate::webdav;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub uploaded: usize,
    pub skipped: usize,
    pub failed: Vec<String>,
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

pub struct Outcome {
    pub summary: Summary,
    /// `(track_id, size)` for every file confirmed present on the target.
    pub present: Vec<(i64, i64)>,
}

const MAX_REPORTED_FAILURES: usize = 20;

/// One-way mirror: uploads files that are missing or differ in size. Never deletes.
pub async fn run(app: &AppHandle, client: &Client, target: &SyncTarget, items: &[Item]) -> Outcome {
    let base: Vec<String> = [target.tailnet.clone(), target.machine.clone()]
        .into_iter()
        .chain(target.path.iter().cloned())
        .collect();
    let total = items.len();
    let mut made: HashSet<Vec<String>> = HashSet::new();
    let mut out = Outcome {
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
        match upload_one(client, &base, item, &mut made).await {
            Ok((uploaded, size)) => {
                if uploaded {
                    out.summary.uploaded += 1;
                } else {
                    out.summary.skipped += 1;
                }
                out.present.push((item.track_id, size));
            }
            Err(e) => {
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

/// Returns `(uploaded, local size)`.
async fn upload_one(
    client: &Client,
    base: &[String],
    item: &Item,
    made: &mut HashSet<Vec<String>>,
) -> Result<(bool, i64), crate::error::Error> {
    let dest: Vec<String> = base.iter().chain(item.rel.iter()).cloned().collect();
    let local_len = tokio::fs::metadata(&item.local).await?.len();
    let size = i64::try_from(local_len).unwrap_or(i64::MAX);
    if webdav::remote_size(client, &dest).await? == Some(local_len) {
        return Ok((false, size));
    }
    // Create each parent folder below the target folder once.
    for depth in (base.len() + 1)..dest.len() {
        let dir = dest[..depth].to_vec();
        if !made.contains(&dir) {
            webdav::mkcol(client, &dir).await?;
            made.insert(dir);
        }
    }
    webdav::put(client, &dest, &item.local).await?;
    Ok((true, size))
}
