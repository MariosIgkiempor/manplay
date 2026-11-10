use std::collections::HashSet;
use std::path::PathBuf;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::webdav;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub tailnet: String,
    pub machine: String,
    /// Folder under the machine: first segment is the Taildrive share name.
    pub path: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub uploaded: usize,
    pub skipped: usize,
    pub failed: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    done: usize,
    total: usize,
    current: &'a str,
}

pub struct Item {
    pub local: PathBuf,
    /// Path relative to the library root, e.g. `["artist", "album", "01.wav"]`.
    pub rel: Vec<String>,
}

const MAX_REPORTED_FAILURES: usize = 20;

/// One-way mirror: uploads files that are missing or differ in size. Never deletes.
pub async fn run(app: &AppHandle, client: &Client, target: &Target, items: Vec<Item>) -> Summary {
    let base: Vec<String> = [target.tailnet.clone(), target.machine.clone()]
        .into_iter()
        .chain(target.path.iter().cloned())
        .collect();
    let total = items.len();
    let mut made: HashSet<Vec<String>> = HashSet::new();
    let mut summary = Summary {
        uploaded: 0,
        skipped: 0,
        failed: Vec::new(),
    };

    for (i, item) in items.iter().enumerate() {
        let label = item.rel.join("/");
        // Progress is best-effort; a closed window must not abort the sync.
        let _ = app.emit(
            "sync-progress",
            Progress {
                done: i,
                total,
                current: &label,
            },
        );
        match upload_one(client, &base, item, &mut made).await {
            Ok(true) => summary.uploaded += 1,
            Ok(false) => summary.skipped += 1,
            Err(e) => {
                if summary.failed.len() < MAX_REPORTED_FAILURES {
                    summary.failed.push(format!("{label}: {e}"));
                }
            }
        }
    }
    let _ = app.emit(
        "sync-progress",
        Progress {
            done: total,
            total,
            current: "",
        },
    );
    summary
}

async fn upload_one(
    client: &Client,
    base: &[String],
    item: &Item,
    made: &mut HashSet<Vec<String>>,
) -> Result<bool, crate::error::Error> {
    let dest: Vec<String> = base.iter().chain(item.rel.iter()).cloned().collect();
    let local_len = tokio::fs::metadata(&item.local).await?.len();
    if webdav::remote_size(client, &dest).await? == Some(local_len) {
        return Ok(false);
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
    Ok(true)
}
