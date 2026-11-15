use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use reqwest::Client;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::db::SyncTarget;
use crate::error::Error;
use crate::r2::{self, R2};
use crate::webdav;

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
    pub fingerprint: Option<String>,
    /// Last modification time of the local file (unix seconds).
    pub modified: i64,
}

/// What the library knows about a destination path: a track record, and whether it is only
/// missing for now (still inside the grace period).
#[derive(Clone, Copy)]
pub struct Known {
    pub track_id: i64,
    pub in_grace: bool,
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

    /// Renames a file on the destination. Never overwrites an existing file.
    async fn rename(&self, from: &[String], to: &[String]) -> Result<(), Error> {
        match self {
            Self::Dav(c) => webdav::move_file(c, from, to).await,
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
    #[serde(skip)]
    pub track_id: Option<i64>,
    #[serde(skip)]
    pub local: Option<PathBuf>,
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
    /// `(track id, size)` of library files already on the destination.
    #[serde(skip)]
    pub present: Vec<(i64, i64)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub targets: Vec<TargetPlan>,
}

struct Diff<'a> {
    in_sync: Vec<&'a Item>,
    uploads: Vec<&'a Item>,
    replaces: Vec<(&'a Item, u64)>,
    extras: Vec<&'a Remote>,
}

/// Splits library and destination into matching files, files to push, and files the library lacks.
fn diff<'a>(items: &'a [Item], remote: &'a [Remote]) -> Diff<'a> {
    let remote_sizes: HashMap<&[String], u64> =
        remote.iter().map(|r| (r.rel.as_slice(), r.size)).collect();
    let mut out = Diff {
        in_sync: Vec::new(),
        uploads: Vec::new(),
        replaces: Vec::new(),
        extras: Vec::new(),
    };
    for item in items {
        match remote_sizes.get(item.rel.as_slice()) {
            Some(size) if *size == item.size => out.in_sync.push(item),
            Some(size) => out.replaces.push((item, *size)),
            None => out.uploads.push(item),
        }
    }
    let local: HashSet<&[String]> = items.iter().map(|i| i.rel.as_slice()).collect();
    out.extras = remote
        .iter()
        .filter(|r| !local.contains(r.rel.as_slice()))
        .collect();
    out
}

/// Outcome of matching destination extras against the library by audio.
struct Matched<'a> {
    moves: Vec<(&'a Remote, &'a Item)>,
    /// Extras to remove, with an optional explanation.
    deletes: Vec<(&'a Remote, Option<String>)>,
    /// Uploads not replaced by a move.
    uploads: Vec<&'a Item>,
}

/// Pairs each extra whose audio equals a pending upload (one-to-one) so it is renamed instead of
/// removed and re-uploaded. `prints` holds each extra's fingerprint, if it could be read.
fn pair<'a>(
    items: &'a [Item],
    uploads: &[&'a Item],
    extras: &[(&'a Remote, Option<String>)],
) -> Matched<'a> {
    let mut wanting: HashMap<&str, Vec<&'a Item>> = HashMap::new();
    for item in uploads {
        if let Some(fp) = &item.fingerprint {
            wanting.entry(fp.as_str()).or_default().push(item);
        }
    }
    let known: HashMap<&str, &Item> = items
        .iter()
        .filter_map(|i| Some((i.fingerprint.as_deref()?, i)))
        .collect();
    let mut moved: HashSet<i64> = HashSet::new();
    let mut out = Matched {
        moves: Vec::new(),
        deletes: Vec::new(),
        uploads: Vec::new(),
    };
    for (file, print) in extras {
        let Some(fp) = print else {
            let note = is_audio_name(&file.rel).then(|| "Audio could not be compared".to_owned());
            out.deletes.push((file, note));
            continue;
        };
        if let Some(item) = wanting.get_mut(fp.as_str()).and_then(Vec::pop) {
            moved.insert(item.track_id);
            out.moves.push((file, item));
        } else {
            let note = known
                .get(fp.as_str())
                .map(|i| format!("Same audio as {}", i.rel.join("/")));
            out.deletes.push((file, note));
        }
    }
    out.uploads = uploads
        .iter()
        .filter(|i| !moved.contains(&i.track_id))
        .copied()
        .collect();
    out
}

fn is_audio_name(rel: &[String]) -> bool {
    rel.last()
        .is_some_and(|n| !n.starts_with('.') && crate::scan::is_audio(Path::new(n)))
}

/// Compares the destination with the library and lists what a sync would do. Reads only.
#[allow(clippy::too_many_lines)]
pub async fn plan_target(
    app: &AppHandle,
    client: &Client,
    target: &SyncTarget,
    items: &[Item],
    known: &HashMap<Vec<String>, Known>,
    synced_at: &HashMap<i64, i64>,
    next_id: &mut u32,
) -> TargetPlan {
    let mut plan = TargetPlan {
        target_id: target.id,
        name: target_name(target),
        error: None,
        actions: Vec::new(),
        held: Vec::new(),
        in_sync: 0,
        remote_total: 0,
        unchecked: 0,
        present: Vec::new(),
    };
    let remote = match list_remote(client, target).await {
        Ok(r) => r,
        Err(e) => {
            plan.error = Some(format!("destination unreachable: {e}"));
            return plan;
        }
    };
    plan.remote_total = remote.len();
    let d = diff(items, &remote);
    // Same path and size can still differ in tags: files edited since their last sync have their
    // first and last 64 KiB compared with the destination's copy.
    let retag = changed_metadata(app, client, target, &d.in_sync, synced_at).await;
    plan.in_sync = d.in_sync.len() - retag.len();
    plan.present = d
        .in_sync
        .iter()
        .filter(|i| !retag.contains(&i.track_id))
        .map(|i| (i.track_id, i64::try_from(i.size).unwrap_or(i64::MAX)))
        .collect();

    // Files of tracks that went missing only recently are kept: the drive may just be unplugged.
    let (held, candidates): (Vec<&Remote>, Vec<&Remote>) = d
        .extras
        .iter()
        .partition(|r| known.get(&r.rel).is_some_and(|k| k.in_grace));
    plan.held = held
        .into_iter()
        .map(|r| Held {
            rel: r.rel.clone(),
            reason: "Missing from the library for less than 7 days".to_owned(),
        })
        .collect();

    // Audio extras are fingerprinted so a renamed copy is found instead of deleted and re-uploaded.
    let audio: Vec<Remote> = candidates
        .iter()
        .filter(|r| is_audio_name(&r.rel))
        .map(|r| (*r).clone())
        .collect();
    let prints = if audio.is_empty() {
        vec![None; audio.len()]
    } else {
        fingerprint_remote(app, client, target, &audio)
            .await
            .unwrap_or_else(|_| vec![None; audio.len()])
    };
    let by_rel: HashMap<&[String], Option<String>> = audio
        .iter()
        .zip(prints)
        .map(|(r, p)| (r.rel.as_slice(), p))
        .collect();
    plan.unchecked = by_rel.values().filter(|p| p.is_none()).count();
    let extras: Vec<(&Remote, Option<String>)> = candidates
        .iter()
        .map(|r| (*r, by_rel.get(r.rel.as_slice()).cloned().flatten()))
        .collect();
    let matched = pair(items, &d.uploads, &extras);

    let mut push = |kind, rel: &[String], from, size, remote_size, note, track_id, local| {
        let id = *next_id;
        *next_id += 1;
        plan.actions.push(Action {
            id,
            target_id: target.id,
            kind,
            rel: rel.to_vec(),
            from,
            size,
            remote_size,
            note,
            track_id,
            local,
        });
    };
    for (file, item) in &matched.moves {
        let note = Some(format!("Same audio as {}", item.rel.join("/")));
        push(
            Kind::Move,
            &item.rel,
            Some(file.rel.clone()),
            file.size,
            None,
            note,
            Some(item.track_id),
            None,
        );
    }
    for item in &matched.uploads {
        push(
            Kind::Upload,
            &item.rel,
            None,
            item.size,
            None,
            None,
            Some(item.track_id),
            Some(item.local.clone()),
        );
    }
    for (item, remote_size) in &d.replaces {
        let delta = item.size.abs_diff(*remote_size);
        let note = (delta <= TAG_SIZED_DELTA).then(|| {
            format!(
                "Size differs by {} KB: likely a tag edit",
                delta.div_ceil(1024)
            )
        });
        push(
            Kind::Replace,
            &item.rel,
            None,
            item.size,
            Some(*remote_size),
            note,
            Some(item.track_id),
            Some(item.local.clone()),
        );
    }
    for item in d.in_sync.iter().filter(|i| retag.contains(&i.track_id)) {
        push(
            Kind::Replace,
            &item.rel,
            None,
            item.size,
            Some(item.size),
            Some("Tags or metadata changed since the last sync (same file size)".to_owned()),
            Some(item.track_id),
            Some(item.local.clone()),
        );
    }
    for (file, note) in &matched.deletes {
        push(
            Kind::Delete,
            &file.rel,
            None,
            file.size,
            None,
            note.clone(),
            known.get(&file.rel).map(|k| k.track_id),
            None,
        );
    }
    plan
}

/// A size difference this small between a library file and its destination copy is most likely
/// a tag edit rather than different audio.
const TAG_SIZED_DELTA: u64 = 512 * 1024;
const EDGE: u64 = 64 * 1024;

/// Ids of in-sync files modified since their last sync whose head or tail bytes differ from the
/// destination's copy. A file that cannot be compared counts as unchanged.
async fn changed_metadata(
    app: &AppHandle,
    client: &Client,
    target: &SyncTarget,
    in_sync: &[&Item],
    synced_at: &HashMap<i64, i64>,
) -> HashSet<i64> {
    let candidates: Vec<&&Item> = in_sync
        .iter()
        .filter(|i| synced_at.get(&i.track_id).is_some_and(|t| i.modified > *t))
        .collect();
    let mut out = HashSet::new();
    let Ok(backend) = Backend::for_target(client, target) else {
        return out;
    };
    let base = base_of(target);
    let total = candidates.len();
    for (n, item) in candidates.into_iter().enumerate() {
        let label = item.rel.join("/");
        let _ = app.emit(
            "pull-progress",
            PullProgress {
                done: n,
                total,
                current: &label,
            },
        );
        if edges_differ(&backend, &base, item).await.unwrap_or(false) {
            out.insert(item.track_id);
        }
    }
    out
}

fn read_edges(path: &Path, size: u64, len: u64) -> Result<(Vec<u8>, Vec<u8>), Error> {
    use std::io::{Read, Seek, SeekFrom};
    let n = usize::try_from(len).map_err(|e| Error::Msg(e.to_string()))?;
    let mut file = std::fs::File::open(path)?;
    let mut head = vec![0_u8; n];
    file.read_exact(&mut head)?;
    file.seek(SeekFrom::Start(size - len))?;
    let mut tail = vec![0_u8; n];
    file.read_exact(&mut tail)?;
    Ok((head, tail))
}

async fn edges_differ(backend: &Backend<'_>, base: &[String], item: &Item) -> Result<bool, Error> {
    let len = item.size.min(EDGE);
    if len == 0 {
        return Ok(false);
    }
    let dest = dest_of(base, &item.rel);
    let (path, size) = (item.local.clone(), item.size);
    let (head, tail) = tauri::async_runtime::spawn_blocking(move || read_edges(&path, size, len))
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;
    if backend.get_range(&dest, 0, len).await? != head {
        return Ok(true);
    }
    Ok(backend.get_range(&dest, item.size - len, len).await? != tail)
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
    pub failed: Vec<String>,
    pub failed_total: usize,
    /// Where copies of every overwritten or removed file were saved first.
    pub backup_dir: Option<String>,
}

pub struct Applied {
    pub summary: ApplySummary,
    /// `(track id, size)` of every library file now confirmed on the destination.
    pub present: Vec<(i64, i64)>,
    /// Track ids whose destination copy is now gone.
    pub removed: Vec<i64>,
}

impl ApplySummary {
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

/// Executes the chosen actions of a reviewed plan. A file is only overwritten or removed after a
/// copy of it was saved under `backup_dir`; if that copy fails, the file is left alone.
pub async fn apply_target(
    app: &AppHandle,
    client: &Client,
    target: &SyncTarget,
    plan: &TargetPlan,
    selected: &HashSet<u32>,
    backup_dir: &Path,
) -> Applied {
    let mut out = Applied {
        summary: ApplySummary {
            target_id: target.id,
            name: plan.name.clone(),
            ..ApplySummary::default()
        },
        present: plan.present.clone(),
        removed: Vec::new(),
    };
    let actions: Vec<&Action> = plan
        .actions
        .iter()
        .filter(|a| selected.contains(&a.id))
        .collect();
    let total = actions.len();
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
    let target_backup = backup_dir.join(format!("target-{}", target.id));
    for a in &actions {
        if !matches!(a.kind, Kind::Delete | Kind::Replace) {
            continue;
        }
        let label = a.rel.join("/");
        emit(app, target.id, done, total, &format!("Backing up {label}"));
        let expected = a.remote_size.unwrap_or(a.size);
        match backup_one(&backend, &base, &a.rel, expected, &target_backup).await {
            Ok(()) => {
                backed_up.insert(a.id);
                out.summary.backup_dir = Some(backup_dir.to_string_lossy().into_owned());
            }
            Err(e) => out
                .summary
                .fail(format!("{label}: not changed, backup failed: {e}")),
        }
    }

    // 2. Renames, uploads, then removals.
    let mut made: HashSet<Vec<String>> = HashSet::new();
    let order = [Kind::Move, Kind::Upload, Kind::Replace, Kind::Delete];
    for kind in order {
        for a in actions.iter().filter(|a| a.kind == kind) {
            let label = a.rel.join("/");
            emit(app, target.id, done, total, &label);
            done += 1;
            if matches!(kind, Kind::Delete | Kind::Replace) && !backed_up.contains(&a.id) {
                continue; // already reported above
            }
            match run_action(&backend, &base, a, &mut made).await {
                Ok(()) => record_done(&mut out, a),
                Err(e) => out.summary.fail(format!("{label}: {e}")),
            }
        }
    }
    emit(app, target.id, total, total, "");
    out
}

fn record_done(out: &mut Applied, a: &Action) {
    let size = i64::try_from(a.size).unwrap_or(i64::MAX);
    match a.kind {
        Kind::Upload | Kind::Replace => {
            out.summary.uploaded += 1;
            if let Some(id) = a.track_id {
                out.present.push((id, size));
            }
        }
        Kind::Move => {
            out.summary.moved += 1;
            if let Some(id) = a.track_id {
                out.present.push((id, size));
            }
        }
        Kind::Delete => {
            out.summary.deleted += 1;
            if let Some(id) = a.track_id {
                out.removed.push(id);
            }
        }
    }
}

async fn run_action(
    backend: &Backend<'_>,
    base: &[String],
    a: &Action,
    made: &mut HashSet<Vec<String>>,
) -> Result<(), Error> {
    if !safe_rel(&a.rel) || a.from.as_deref().is_some_and(|f| !safe_rel(f)) {
        return Err(Error::Msg("unsafe path".to_owned()));
    }
    let dest = dest_of(base, &a.rel);
    match a.kind {
        Kind::Upload | Kind::Replace => {
            let local = a
                .local
                .as_deref()
                .ok_or_else(|| Error::Msg("no local file".to_owned()))?;
            let current = backend.remote_size(&dest).await?;
            // The destination must still look as it did when it was reviewed.
            if a.kind == Kind::Upload && current.is_some() && current != Some(a.size) {
                return Err(Error::Msg(
                    "appeared on the destination since review".to_owned(),
                ));
            }
            if a.kind == Kind::Replace && current != a.remote_size {
                return Err(Error::Msg(
                    "changed on the destination since review".to_owned(),
                ));
            }
            ensure_dirs(backend, base, &dest, made).await?;
            backend.put(&dest, local).await
        }
        Kind::Move => {
            let from = dest_of(base, a.from.as_deref().unwrap_or_default());
            if backend.remote_size(&from).await? != Some(a.size) {
                return Err(Error::Msg("source changed since review".to_owned()));
            }
            if backend.remote_size(&dest).await?.is_some() {
                return Err(Error::Msg("destination path already exists".to_owned()));
            }
            ensure_dirs(backend, base, &dest, made).await?;
            backend.rename(&from, &dest).await
        }
        Kind::Delete => match backend.remote_size(&dest).await? {
            None => Ok(()),
            Some(size) if size == a.size => backend.delete(&dest).await,
            Some(_) => Err(Error::Msg(
                "changed on the destination since review".to_owned(),
            )),
        },
    }
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

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    fn rel(p: &str) -> Vec<String> {
        p.split('/').map(str::to_owned).collect()
    }

    fn item(id: i64, p: &str, size: u64, fp: Option<&str>) -> Item {
        Item {
            track_id: id,
            local: PathBuf::from(p),
            rel: rel(p),
            size,
            fingerprint: fp.map(str::to_owned),
            modified: 0,
        }
    }

    fn remote(p: &str, size: u64) -> Remote {
        Remote { rel: rel(p), size }
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
        assert_eq!(m.deletes[0].1.as_deref(), Some("Same audio as a.wav"));
    }

    #[test]
    fn unreadable_audio_is_flagged_and_other_files_are_plain_deletes() {
        let items = [item(1, "a.wav", 10, Some("fp"))];
        let audio = remote("x.mp3", 10);
        let art = remote("cover.jpg", 10);
        let m = pair(&items, &[], &[(&audio, None), (&art, None)]);
        assert_eq!(
            m.deletes[0].1.as_deref(),
            Some("Audio could not be compared")
        );
        assert_eq!(m.deletes[1].1, None);
    }

    #[test]
    fn edges_are_the_first_and_last_bytes() {
        let path = std::env::temp_dir().join(format!("manplay-edges-{}.bin", std::process::id()));
        let data: Vec<u8> = (0..=9).collect();
        std::fs::write(&path, &data).expect("write");
        let (head, tail) = read_edges(&path, 10, 3).expect("edges");
        assert_eq!(head, vec![0, 1, 2]);
        assert_eq!(tail, vec![7, 8, 9]);
        let _ = std::fs::remove_file(&path);
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
}
