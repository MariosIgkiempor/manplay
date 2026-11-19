//! Moving files between the library and a destination, and inside one destination: what the file
//! browser's drag and drop does. Nothing here overwrites a file.

use std::path::{Path, PathBuf};

use reqwest::Client;
use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use super::{
    Backend, MAX_REPORTED_FAILURES, PullOutcome, PullProgress, Remote, base_of, dest_of,
    ensure_dirs, pull_file, safe_rel,
};
use crate::db::SyncTarget;
use crate::error::Error;

/// A file or folder on a destination, by path below the destination folder.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub rel: Vec<String>,
    pub is_dir: bool,
}

fn err(msg: impl Into<String>) -> Error {
    Error::Msg(msg.into())
}

fn progress(app: &AppHandle, done: usize, total: usize, current: &str) {
    let _ = app.emit(
        "pull-progress",
        PullProgress {
            done,
            total,
            current,
        },
    );
}

fn record(out: &mut PullOutcome, label: &str, result: Result<bool, Error>) {
    match result {
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

/// Every file inside `items`, with the path it gets when the item is dropped into a folder:
/// the item's own name, then whatever is below it.
async fn expand(
    backend: &Backend<'_>,
    base: &[String],
    items: &[Item],
) -> Result<Vec<(Remote, Vec<String>)>, Error> {
    let mut out = Vec::new();
    for item in items {
        if !safe_rel(&item.rel) {
            return Err(err("unsafe path on destination"));
        }
        let name = item.rel[item.rel.len() - 1].clone();
        if item.is_dir {
            for f in backend.list(&dest_of(base, &item.rel)).await? {
                let rel = item.rel.iter().chain(f.rel.iter()).cloned().collect();
                let local = std::iter::once(name.clone()).chain(f.rel.iter().cloned());
                out.push((Remote { rel, ..f }, local.collect()));
            }
        } else if let Some(size) = backend.remote_size(&dest_of(base, &item.rel)).await? {
            out.push((
                Remote {
                    rel: item.rel.clone(),
                    size,
                    version: None,
                },
                vec![name],
            ));
        }
    }
    Ok(out)
}

/// Copies `items` from the destination into the local folder `dest_dir`.
pub async fn download(
    app: &AppHandle,
    client: &Client,
    target: &SyncTarget,
    items: &[Item],
    dest_dir: &Path,
) -> Result<PullOutcome, Error> {
    let base = base_of(target);
    let backend = Backend::for_target(client, target)?;
    let files = expand(&backend, &base, items).await?;
    let mut out = PullOutcome::default();
    let total = files.len();
    for (i, (file, local)) in files.iter().enumerate() {
        let label = file.rel.join("/");
        progress(app, i, total, &label);
        if !safe_rel(local) {
            record(&mut out, &label, Err(err("unsafe path on destination")));
            continue;
        }
        let dest = local.iter().fold(dest_dir.to_path_buf(), |p, s| p.join(s));
        record(
            &mut out,
            &label,
            pull_file(&backend, &base, file, &dest).await,
        );
    }
    progress(app, total, total, "");
    Ok(out)
}

/// Copies local files to the destination. Each is `(local file, path below the destination
/// folder)`; a file already there is left alone.
pub async fn upload(
    app: &AppHandle,
    client: &Client,
    target: &SyncTarget,
    files: &[(PathBuf, Vec<String>)],
) -> Result<PullOutcome, Error> {
    let base = base_of(target);
    let backend = Backend::for_target(client, target)?;
    let mut out = PullOutcome::default();
    let mut made = std::collections::HashSet::new();
    let total = files.len();
    for (i, (local, rel)) in files.iter().enumerate() {
        let label = rel.join("/");
        progress(app, i, total, &label);
        let one = async {
            if !safe_rel(rel) {
                return Err(err("unsafe path on destination"));
            }
            let dest = dest_of(&base, rel);
            if backend.remote_size(&dest).await?.is_some() {
                return Ok(false);
            }
            ensure_dirs(&backend, &base, &dest, &mut made).await?;
            backend.put_whole(&dest, local, false).await?;
            Ok(true)
        }
        .await;
        record(&mut out, &label, one);
    }
    progress(app, total, total, "");
    Ok(out)
}

/// Moves `items` into the destination folder `dest` (empty for the destination's top folder).
/// Everything is checked first, so a name clash or a move into itself changes nothing.
pub async fn move_items(
    client: &Client,
    target: &SyncTarget,
    items: &[Item],
    dest: &[String],
) -> Result<usize, Error> {
    let base = base_of(target);
    let backend = Backend::for_target(client, target)?;
    if !dest.iter().all(|s| safe_rel(std::slice::from_ref(s))) {
        return Err(err("unsafe path on destination"));
    }
    let mut plan: Vec<(&Item, Vec<String>)> = Vec::new();
    for item in items {
        if !safe_rel(&item.rel) {
            return Err(err("unsafe path on destination"));
        }
        let name = &item.rel[item.rel.len() - 1];
        let to: Vec<String> = dest.iter().cloned().chain([name.clone()]).collect();
        if to == item.rel {
            continue;
        }
        if item.is_dir && to.starts_with(&item.rel) {
            return Err(err(format!("cannot move “{name}” into itself")));
        }
        let taken = if item.is_dir {
            !backend.list(&dest_of(&base, &to)).await?.is_empty()
        } else {
            backend.remote_size(&dest_of(&base, &to)).await?.is_some()
        };
        if taken || plan.iter().any(|(_, t)| *t == to) {
            return Err(err(format!("“{name}” already exists in that folder")));
        }
        plan.push((item, to));
    }
    for (item, to) in &plan {
        let from = dest_of(&base, &item.rel);
        let to_full = dest_of(&base, to);
        match (&backend, item.is_dir) {
            // A WebDAV server moves a whole folder in one request.
            (Backend::Dav(_), _) | (_, false) => backend.rename(&from, &to_full).await?,
            // A bucket has no folders: move every object under the prefix.
            (Backend::R2(..), true) => {
                for f in backend.list(&from).await? {
                    let old: Vec<String> = from.iter().chain(f.rel.iter()).cloned().collect();
                    let new: Vec<String> = to_full.iter().chain(f.rel.iter()).cloned().collect();
                    backend.rename(&old, &new).await?;
                }
            }
        }
    }
    Ok(plan.len())
}
