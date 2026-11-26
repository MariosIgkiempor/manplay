#![allow(clippy::needless_pass_by_value)] // Tauri command args are taken by value

mod analysis;
mod anlz;
mod apple_art;
mod art;
mod audioprint;
mod audit;
mod convert;
mod db;
mod duplicate_trash;
mod error;
mod file_picker;
mod fsops;
mod gemini;
mod import;
mod jellyfin;
mod libsync;
#[cfg(test)]
mod libsync_worker_tests;
mod lookup;
mod onelib;
mod pdb;
mod playback;
mod playlist_folders;
mod process;
mod r2;
mod rekordbox;
mod scan;
mod serato;
mod smart;
mod stream;
mod sync;
mod sync_ignore;
mod sync_scans;
mod tag_region;
mod tags;
mod tailscale;
mod usb;
mod usb_browse;
mod usb_edit;
mod usb_export;
mod usb_files;
mod virtualdj;
mod webdav;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{NewTarget, Playlist, RunView, SyncTarget, Tag, Track};
use crate::error::Error;
use crate::sync_scans::ReadDepth;

struct AppState {
    db: Mutex<Connection>,
    data_dir: PathBuf,
    http: reqwest::Client,
    /// For background reads: gives up on a destination that stops answering, so a stalled read
    /// cannot hold the destinations forever.
    scan_http: reqwest::Client,
    syncing: AtomicBool,
    fixing: AtomicBool,
    analyzing: AtomicBool,
    /// Held while songs are being copied onto a USB drive.
    usb_exporting: AtomicBool,
    /// Set to stop the running analysis after the files in progress.
    cancel_analysis: AtomicBool,
    /// The tag lookup in progress, if any, and the pacing of its requests.
    lookup: lookup::Session,
    /// The background reads of the destinations and the plans they made, awaiting review.
    scans: Mutex<sync_scans::ScanStore>,
    /// Wakes the background reader when something was queued.
    scan_wake: tokio::sync::Notify,
    /// Wakes the background analysis when songs may have come into the library.
    analysis_wake: tokio::sync::Notify,
    /// Wakes the automatic import when an import folder was added or changed.
    import_wake: tokio::sync::Notify,
    /// Held while a destination is read or written, so they are handled one job at a time.
    destination_io: tokio::sync::Mutex<()>,
    /// Next id for a planned action, unique across every plan of this run of the app.
    next_action_id: AtomicU32,
    /// When the library last changed on disk, until the destinations are checked against it.
    library_changed: Mutex<Option<std::time::Instant>>,
    /// Waveforms the sharing destination did not have since the last sync.
    wf_misses: libsync::waveforms::Misses,
    /// Held while waveforms are being downloaded in the background.
    wf_filling: AtomicBool,
    /// A sync asked for a waveform transfer while one was running: run again when it ends.
    wf_again: AtomicBool,
    /// The last Jellyfin push shown for review, per destination; Send carries out exactly this.
    jellyfin_plans: Mutex<HashMap<i64, Vec<jellyfin::push::Planned>>>,
    /// Held while playlists are sent to a Jellyfin server, so two pushes never interleave.
    jellyfin_pushing: tokio::sync::Mutex<()>,
    /// Held while the shared library is synced, by a sync the user started or by the one that
    /// runs on its own, so the two never overlap.
    libsync_io: tokio::sync::Mutex<()>,
    /// Wakes the shared library's own sync before its next look.
    libsync_wake: tokio::sync::Notify,
    /// The user asked for the shared library to sync now.
    libsync_asked: AtomicBool,
    /// The window came back to the front: a good moment to sync, when syncing on its own is on.
    libsync_focused: AtomicBool,
    /// How the shared library's last sync went, for the settings.
    libsync_last: Mutex<Option<LastLibrarySync>>,
}

/// When the app started, for [`launch_mark`].
static LAUNCHED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// With `MANPLAY_TIMING` set, prints how long after the app started a step of the launch was
/// reached, to find what a slow start is waiting on. Says nothing otherwise.
fn launch_mark(step: &str) {
    let since = LAUNCHED.get_or_init(std::time::Instant::now).elapsed();
    if std::env::var_os("MANPLAY_TIMING").is_some() {
        eprintln!("launch {:>7.0} ms  {step}", since.as_secs_f64() * 1000.0);
    }
}

const SETTING_ROOT: &str = "library_root";
/// How long a track must stay missing before its record and remote copies are removed.
const GRACE_SECS: i64 = 7 * 24 * 60 * 60;
const GRACE_DAYS: i64 = 7;
const BACKUPS_KEEP: usize = 5;
/// How long copies of files removed from destinations are kept.
const SYNC_BACKUP_KEEP_SECS: i64 = 30 * 24 * 60 * 60;

/// How much of the library a scan reads.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ScanDepth {
    /// Only the files that are new, or whose size or modification time changed since they were
    /// last read. What every scan the app starts on its own does.
    Changed,
    /// Every file, whatever is remembered of it: for a rescan someone asked for, in case a file
    /// was rewritten without its size or time changing.
    Everything,
}

/// Scans `root` off the UI thread, stores the results, and remembers `root` as the library folder.
async fn scan_and_store(state: &AppState, root: PathBuf, depth: ScanDepth) -> Result<usize, Error> {
    let known = match depth {
        ScanDepth::Changed => {
            let conn = state.db.lock().map_err(|_| Error::Lock)?;
            db::scanned_tracks(&conn)?
        }
        ScanDepth::Everything => HashMap::new(),
    };
    let scan_root = root.clone();
    let result = tauri::async_runtime::spawn_blocking(move || scan::scan(&scan_root, known))
        .await
        .map_err(|e| Error::Msg(e.to_string()))?;
    let mut conn = state.db.lock().map_err(|_| Error::Lock)?;
    detect_moves(&mut conn, &state.data_dir, &root, &result)?;
    db::upsert(&mut conn, &result.tracks)?;
    db::rekey_legacy(&mut conn)?;
    // Shared tags and playlists that were waiting for these songs.
    libsync::apply::materialize_pending(&mut conn)?;
    db::replace_tag_values(&mut conn, &result.values)?;
    if db::get_setting(&conn, SETTING_ROOT)?.as_deref() != root.to_str() {
        // The old folder's shared library stays there; this device keeps a copy of it.
        let tx = conn.transaction()?;
        libsync::membership::detach_folder(&tx)?;
        tx.commit()?;
    }
    db::set_setting(&conn, SETTING_ROOT, root.to_str())?;
    reconcile_missing(&mut conn, &state.data_dir, &result)?;
    drop(conn);
    library_changed(state);
    Ok(result.tracks.len())
}

/// Has the destinations checked against the library once it has stopped changing for
/// [`sync_scans::LIBRARY_SETTLE`], e.g. after a batch of tag edits.
fn library_changed(state: &AppState) {
    if let Ok(mut changed) = state.library_changed.lock() {
        *changed = Some(std::time::Instant::now());
    }
    state.scan_wake.notify_one();
    state.analysis_wake.notify_one();
}

/// Fingerprints the audio of present tracks that have no `audio_fp` yet (libraries from before
/// scans did it) and re-keys the old fingerprint-keyed analysis and cues onto them. Scans do
/// this for every file they read, so this only matters until the first scan after an update.
async fn fill_audio_fps(app: AppHandle) {
    let state = app.state::<AppState>();
    let todo = match state.db.lock().map_err(|_| Error::Lock) {
        Ok(conn) => db::tracks_without_audio_fp(&conn),
        Err(e) => Err(e),
    };
    let Ok(todo) = todo else { return };
    let printed = tauri::async_runtime::spawn_blocking(move || {
        todo.into_iter()
            .map(|(id, path)| {
                let fp = audioprint::audio_print_path(Path::new(&path)).unwrap_or_default();
                (id, fp)
            })
            .collect::<Vec<_>>()
    })
    .await;
    let Ok(printed) = printed else { return };
    let Ok(mut conn) = state.db.lock() else {
        return;
    };
    let stored = db::set_audio_fps(&mut conn, &printed)
        .and_then(|()| db::rekey_legacy(&mut conn))
        .and_then(|()| libsync::apply::materialize_pending(&mut conn).map(|_| ()))
        .and_then(|()| record_files(&conn, unix_now() - GRACE_SECS));
    if let Err(e) = stored {
        log::warn!("could not fingerprint the library's audio: {e}");
    }
}

/// After an update that changed the audio fingerprint algorithm (`audioprint::VERSION`): prints
/// every present song again, moves its analysis, cues and shared edits from the old print to the
/// new one (`libsync::remap`), and only then records the new version. A song that cannot be read
/// holds the whole move back until the next start, so a half-moved library never syncs.
async fn reprint_audio_fps(app: AppHandle) {
    let want = i64::from(audioprint::VERSION);
    let state = app.state::<AppState>();
    let todo = match state.db.lock().map_err(|_| Error::Lock) {
        Ok(conn) => match libsync::remap::local_version(&conn) {
            Ok(have) if have >= want => return,
            Ok(_) => db::tracks_with_audio_fp(&conn),
            Err(e) => Err(e),
        },
        Err(e) => Err(e),
    };
    let Ok(todo) = todo else { return };
    let printed = tauri::async_runtime::spawn_blocking(move || {
        todo.into_iter()
            .map(|(id, path, old)| {
                let fp = audioprint::audio_print_path(Path::new(&path)).unwrap_or_default();
                (id, old, fp)
            })
            .collect::<Vec<_>>()
    })
    .await;
    let Ok(printed) = printed else { return };
    if printed.iter().any(|(_, _, fp)| fp.is_empty()) {
        log::warn!("some songs could not be fingerprinted again; trying at the next start");
        return;
    }
    let Ok(mut conn) = state.db.lock() else {
        return;
    };
    let pairs: Vec<(String, String)> = printed
        .iter()
        .map(|(_, old, new)| (old.clone(), new.clone()))
        .collect();
    let stored = db::set_audio_fps(
        &mut conn,
        &printed
            .iter()
            .map(|(id, _, fp)| (*id, fp.clone()))
            .collect::<Vec<_>>(),
    )
    .and_then(|()| libsync::remap::remap_tracks(&mut conn, &pairs, want));
    if let Err(e) = stored {
        log::warn!("could not move the library to the new audio fingerprint: {e}");
    }
}

/// Path relative to the library root, as it appears on sync destinations.
fn rel_path(root: &Path, path: &str) -> Option<Vec<String>> {
    Path::new(path)
        .strip_prefix(root)
        .ok()?
        .iter()
        .map(|s| s.to_str().map(str::to_owned))
        .collect()
}

/// Recognises renamed or moved files: a file at a brand-new path whose fingerprint matches
/// exactly one known track that is no longer at its old path is that track, moved. The track
/// row is updated in place, so tags, playlists and its id survive. Ambiguous matches and
/// copies (the old path still exists) are treated as new tracks.
///
/// Returns the number of moves applied. Safe on untrusted scans: it only acts on a positive
/// fingerprint match, never on absence.
fn detect_moves(
    conn: &mut Connection,
    data_dir: &Path,
    root: &Path,
    scan: &scan::ScanResult,
) -> Result<usize, Error> {
    let known = db::all_known(conn)?;
    let known_paths: HashSet<&str> = known.iter().map(|k| k.path.as_str()).collect();
    let found: HashSet<&str> = scan.tracks.iter().map(|t| t.path.as_str()).collect();

    // fingerprint -> tracks that have vanished from disk
    let mut vanished: HashMap<&str, Vec<&db::Known>> = HashMap::new();
    for k in &known {
        if let Some(fp) = k
            .fingerprint
            .as_deref()
            .filter(|_| !found.contains(k.path.as_str()))
        {
            vanished.entry(fp).or_default().push(k);
        }
    }

    let mut moves: Vec<(&db::Known, &db::NewTrack)> = Vec::new();
    for t in &scan.tracks {
        let Some(fp) = t.fingerprint.as_deref() else {
            continue;
        };
        if known_paths.contains(t.path.as_str()) {
            continue;
        }
        // Take the candidate so a second identical new file cannot claim the same track.
        if let Some(list) = vanished.get_mut(fp).filter(|l| l.len() == 1)
            && let Some(old) = list.pop()
        {
            moves.push((old, t));
        }
    }
    let by_audio = audio_moves(&known, &found, &known_paths, scan, &moves);
    moves.extend(by_audio);
    if moves.is_empty() {
        return Ok(0);
    }

    db::backup(conn, &data_dir.join("backups"), unix_now(), BACKUPS_KEEP)?;
    for (old, new) in &moves {
        let old_rel = rel_path(root, &old.path);
        db::apply_move(conn, old.id, new, old_rel.as_deref())?;
    }
    Ok(moves.len())
}

/// Moves the whole-file fingerprint missed because the file also changed: retagged and moved
/// together (Fix issues, or another tagger). Matched by the audio's own fingerprint, and only
/// when exactly one vanished track and exactly one new file share it, so two copies of a song
/// are never merged.
fn audio_moves<'k, 's>(
    known: &'k [db::Known],
    found: &HashSet<&str>,
    known_paths: &HashSet<&str>,
    scan: &'s scan::ScanResult,
    already: &[(&db::Known, &db::NewTrack)],
) -> Vec<(&'k db::Known, &'s db::NewTrack)> {
    let claimed_old: HashSet<i64> = already.iter().map(|(old, _)| old.id).collect();
    let claimed_new: HashSet<&str> = already.iter().map(|(_, new)| new.path.as_str()).collect();
    let audio_of = |fp: Option<&'k str>| fp.filter(|fp| !fp.is_empty());

    let mut vanished: HashMap<&str, Vec<&db::Known>> = HashMap::new();
    for k in known
        .iter()
        .filter(|k| !found.contains(k.path.as_str()) && !claimed_old.contains(&k.id))
    {
        if let Some(fp) = audio_of(k.audio_fp.as_deref()) {
            vanished.entry(fp).or_default().push(k);
        }
    }
    let mut arrived: HashMap<&str, Vec<&db::NewTrack>> = HashMap::new();
    for t in scan.tracks.iter().filter(|t| {
        !known_paths.contains(t.path.as_str()) && !claimed_new.contains(t.path.as_str())
    }) {
        if let Some(fp) = t.audio_fp.as_deref().filter(|fp| !fp.is_empty()) {
            arrived.entry(fp).or_default().push(t);
        }
    }
    arrived
        .into_iter()
        .filter_map(
            |(fp, new)| match (vanished.get(fp)?.as_slice(), new.as_slice()) {
                ([old], [new]) => Some((*old, *new)),
                _ => None,
            },
        )
        .collect()
}

/// Soft-deletes tracks the scan could not find, then purges ones that have been gone
/// past the grace period. The database is backed up before either step changes anything.
/// Songs outside the scanned library folder (left from a folder used before) count as not found:
/// they are no longer part of the library, and choosing that folder again brings them back.
fn reconcile_missing(
    conn: &mut Connection,
    data_dir: &Path,
    scan: &scan::ScanResult,
) -> Result<(), Error> {
    let now = unix_now();
    let backups = data_dir.join("backups");

    // Only a clean, non-empty scan may declare files missing. A scan with read errors, or an
    // empty one (unmounted drive, revoked permission), says nothing reliable about what is gone.
    if scan.errors == 0 && !scan.tracks.is_empty() {
        let found: HashSet<&str> = scan.tracks.iter().map(|t| t.path.as_str()).collect();
        let gone: Vec<i64> = db::present_tracks(conn)?
            .into_iter()
            .filter(|(_, p)| !found.contains(p.as_str()))
            .map(|(id, _)| id)
            .collect();
        if !gone.is_empty() {
            db::backup(conn, &backups, now, BACKUPS_KEEP)?;
            db::mark_missing(conn, &gone, now)?;
        }
    }

    purge_expired(conn, &backups, now)
}

/// Removes missing tracks past the grace period that have no remote copies left. The shared
/// library hears first where the songs are and which are gone for good, while their records
/// still say so.
fn purge_expired(conn: &Connection, backups: &Path, now: i64) -> Result<(), Error> {
    let cutoff = now - GRACE_SECS;
    record_files(conn, cutoff)?;
    if db::purgeable_count(conn, cutoff)? > 0 {
        db::backup(conn, backups, now, BACKUPS_KEEP)?;
        db::purge_expired(conn, cutoff)?;
    }
    Ok(())
}

/// Writes where the library's songs are to the shared library (`libsync::files`).
fn record_files(conn: &Connection, expired_before: i64) -> Result<(), Error> {
    if let Some(root) = db::get_setting(conn, SETTING_ROOT)? {
        libsync::files::record(conn, Path::new(&root), expired_before)?;
    }
    Ok(())
}

/// Moves the library's files to where other devices moved or renamed them, then reads the
/// library again so the songs are found at their new places. A file never replaces another: a
/// song whose new place is taken stays where it is. Returns how many moved.
async fn follow_file_moves(state: &AppState) -> Result<usize, Error> {
    let Ok(root) = library_root(state) else {
        return Ok(0);
    };
    let wanted = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        record_files(&conn, unix_now() - GRACE_SECS)?;
        libsync::files::moves_wanted(&conn)?
    };
    if wanted.is_empty() {
        return Ok(0);
    }
    let folder = root.clone();
    let moved = tauri::async_runtime::spawn_blocking(move || {
        wanted
            .iter()
            .filter(|wanted| match wanted.carry_out(&folder) {
                Ok(()) => true,
                Err(why) => {
                    log::info!("a song another device moved stays where it is: {why:?}");
                    false
                }
            })
            .count()
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?;
    if moved > 0 {
        scan_and_store(state, root, ScanDepth::Changed).await?;
    }
    Ok(moved)
}

/// [`follow_file_moves`] after a sync of the shared library; a problem is only logged, the sync
/// itself went through.
async fn follow_shared_files(state: &AppState) {
    if let Err(e) = follow_file_moves(state).await {
        log::warn!("could not move songs to where other devices put them: {e}");
    }
}

/// The songs another device removed from the shared library that this library still has.
#[tauri::command]
fn list_file_removals(state: State<'_, AppState>) -> Result<Vec<libsync::files::Removal>, Error> {
    let Ok(root) = library_root(&state) else {
        return Ok(Vec::new());
    };
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    libsync::files::removals_waiting(&conn, &root)
}

/// Keeps songs another device removed: every device has them again after its next sync.
#[tauri::command]
fn keep_file_removals(state: State<'_, AppState>, audio_fps: Vec<String>) -> Result<usize, Error> {
    let root = library_root(&state)?;
    let kept = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        libsync::files::keep(&conn, &root, &audio_fps)?
    };
    state.libsync_wake.notify_one();
    Ok(kept)
}

/// Removes songs here that another device removed: every copy of them goes to the system Trash.
/// Only songs that are waiting for this are touched, whatever was asked for.
#[tauri::command]
async fn apply_file_removals(
    state: State<'_, AppState>,
    audio_fps: Vec<String>,
) -> Result<usize, Error> {
    let root = library_root(&state)?;
    let copies = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        let waiting: Vec<String> = libsync::files::removals_waiting(&conn, &root)?
            .into_iter()
            .map(|removal| removal.audio_fp)
            .filter(|fp| audio_fps.contains(fp))
            .collect();
        libsync::files::copies_here(&conn, &waiting)?
    };
    if copies.is_empty() {
        return Ok(0);
    }
    let folder = root.clone();
    let files: Vec<PathBuf> = copies.iter().map(|(_, path)| path.clone()).collect();
    tauri::async_runtime::spawn_blocking(move || fsops::trash(&folder, &files))
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;
    let gone: Vec<i64> = copies
        .into_iter()
        .filter(|(_, path)| !path.exists())
        .map(|(id, _)| id)
        .collect();
    {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        libsync::files::deleted_here(&conn, &root, &gone, unix_now())?;
    }
    refresh_after_fs_change(&state, root).await;
    Ok(gone.len())
}

/// The present songs at or below `paths`, as `(id, path)`.
fn tracks_below(conn: &Connection, paths: &[PathBuf]) -> Result<Vec<(i64, PathBuf)>, Error> {
    Ok(db::present_tracks(conn)?
        .into_iter()
        .map(|(id, path)| (id, PathBuf::from(path)))
        .filter(|(_, path)| paths.iter().any(|p| path.starts_with(p)))
        .collect())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryStatus {
    missing: i64,
    grace_days: i64,
}

#[tauri::command]
fn library_status(state: State<'_, AppState>) -> Result<LibraryStatus, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    Ok(LibraryStatus {
        missing: db::missing_count(&conn)?,
        grace_days: GRACE_DAYS,
    })
}

/// Groups of present songs stored more than once (see `db::duplicate_groups`).
#[tauri::command]
async fn list_duplicates(state: State<'_, AppState>) -> Result<Vec<db::DuplicateGroup>, Error> {
    let mut groups = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::duplicate_groups(&conn)?
    };
    // Reading the files' tags happens off the lock and off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        for track in groups.iter_mut().flat_map(|g| g.tracks.iter_mut()) {
            track.embedded_cues = duplicate_trash::embedded_cues(Path::new(&track.path));
        }
        groups
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))
}

/// Moves the extra copies of duplicated songs to the Trash. Each copy is compared byte for byte
/// with the copy being kept first, unless both were converted from the same source file; one
/// that differs, or whose kept copy is gone, stays put.
#[tauri::command]
async fn trash_duplicates(
    state: State<'_, AppState>,
    groups: Vec<duplicate_trash::TrashGroup>,
) -> Result<duplicate_trash::TrashReport, Error> {
    let root = library_root(&state)?;
    let converted = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::converted_from(&conn)?
    };
    let r = root.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let converted_from: duplicate_trash::ConvertedFrom = converted
            .into_iter()
            .map(|(dest, source)| {
                let dest = PathBuf::from(dest);
                (dest.canonicalize().unwrap_or(dest), source)
            })
            .collect();
        duplicate_trash::trash_copies(&r, &groups, &converted_from)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))??;
    refresh_after_fs_change(&state, root).await;
    Ok(report)
}

/// Songs re-encoded under the same name whose old audio has tags or playlists to carry over.
#[tauri::command]
fn list_carry_candidates(
    state: State<'_, AppState>,
) -> Result<Vec<libsync::carry::Candidate>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    libsync::carry::candidates(&conn)
}

/// Moves tags, playlist places and hand-set tempo of the old audio to the song `track_id`.
#[tauri::command]
fn carry_over(
    state: State<'_, AppState>,
    old_fp: String,
    track_id: i64,
) -> Result<libsync::carry::Carried, Error> {
    let mut conn = state.db.lock().map_err(|_| Error::Lock)?;
    libsync::carry::carry_over(&mut conn, &old_fp, track_id)
}

/// Leaves the old audio's tags and playlists where they are.
#[tauri::command]
fn dismiss_carry(state: State<'_, AppState>, old_fp: String) -> Result<(), Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    libsync::carry::dismiss(&conn, &old_fp)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MissingTrackView {
    id: i64,
    path: String,
    title: String,
    artist: String,
    album: String,
    /// Unix seconds when the track is removed for good (already past once "Remove now" was used).
    removed_at: i64,
}

/// The tracks whose files are gone, with when each will be removed.
#[tauri::command]
fn list_missing(state: State<'_, AppState>) -> Result<Vec<MissingTrackView>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    Ok(db::missing_tracks(&conn)?
        .into_iter()
        .map(|t| MissingTrackView {
            id: t.id,
            path: t.path,
            title: t.title,
            artist: t.artist,
            album: t.album,
            removed_at: t.missing_since + GRACE_SECS,
        })
        .collect())
}

/// Ends the grace period for all missing tracks. Never-synced ones are purged immediately;
/// the rest go once the next sync has removed their remote copies.
#[tauri::command]
fn remove_missing_now(state: State<'_, AppState>) -> Result<(), Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::backup(
        &conn,
        &state.data_dir.join("backups"),
        unix_now(),
        BACKUPS_KEEP,
    )?;
    db::expire_missing_now(&conn)?;
    purge_expired(&conn, &state.data_dir.join("backups"), unix_now())
}

/// Scans a newly chosen folder and makes it the library folder.
#[tauri::command]
async fn scan_library(
    app: AppHandle,
    state: State<'_, AppState>,
    root: PathBuf,
) -> Result<usize, Error> {
    allow_assets(&app, &root);
    scan_and_store(&state, root, ScanDepth::Changed).await
}

/// Lets the player load files from `dir` through the asset protocol. The static scope in
/// `tauri.conf.json` covers the home folder and `/Volumes` on macOS; a library or drive elsewhere
/// (another drive letter on Windows) is added here.
fn allow_assets(app: &AppHandle, dir: &Path) {
    if let Err(e) = app.asset_protocol_scope().allow_directory(dir, true) {
        log::warn!("allowing {} for playback: {e}", dir.display());
    }
}

#[tauri::command]
fn get_library_root(state: State<'_, AppState>) -> Result<Option<String>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::get_setting(&conn, SETTING_ROOT)
}

/// Rescans the remembered library folder. `None` when no folder was ever chosen. With `full`
/// every file is read again; without it only new and changed ones are (see [`ScanDepth`]).
#[tauri::command]
async fn rescan_library(
    state: State<'_, AppState>,
    full: Option<bool>,
) -> Result<Option<usize>, Error> {
    let saved = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::get_setting(&conn, SETTING_ROOT)?
    };
    let Some(root) = saved else {
        return Ok(None);
    };
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err(Error::Msg(format!(
            "library folder not found or not readable: {}",
            root.display()
        )));
    }
    let depth = if full == Some(true) {
        ScanDepth::Everything
    } else {
        ScanDepth::Changed
    };
    let found = scan_and_store(&state, root, depth).await.map(Some);
    launch_mark("a library scan finished");
    found
}

/// Wipes the track table and rebuilds it from the library folder. A backup is taken first.
/// Playlist and tag memberships and sync records go with the tracks (foreign-key cascade);
/// settings, destinations and the playlists/tags themselves stay.
#[tauri::command]
async fn reset_library(state: State<'_, AppState>) -> Result<Option<usize>, Error> {
    if state.syncing.load(Ordering::SeqCst) {
        return Err(Error::Msg(
            "a sync is running; try again when it finishes".to_owned(),
        ));
    }
    {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::backup(
            &conn,
            &state.data_dir.join("backups"),
            unix_now(),
            BACKUPS_KEEP,
        )?;
        db::clear_tracks(&conn)?;
    }
    rescan_library(state, None).await
}

#[tauri::command]
fn list_tracks(state: State<'_, AppState>) -> Result<Vec<Track>, Error> {
    static FIRST: std::sync::Once = std::sync::Once::new();
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    let tracks = db::list(&conn);
    FIRST.call_once(|| launch_mark("the song list reached the page"));
    tracks
}

#[derive(serde::Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct AnalysisProgress {
    /// `analyzing` while detecting, `saving` while writing results into file tags.
    phase: &'static str,
    done: usize,
    total: usize,
}

const SETTING_ANALYSIS: &str = "analysis";

/// How analysis results are written. Detected BPM and key always go into the files' tags too,
/// so other apps and players see them; settings saved before that (`writeTags`) are ignored.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct AnalysisSettings {
    /// Key notation in the tags: `musical` (`Am`) or `camelot` (`8A`).
    key_format: KeyFormat,
    /// Re-analysing replaces BPM, key and beat grids set by hand. Off: they are kept.
    replace_edits: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum KeyFormat {
    #[default]
    Musical,
    Camelot,
}

fn analysis_settings_of(conn: &Connection) -> Result<AnalysisSettings, Error> {
    Ok(db::get_setting(conn, SETTING_ANALYSIS)?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default())
}

#[tauri::command]
fn analysis_settings(state: State<'_, AppState>) -> Result<AnalysisSettings, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    analysis_settings_of(&conn)
}

#[tauri::command]
fn set_analysis_settings(
    state: State<'_, AppState>,
    settings: AnalysisSettings,
) -> Result<(), Error> {
    let raw = serde_json::to_string(&settings).map_err(|e| Error::Msg(e.to_string()))?;
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::set_setting(&conn, SETTING_ANALYSIS, Some(&raw))
}

/// Songs whose analysis failed, and why.
#[tauri::command]
fn analysis_failures(state: State<'_, AppState>) -> Result<Vec<audit::FixFailure>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::analysis_failures(&conn)
}

/// Tag edits that store a detection result: BPM as a whole number (what ID3 allows and DJ
/// players read), key in the chosen notation.
fn analysis_edits(
    result: &db::AnalysisResult,
    format: KeyFormat,
) -> std::collections::BTreeMap<String, String> {
    let mut edits = std::collections::BTreeMap::new();
    if let Some(bpm) = result.bpm {
        #[allow(clippy::cast_possible_truncation)]
        edits.insert("bpm".to_owned(), (bpm.round() as i64).to_string());
    }
    if let Some(key) = &result.key {
        let text = match format {
            KeyFormat::Musical => Some(key.clone()),
            KeyFormat::Camelot => analysis::camelot(key),
        };
        if let Some(text) = text {
            edits.insert("key".to_owned(), text);
        }
    }
    edits
}

#[derive(serde::Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct TagWriteReport {
    written: usize,
    /// Files whose tags already held these values.
    unchanged: usize,
    failed: Vec<audit::FixFailure>,
}

/// Writes detection results into the files' BPM and key tags, skipping files that already
/// hold them. Each file is rewritten beside itself and checked before it replaces the original.
fn write_analysis_tags(
    root: &Path,
    results: &[db::AnalysisResult],
    format: KeyFormat,
    report: &dyn Fn(AnalysisProgress),
) -> TagWriteReport {
    let mut out = TagWriteReport::default();
    let total = results.len();
    for (i, result) in results.iter().enumerate() {
        report(AnalysisProgress {
            phase: "saving",
            done: i,
            total,
        });
        let edits = analysis_edits(result, format);
        let paths = [PathBuf::from(&result.path)];
        let outcome = tags::preview(root, &paths, &edits).and_then(|p| {
            if p.files.is_empty() {
                Ok(None)
            } else {
                tags::write(root, &paths, &edits).map(Some)
            }
        });
        match outcome {
            Ok(None) => out.unchanged += 1,
            Ok(Some(r)) => {
                out.written += r.fixed;
                out.failed.extend(r.failed);
            }
            Err(e) => out.failed.push(audit::FixFailure {
                path: result.path.clone(),
                error: e.to_string(),
            }),
        }
    }
    report(AnalysisProgress {
        phase: "saving",
        done: total,
        total,
    });
    out
}

/// Writes saved results for `track_ids` (every analyzed track when `None`) into file tags.
async fn save_analysis_tags(
    app: &AppHandle,
    state: &AppState,
    track_ids: Option<&[i64]>,
) -> Result<TagWriteReport, Error> {
    let root = library_root(state)?;
    let (results, settings) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        (
            db::analysis_results(&conn, track_ids)?,
            analysis_settings_of(&conn)?,
        )
    };
    if results.is_empty() {
        return Ok(TagWriteReport::default());
    }
    if state.fixing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg(
            "another metadata change is running; try again when it finishes".to_owned(),
        ));
    }
    let _guard = SyncGuard(&state.fixing);
    let handle = app.clone();
    let r = root.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let report = |p: AnalysisProgress| {
            let _ = handle.emit("analysis-progress", p);
        };
        write_analysis_tags(&r, &results, settings.key_format, &report)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?;
    if out.written > 0 {
        refresh_after_fs_change(state, root).await;
    }
    Ok(out)
}

/// Sets one song's BPM and/or key by hand (`""` clears): stored over the detected value and
/// written into the file's tags, BPM as a whole number and the key in the chosen notation.
#[tauri::command]
async fn set_tempo_key(
    state: State<'_, AppState>,
    track_id: i64,
    bpm: Option<String>,
    key: Option<String>,
) -> Result<audit::FixReport, Error> {
    let root = library_root(&state)?;
    let bpm = bpm
        .map(|b| {
            let t = b.trim().replace(',', ".");
            if t.is_empty() {
                return Ok(None);
            }
            t.parse::<f64>()
                .ok()
                .filter(|n| n.is_finite() && (1.0..1000.0).contains(n))
                .map(Some)
                .ok_or_else(|| Error::Msg(format!("not a tempo: {b}")))
        })
        .transpose()?;
    let key = key
        .map(|k| {
            if k.trim().is_empty() {
                return Ok(None);
            }
            analysis::normalize_key(&k)
                .map(Some)
                .ok_or_else(|| Error::Msg(format!("not a key: {k}")))
        })
        .transpose()?;
    let (path, format) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        let path = db::track_path(&conn, track_id)?
            .ok_or_else(|| Error::Msg("song not found".to_owned()))?;
        db::set_tempo_key(&conn, track_id, bpm, key.as_ref().map(Option::as_deref))?;
        (path, analysis_settings_of(&conn)?.key_format)
    };
    let mut edits = std::collections::BTreeMap::new();
    if let Some(bpm) = bpm {
        #[allow(clippy::cast_possible_truncation)]
        edits.insert(
            "bpm".to_owned(),
            bpm.map_or_else(String::new, |b| (b.round() as i64).to_string()),
        );
    }
    if let Some(key) = &key {
        let text = key.as_ref().and_then(|k| match format {
            KeyFormat::Musical => Some(k.clone()),
            KeyFormat::Camelot => analysis::camelot(k),
        });
        edits.insert("key".to_owned(), text.unwrap_or_default());
    }
    if state.fixing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a fix is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.fixing);
    let r = root.clone();
    let paths = [PathBuf::from(path)];
    let report = tauri::async_runtime::spawn_blocking(move || tags::write(&r, &paths, &edits))
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;
    refresh_after_fs_change(&state, root).await;
    Ok(report)
}

/// Writes every saved analysis result into the files' tags now.
#[tauri::command]
async fn save_analysis_to_files(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TagWriteReport, Error> {
    if state.analyzing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("an analysis is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.analyzing);
    save_analysis_tags(&app, &state, None).await
}

#[derive(serde::Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct AnalysisReport {
    analyzed: usize,
    failed: usize,
    /// Files left unanalysed because the run was cancelled.
    cancelled: usize,
    /// Set when the results were also written into file tags.
    tags: Option<TagWriteReport>,
}

/// Detects BPM and key for `jobs` on several threads, storing each result as it arrives.
fn run_analysis(
    state: &AppState,
    jobs: &[db::AnalysisJob],
    replace_edits: bool,
    report: &(dyn Fn(AnalysisProgress) + Sync),
) -> Result<AnalysisReport, Error> {
    use std::sync::atomic::AtomicUsize;
    let total = jobs.len();
    let workers = std::thread::available_parallelism()
        .map_or(2, std::num::NonZero::get)
        .saturating_sub(1)
        .clamp(1, 8)
        .min(total.max(1));
    let next = AtomicUsize::new(0);
    let (tx, rx) = std::sync::mpsc::channel();
    let mut out = AnalysisReport::default();
    std::thread::scope(|scope| -> Result<(), Error> {
        for _ in 0..workers {
            let tx = tx.clone();
            let next = &next;
            scope.spawn(move || {
                while !state.cancel_analysis.load(Ordering::SeqCst) {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    let Some(job) = jobs.get(i) else { break };
                    let path = Path::new(&job.path);
                    // A file that cannot be opened (no permission, unplugged drive) says nothing
                    // about its audio, so it is not remembered as failed and is tried next time.
                    let readable = std::fs::File::open(path).is_ok();
                    // The full analysis (beat grid and waveform too) is kept in the database, so
                    // the library, USB drives and rekordbox share it.
                    let result = analysis::analyze_detail(path, None)
                        .map(|d| (d.analysis.clone(), anlz::Stored::from_detail(&d)));
                    if tx.send((i, result, readable)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);
        report(AnalysisProgress {
            phase: "analyzing",
            done: 0,
            total,
        });
        for (i, result, readable) in rx {
            if readable {
                let conn = state.db.lock().map_err(|_| Error::Lock)?;
                db::store_analysis(&conn, &jobs[i].audio_fp, &result, unix_now(), replace_edits)?;
            }
            if result.is_ok() {
                out.analyzed += 1;
            } else {
                out.failed += 1;
            }
            report(AnalysisProgress {
                phase: "analyzing",
                done: out.analyzed + out.failed,
                total,
            });
        }
        Ok(())
    })?;
    out.cancelled = total - out.analyzed - out.failed;
    Ok(out)
}

/// Songs another device already analysed have their result (from its ops) but no waveform here
/// yet: their waveform is fetched from the sharing destination instead of analysing them again.
/// What could not be fetched stays in `jobs`.
async fn drop_analysed_elsewhere(
    state: &AppState,
    jobs: Vec<db::AnalysisJob>,
) -> Vec<db::AnalysisJob> {
    let waiting: Vec<String> = state.db.lock().map_or_else(
        |_| Vec::new(),
        |c| {
            jobs.iter()
                .filter(|j| {
                    c.query_row(
                        "SELECT EXISTS (SELECT 1 FROM analysis WHERE audio_fp = ?1
                             AND version >= ?2 AND waveform IS NULL)",
                        rusqlite::params![j.audio_fp, analysis::VERSION],
                        |r| r.get::<_, bool>(0),
                    )
                    .unwrap_or(false)
                })
                .map(|j| j.audio_fp.clone())
                .collect()
        },
    );
    for fp in &waiting {
        fetch_shared_waveform(state, fp).await;
    }
    let Ok(c) = state.db.lock() else {
        return jobs;
    };
    jobs.into_iter()
        .filter(|j| {
            !waiting.contains(&j.audio_fp)
                || c.query_row(
                    "SELECT waveform IS NULL FROM analysis WHERE audio_fp = ?1",
                    [&j.audio_fp],
                    |r| r.get::<_, bool>(0),
                )
                .unwrap_or(true)
        })
        .collect()
}

/// Detects BPM and key for the tracks in `track_ids` (every track when `None`). Unless
/// `force`, audio that was analysed before is skipped. Values set by hand are kept unless
/// `replace_edits` (the setting's value when `None`). Emits `analysis-progress` events.
#[tauri::command]
async fn analyze_tracks(
    app: AppHandle,
    track_ids: Option<Vec<i64>>,
    force: bool,
    replace_edits: Option<bool>,
) -> Result<AnalysisReport, Error> {
    analyze(&app, track_ids.as_deref(), force, replace_edits).await
}

/// One analysis run, from the page or the background: detects, stores, then writes the results
/// into the files' tags. Emits `analysis-finished` when it ends, however it ends, so every window
/// shows the new values.
async fn analyze(
    app: &AppHandle,
    track_ids: Option<&[i64]>,
    force: bool,
    replace_edits: Option<bool>,
) -> Result<AnalysisReport, Error> {
    let state = app.state::<AppState>();
    if state.analyzing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("an analysis is already running".to_owned()));
    }
    let result = {
        let _guard = SyncGuard(&state.analyzing);
        analyze_locked(app, &state, track_ids, force, replace_edits).await
    };
    let _ = app.emit("analysis-finished", ());
    result
}

async fn analyze_locked(
    app: &AppHandle,
    state: &AppState,
    track_ids: Option<&[i64]>,
    force: bool,
    replace_edits: Option<bool>,
) -> Result<AnalysisReport, Error> {
    state.cancel_analysis.store(false, Ordering::SeqCst);
    let (jobs, ids, replace_edits) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        let replace_edits = replace_edits.unwrap_or(analysis_settings_of(&conn)?.replace_edits);
        let jobs = db::analysis_jobs(&conn, track_ids, force)?;
        let ids = db::track_ids_with_audio_fps(
            &conn,
            &jobs.iter().map(|j| j.audio_fp.as_str()).collect::<Vec<_>>(),
        )?;
        (jobs, ids, replace_edits)
    };
    let jobs = if force {
        jobs
    } else {
        drop_analysed_elsewhere(state, jobs).await
    };
    if jobs.is_empty() {
        return Ok(AnalysisReport::default());
    }
    let handle = app.clone();
    let mut result = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let report = |p: AnalysisProgress| {
            let _ = handle.emit("analysis-progress", p);
        };
        run_analysis(&state, &jobs, replace_edits, &report)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))??;
    if !state.cancel_analysis.load(Ordering::SeqCst) {
        // Only the songs this run looked at; older results are written from Settings. Waits for
        // a tag edit in progress rather than leave the files without their results.
        wait_for_metadata_changes(state).await;
        result.tags = Some(save_analysis_tags(app, state, Some(&ids)).await?);
    }
    Ok(result)
}

/// Waits (up to a few minutes) for another metadata change to finish writing files.
async fn wait_for_metadata_changes(state: &AppState) {
    for _ in 0..360 {
        if !state.fixing.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// How long the library has to stay still before new songs are analysed, so a big import or
/// copy is analysed once it is all in rather than a few songs at a time.
const ANALYSIS_SETTLE: std::time::Duration = std::time::Duration::from_secs(3);

/// Analyses every song that came into the library, however it came (a scan, an import, a pull
/// from a destination, a file copied in), once the library has stopped changing; and at launch,
/// whatever was left from before. Audio analysed before is not done again, and a BPM or key set
/// by hand is never replaced. Waits while a sync or another analysis runs.
async fn analysis_worker(app: AppHandle) {
    let state = app.state::<AppState>();
    // Lets the launch's own scan and fingerprinting go first.
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    loop {
        while state.syncing.load(Ordering::SeqCst) || state.analyzing.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        if library_root(&state).is_ok()
            && let Err(e) = analyze(&app, None, false, Some(false)).await
        {
            log::warn!("background analysis failed: {e}");
        }
        state.analysis_wake.notified().await;
        // More may be on the way: wait until nothing has changed for a moment.
        while tokio::time::timeout(ANALYSIS_SETTLE, state.analysis_wake.notified())
            .await
            .is_ok()
        {}
    }
}

/// Stops the running analysis once the files being read now are done.
#[tauri::command]
fn cancel_analysis(state: State<'_, AppState>) {
    state.cancel_analysis.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn is_analyzing(state: State<'_, AppState>) -> bool {
    state.analyzing.load(Ordering::SeqCst)
}

macro_rules! with_db {
    ($state:expr, |$conn:ident| $body:expr) => {{
        let mut guard = $state.db.lock().map_err(|_| Error::Lock)?;
        let $conn = &mut *guard;
        $body
    }};
}

#[tauri::command]
fn list_playlists(state: State<'_, AppState>) -> Result<Vec<Playlist>, Error> {
    with_db!(state, |c| db::list_playlists(c))
}

#[tauri::command]
fn create_playlist(
    state: State<'_, AppState>,
    name: String,
    scope: Option<String>,
) -> Result<i64, Error> {
    let id = with_db!(state, |c| db::create_playlist(
        c,
        name.trim(),
        scope.as_deref()
    ))?;
    Ok(id)
}

/// A new empty tag, shared or only on this device.
#[tauri::command]
fn create_tag(
    state: State<'_, AppState>,
    name: String,
    scope: Option<String>,
) -> Result<(), Error> {
    with_db!(state, |c| db::create_tag(c, name.trim(), scope.as_deref()))
}

/// The scope new tags and playlists get: `shared` or `local`.
#[tauri::command]
fn default_scope(state: State<'_, AppState>) -> Result<String, Error> {
    with_db!(state, |c| libsync::default_scope(c).map(str::to_owned))
}

#[tauri::command]
fn set_default_scope(state: State<'_, AppState>, scope: String) -> Result<(), Error> {
    with_db!(state, |c| libsync::set_default_scope(c, &scope))
}

#[tauri::command]
fn rename_playlist(state: State<'_, AppState>, id: i64, name: String) -> Result<(), Error> {
    with_db!(state, |c| db::rename_playlist(c, id, name.trim()))?;
    Ok(())
}

#[tauri::command]
fn delete_playlist(state: State<'_, AppState>, id: i64) -> Result<(), Error> {
    with_db!(state, |c| db::delete_playlist(c, id))?;
    Ok(())
}

#[tauri::command]
fn add_to_playlist(
    state: State<'_, AppState>,
    playlist_id: i64,
    track_ids: Vec<i64>,
) -> Result<(), Error> {
    with_db!(state, |c| db::add_to_playlist(c, playlist_id, &track_ids))?;
    Ok(())
}

#[tauri::command]
fn remove_from_playlist(
    state: State<'_, AppState>,
    playlist_id: i64,
    track_id: i64,
) -> Result<(), Error> {
    with_db!(state, |c| db::remove_from_playlist(
        c,
        playlist_id,
        track_id
    ))?;
    Ok(())
}

#[tauri::command]
fn playlist_tracks(state: State<'_, AppState>, playlist_id: i64) -> Result<Vec<Track>, Error> {
    with_db!(state, |c| db::playlist_tracks(c, playlist_id))
}

#[tauri::command]
fn list_tags(state: State<'_, AppState>) -> Result<Vec<Tag>, Error> {
    with_db!(state, |c| db::list_tags(c))
}

#[tauri::command]
fn tag_tracks(state: State<'_, AppState>, name: String, track_ids: Vec<i64>) -> Result<(), Error> {
    with_db!(state, |c| db::tag_tracks(c, name.trim(), &track_ids))?;
    Ok(())
}

#[tauri::command]
fn untag_track(state: State<'_, AppState>, name: String, track_id: i64) -> Result<(), Error> {
    with_db!(state, |c| db::untag_track(c, &name, track_id))?;
    Ok(())
}

/// Renames, merges or deletes library tags by name (see `db::migrate_tags`).
#[tauri::command]
fn migrate_library_tags(
    state: State<'_, AppState>,
    from: Vec<String>,
    to: Option<String>,
) -> Result<(), Error> {
    let to = to.as_deref().map(str::trim).filter(|t| !t.is_empty());
    with_db!(state, |c| db::migrate_tags(c, &from, to))?;
    Ok(())
}

#[tauri::command]
fn delete_tag(state: State<'_, AppState>, id: i64) -> Result<(), Error> {
    with_db!(state, |c| db::delete_tag(c, id))?;
    Ok(())
}

#[tauri::command]
async fn tailscale_status() -> Result<tailscale::Status, Error> {
    tauri::async_runtime::spawn_blocking(tailscale::status)
        .await
        .map_err(|e| Error::Msg(e.to_string()))?
}

#[tauri::command]
async fn drive_list(
    state: State<'_, AppState>,
    tailnet: String,
    machine: String,
    path: Vec<String>,
) -> Result<Vec<webdav::Entry>, Error> {
    let segments: Vec<String> = [tailnet, machine].into_iter().chain(path).collect();
    webdav::list(&state.http, &segments).await
}

#[tauri::command]
fn list_sync_targets(state: State<'_, AppState>) -> Result<Vec<SyncTarget>, Error> {
    with_db!(state, |c| db::list_targets(c))
}

#[tauri::command]
fn add_sync_target(
    app: AppHandle,
    state: State<'_, AppState>,
    target: NewTarget,
) -> Result<i64, Error> {
    let id = with_db!(state, |c| db::add_target(c, &target))?;
    queue_scans(&app, &[id], true, ReadDepth::Full)?;
    Ok(id)
}

#[tauri::command]
async fn add_r2_target(
    app: AppHandle,
    state: State<'_, AppState>,
    account: String,
    bucket: String,
    prefix: String,
    key_id: String,
    secret: String,
) -> Result<i64, Error> {
    let (account, bucket) = (account.trim(), bucket.trim());
    if account.is_empty() || bucket.is_empty() || key_id.trim().is_empty() || secret.is_empty() {
        return Err(Error::Msg("fill in every field".to_owned()));
    }
    let client = r2::R2::new(account, bucket, key_id.trim(), secret.trim());
    client.check(&state.http).await?;
    let path: Vec<String> = prefix
        .split('/')
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .collect();
    let id = with_db!(state, |c| db::add_target(
        c,
        &NewTarget {
            tailnet: format!("{}{account}", r2::TARGET_PREFIX),
            machine: bucket.to_owned(),
            path,
        }
    ))?;
    client.save_credentials(id)?;
    queue_scans(&app, &[id], true, ReadDepth::Full)?;
    Ok(id)
}

/// Edits a destination: its folder (clears synced state when it changes) and,
/// for R2, the access key. A blank `secret` keeps the stored credentials.
#[tauri::command]
async fn update_sync_target(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    path: Vec<String>,
    key_id: Option<String>,
    secret: Option<String>,
) -> Result<(), Error> {
    let target = with_db!(state, |c| db::list_targets(c))?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| Error::Msg("destination no longer exists".to_owned()))?;
    let path: Vec<String> = path
        .into_iter()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    if let Some(account) = target.tailnet.strip_prefix(r2::TARGET_PREFIX) {
        let secret = secret.filter(|s| !s.is_empty());
        if let (Some(key_id), Some(secret)) = (key_id.filter(|k| !k.trim().is_empty()), secret) {
            let client = r2::R2::new(account, &target.machine, key_id.trim(), secret.trim());
            client.check(&state.http).await?;
            client.save_credentials(id)?;
        }
    } else if path.is_empty() {
        return Err(Error::Msg("choose a shared folder".to_owned()));
    }
    with_db!(state, |c| db::set_target_path(c, id, &path)).map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            Error::Msg("another destination already uses that folder".to_owned())
        } else {
            e
        }
    })?;
    queue_scans(&app, &[id], true, ReadDepth::Full)
}

fn find_target(state: &AppState, id: i64) -> Result<(SyncTarget, PathBuf), Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    let target = db::get_targets(&conn, Some(&[id]))?
        .into_iter()
        .next()
        .ok_or_else(|| Error::Msg("destination no longer exists".to_owned()))?;
    let root = db::get_setting(&conn, SETTING_ROOT)?.ok_or_else(|| {
        Error::Msg("library folder unknown: choose one in Library first".to_owned())
    })?;
    Ok((target, PathBuf::from(root)))
}

/// One folder of a destination, for the file browser. `rel` is relative to the destination folder.
#[tauri::command]
async fn remote_list(
    state: State<'_, AppState>,
    target_id: i64,
    rel: Vec<String>,
) -> Result<Vec<webdav::Entry>, Error> {
    if rel
        .iter()
        .any(|s| s.is_empty() || s == "." || s == ".." || s.contains('/'))
    {
        return Err(Error::Msg("invalid folder".to_owned()));
    }
    let (target, _) = find_target(&state, target_id)?;
    sync::browse_remote(&state.http, &target, &rel).await
}

/// Size of each subfolder of a destination folder, by name.
#[tauri::command]
async fn remote_dir_sizes(
    state: State<'_, AppState>,
    target_id: i64,
    rel: Vec<String>,
) -> Result<HashMap<String, u64>, Error> {
    if rel
        .iter()
        .any(|s| s.is_empty() || s == "." || s == ".." || s.contains('/'))
    {
        return Err(Error::Msg("invalid folder".to_owned()));
    }
    let (target, _) = find_target(&state, target_id)?;
    sync::remote_dir_sizes(&state.http, &target, &rel).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Verified {
    rel: Vec<String>,
    /// Library file with identical audio, relative to the library folder.
    duplicate_of: Option<String>,
    /// False when the remote file could not be sampled.
    checked: bool,
}

/// Compares the audio of remote files with the library by content fingerprint.
#[tauri::command]
async fn remote_verify(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: i64,
    files: Vec<Vec<String>>,
) -> Result<Vec<Verified>, Error> {
    let (target, root) = find_target(&state, target_id)?;
    let library: HashMap<String, String> = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::present_fingerprints(&conn)?
            .into_iter()
            .map(|(path, fp)| (fp, path))
            .collect()
    };
    let wanted: HashSet<Vec<String>> = files.into_iter().collect();
    let chosen: Vec<sync::Remote> = sync::list_remote(&state.http, &target)
        .await?
        .into_iter()
        .filter(|r| wanted.contains(&r.rel))
        .collect();
    let prints = sync::fingerprint_remote(&app, &state.http, &target, &chosen).await?;
    Ok(chosen
        .into_iter()
        .zip(prints)
        .map(|(file, fp)| Verified {
            checked: fp.is_some(),
            duplicate_of: fp.and_then(|fp| library.get(&fp)).map(|path| {
                rel_path(&root, path).map_or_else(|| path.clone(), |rel| rel.join("/"))
            }),
            rel: file.rel,
        })
        .collect())
}

/// Downloads the chosen files (and the contents of chosen folders) from a destination into the
/// library, then rescans.
#[tauri::command]
async fn remote_pull(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: i64,
    files: Vec<Vec<String>>,
) -> Result<sync::PullOutcome, Error> {
    let (target, root) = find_target(&state, target_id)?;
    let _claim = claim_sync(&state).await?;
    // Only paths the destination really lists are downloaded. A chosen folder brings everything
    // under it.
    let wanted: HashSet<Vec<String>> = files.into_iter().collect();
    let chosen: Vec<sync::Remote> = sync::list_remote(&state.http, &target)
        .await?
        .into_iter()
        .filter(|r| (1..=r.rel.len()).any(|n| wanted.contains(&r.rel[..n])))
        .collect();
    let outcome = sync::pull(&app, &state.http, &target, &root, &chosen).await;
    if outcome.pulled > 0 {
        scan_and_store(&state, root, ScanDepth::Changed).await?;
        // The pulled songs no longer count as missing. Plans made before stay applicable.
        queue_scans(&app, &[target_id], false, ReadDepth::Full)?;
    }
    Ok(outcome)
}

/// Copies files and folders of a destination into a library folder (a drag from a destination
/// onto the library), then rescans. Files already there are skipped.
#[tauri::command]
async fn remote_download(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: i64,
    items: Vec<sync::transfer::Item>,
    dest: PathBuf,
) -> Result<sync::PullOutcome, Error> {
    let (target, root) = find_target(&state, target_id)?;
    let dest = fsops::inside(&root, &dest)?;
    if !dest.is_dir() {
        return Err(Error::Msg("destination is not a folder".to_owned()));
    }
    let _claim = claim_sync(&state).await?;
    let outcome = sync::transfer::download(&app, &state.http, &target, &items, &dest).await?;
    if outcome.pulled > 0 {
        scan_and_store(&state, root, ScanDepth::Changed).await?;
    }
    Ok(outcome)
}

/// Every file at or under `paths`, with where it goes below `dest` on a destination. Hidden
/// files and folders are left out.
fn upload_list(
    root: &Path,
    paths: &[PathBuf],
    dest: &[String],
) -> Result<Vec<(PathBuf, Vec<String>)>, Error> {
    let mut out = Vec::new();
    for p in paths {
        let from = fsops::inside(root, p)?;
        let Some(name) = from.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        let head: Vec<String> = dest.iter().cloned().chain([name]).collect();
        if from.is_file() {
            out.push((from, head));
            continue;
        }
        for entry in walkdir::WalkDir::new(&from)
            .into_iter()
            .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            let Ok(rel) = entry.path().strip_prefix(&from) else {
                continue;
            };
            let parts: Option<Vec<String>> = rel
                .components()
                .map(|c| c.as_os_str().to_str().map(str::to_owned))
                .collect();
            if let Some(parts) = parts {
                out.push((
                    entry.path().to_path_buf(),
                    head.iter().cloned().chain(parts).collect(),
                ));
            }
        }
    }
    Ok(out)
}

/// Copies library files and folders to a destination folder (a drag from the library onto a
/// destination). Files already there are skipped; the library is not changed.
#[tauri::command]
async fn remote_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: i64,
    paths: Vec<PathBuf>,
    dest: Vec<String>,
) -> Result<sync::PullOutcome, Error> {
    let (target, root) = find_target(&state, target_id)?;
    let files = tauri::async_runtime::spawn_blocking(move || upload_list(&root, &paths, &dest))
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;
    let _claim = claim_sync(&state).await?;
    let held = sync::lock::acquire(&state.http, &target, &lock_owner(&state)?).await?;
    let uploaded = sync::transfer::upload(&app, &state.http, &target, &files).await;
    held.release().await;
    uploaded
}

/// Moves files and folders into another folder of the same destination.
#[tauri::command]
async fn remote_move(
    state: State<'_, AppState>,
    target_id: i64,
    items: Vec<sync::transfer::Item>,
    dest: Vec<String>,
) -> Result<usize, Error> {
    let (target, _) = find_target(&state, target_id)?;
    let _claim = claim_sync(&state).await?;
    let held = sync::lock::acquire(&state.http, &target, &lock_owner(&state)?).await?;
    let moved = sync::transfer::move_items(&state.http, &target, &items, &dest).await;
    held.release().await;
    moved
}

#[tauri::command]
fn remove_sync_target(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<(), Error> {
    with_db!(state, |c| db::remove_target(c, id))?;
    r2::forget_credentials(id);
    jellyfin::forget_key(id);
    with_db!(state, |c| db::remove_export_selection(
        c,
        &jellyfin_destination(id)
    ))?;
    state.scans.lock().map_err(|_| Error::Lock)?.forget(id);
    let _ = app.emit("sync-scan", ());
    Ok(())
}

// ---- Jellyfin ----------------------------------------------------------------------------------

/// The Jellyfin server saved for a destination, if any.
#[tauri::command]
fn jellyfin_settings(
    state: State<'_, AppState>,
    target_id: i64,
) -> Result<Option<jellyfin::Settings>, Error> {
    with_db!(state, |c| db::jellyfin_settings(c, target_id))
}

/// The key typed, or the one saved for the destination when none was typed.
fn typed_or_saved_key(target_id: i64, api_key: Option<&str>) -> Result<jellyfin::ApiKey, Error> {
    match api_key.filter(|k| !k.trim().is_empty()) {
        Some(typed) => jellyfin::ApiKey::parse(typed),
        None => jellyfin::load_key(target_id),
    }
}

/// Reads a server's users and song libraries, to choose from before saving.
#[tauri::command]
async fn jellyfin_probe(
    state: State<'_, AppState>,
    target_id: i64,
    url: String,
    api_key: Option<String>,
) -> Result<jellyfin::Server, Error> {
    let url = jellyfin::ServerUrl::parse(&url)?;
    let key = typed_or_saved_key(target_id, api_key.as_deref())?;
    jellyfin::Jellyfin::new(&state.http, &url, &key)
        .server()
        .await
}

/// Saves the Jellyfin server that scans a destination, once the server confirms the key, the
/// user and the library. An empty `api_key` keeps the saved one.
#[tauri::command]
async fn jellyfin_save(
    state: State<'_, AppState>,
    target_id: i64,
    url: String,
    api_key: Option<String>,
    user_id: String,
    library_id: String,
    visibility: jellyfin::Visibility,
) -> Result<jellyfin::Settings, Error> {
    if !with_db!(state, |c| db::list_targets(c))?
        .iter()
        .any(|t| t.id == target_id)
    {
        return Err(Error::Msg("destination no longer exists".to_owned()));
    }
    let url = jellyfin::ServerUrl::parse(&url)?;
    let typed = api_key.as_deref().is_some_and(|k| !k.trim().is_empty());
    let key = typed_or_saved_key(target_id, api_key.as_deref())?;
    let server = jellyfin::Jellyfin::new(&state.http, &url, &key)
        .server()
        .await?;
    let user = server
        .users
        .iter()
        .find(|u| u.id.0 == user_id)
        .cloned()
        .ok_or_else(|| Error::Msg("that Jellyfin user is no longer on the server".to_owned()))?;
    let library = server
        .libraries
        .into_iter()
        .find(|l| l.id.0 == library_id)
        .ok_or_else(|| Error::Msg("that Jellyfin library is no longer on the server".to_owned()))?;
    let visibility = visibility.normalised(&user.id);
    if let jellyfin::Visibility::Users { users } = &visibility
        && users
            .iter()
            .any(|u| !server.users.iter().any(|s| &s.id == u))
    {
        return Err(Error::Msg(
            "a user chosen to see the playlists is no longer on the server".to_owned(),
        ));
    }
    let settings = jellyfin::Settings {
        url,
        server_name: server.name,
        user,
        library: jellyfin::LibraryRef {
            id: library.id,
            name: library.name,
        },
        visibility,
    };
    if typed {
        jellyfin::save_key(target_id, &key)?;
    }
    with_db!(state, |c| db::save_jellyfin(c, target_id, &settings))?;
    Ok(settings)
}

/// How many of a destination's songs its Jellyfin server has, with a few it does not.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct JellyfinSongCheck {
    synced: usize,
    found: usize,
    missing: usize,
    ambiguous: usize,
    /// Destination paths of up to [`SONG_CHECK_EXAMPLES`] songs not found, missing ones first.
    examples: Vec<String>,
}

const SONG_CHECK_EXAMPLES: usize = 5;

/// Songs synced to a destination, by their path inside it (the same as inside the library).
fn destination_songs(
    conn: &Connection,
    target_id: i64,
) -> Result<Vec<jellyfin::matching::DestinationSong>, Error> {
    let Some(root) = db::get_setting(conn, SETTING_ROOT)? else {
        return Ok(Vec::new());
    };
    let root = Path::new(&root);
    Ok(db::synced_track_paths(conn, target_id)?
        .into_iter()
        .filter_map(|(track_id, path)| {
            Some(jellyfin::matching::DestinationSong {
                track_id,
                rel: rel_path(root, &path)?,
            })
        })
        .collect())
}

/// Matches the destination's songs to the songs in its Jellyfin library.
#[tauri::command]
async fn jellyfin_check_songs(
    state: State<'_, AppState>,
    target_id: i64,
) -> Result<JellyfinSongCheck, Error> {
    let (settings, songs) = with_db!(state, |c| Ok::<_, Error>((
        db::jellyfin_settings(c, target_id)?,
        destination_songs(c, target_id)?
    )))?;
    let settings =
        settings.ok_or_else(|| Error::Msg("connect a Jellyfin server first".to_owned()))?;
    let key = jellyfin::load_key(target_id)?;
    let items = jellyfin::Jellyfin::new(&state.http, &settings.url, &key)
        .audio_items(&settings.library.id, &settings.user.id)
        .await?;
    let matches = jellyfin::matching::match_songs(&songs, &items);
    let rel_of: HashMap<i64, String> = songs
        .iter()
        .map(|s| (s.track_id, s.rel.join("/")))
        .collect();
    let examples = matches
        .missing
        .iter()
        .chain(&matches.ambiguous)
        .filter_map(|id| rel_of.get(id).cloned())
        .take(SONG_CHECK_EXAMPLES)
        .collect();
    Ok(JellyfinSongCheck {
        synced: songs.len(),
        found: matches.found.len(),
        missing: matches.missing.len(),
        ambiguous: matches.ambiguous.len(),
        examples,
    })
}

/// The `export_selections` key of what a destination sends its Jellyfin server.
fn jellyfin_destination(target_id: i64) -> String {
    format!("jellyfin:{target_id}")
}

/// A destination with a Jellyfin server, and the playlists chosen for it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct JellyfinDestination {
    target_id: i64,
    server_name: String,
    selection: db::ExportSelection,
    last_push: Option<LastJellyfinPush>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LastJellyfinPush {
    /// Unix seconds, UTC.
    at: i64,
    summary: jellyfin::push::Summary,
}

/// Every destination with a Jellyfin server, with what each sends it.
#[tauri::command]
fn jellyfin_destinations(state: State<'_, AppState>) -> Result<Vec<JellyfinDestination>, Error> {
    with_db!(state, |c| {
        let mut out = Vec::new();
        for target in db::list_targets(c)? {
            if let Some(settings) = db::jellyfin_settings(c, target.id)? {
                out.push(JellyfinDestination {
                    target_id: target.id,
                    server_name: settings.server_name,
                    selection: db::export_selection(c, &jellyfin_destination(target.id))?
                        .unwrap_or_default(),
                    last_push: db::last_jellyfin_push(c, target.id)?.and_then(|(at, json)| {
                        Some(LastJellyfinPush {
                            at,
                            summary: serde_json::from_str(&json).ok()?,
                        })
                    }),
                });
            }
        }
        Ok(out)
    })
}

/// Saves which playlists, tags and smart playlists go to a destination's Jellyfin server.
#[tauri::command]
fn jellyfin_set_selection(
    state: State<'_, AppState>,
    target_id: i64,
    selection: db::ExportSelection,
) -> Result<db::ExportSelection, Error> {
    with_db!(state, |c| {
        if db::jellyfin_settings(c, target_id)?.is_none() {
            return Err(Error::Msg("connect a Jellyfin server first".to_owned()));
        }
        db::set_export_selection(c, &jellyfin_destination(target_id), &selection)?;
        Ok(db::export_selection(c, &jellyfin_destination(target_id))?.unwrap_or_default())
    })
}

/// The playlists the destination's Jellyfin user has on the server now.
#[tauri::command]
async fn jellyfin_server_playlists(
    state: State<'_, AppState>,
    target_id: i64,
) -> Result<Vec<jellyfin::ServerPlaylist>, Error> {
    let settings = with_db!(state, |c| db::jellyfin_settings(c, target_id))?
        .ok_or_else(|| Error::Msg("connect a Jellyfin server first".to_owned()))?;
    let key = jellyfin::load_key(target_id)?;
    jellyfin::Jellyfin::new(&state.http, &settings.url, &key)
        .playlists(&settings.user.id)
        .await
}

/// The chosen playlists with their songs now: library playlists, tags (named as on a USB drive,
/// "Genre › House") and smart playlists, each with a key that survives renames.
fn jellyfin_wanted(
    conn: &Connection,
    selection: &db::ExportSelection,
) -> Result<Vec<jellyfin::push::Wanted>, Error> {
    use jellyfin::push::{PlaylistKey, Wanted};
    let mut out = Vec::new();
    let (_, lists) = db::export_data(conn)?;
    for id in &selection.playlists {
        if let Some(p) = lists.iter().find(|p| p.id == Some(*id)) {
            let uid = db::uid_of(conn, "playlists", *id)?.unwrap_or_else(|| id.to_string());
            out.push(Wanted {
                key: PlaylistKey(format!("playlist:{uid}")),
                name: p.name.clone(),
                track_ids: p.track_ids.clone(),
            });
        }
    }
    for p in db::export_tag_playlists(conn, &selection.tags)? {
        out.push(Wanted {
            key: PlaylistKey(format!("tag:{}", p.name.to_lowercase())),
            name: p.name.replace('/', " › "),
            track_ids: p.track_ids,
        });
    }
    if !selection.smart.is_empty() {
        let tracks = db::list(conn)?;
        let now = unix_now();
        for p in db::smart_playlists(conn)?
            .into_iter()
            .filter(|p| selection.smart.contains(&p.id))
        {
            let uid =
                db::uid_of(conn, "smart_playlists", p.id)?.unwrap_or_else(|| p.id.to_string());
            out.push(Wanted {
                key: PlaylistKey(format!("smart:{uid}")),
                track_ids: smart::resolve(&p.rules, &tracks, now),
                name: p.name,
            });
        }
    }
    Ok(out)
}

/// Works out what a push would change, reading the server for its songs and playlists.
/// How long a push waits for Jellyfin to scan songs a sync just uploaded.
const JELLYFIN_SCAN_WAIT: std::time::Duration = std::time::Duration::from_secs(120);
const JELLYFIN_SCAN_POLL: std::time::Duration = std::time::Duration::from_secs(5);

/// Chosen songs on the destination that Jellyfin does not have yet: it is told about them, then
/// read again until it has them all, stops finding more, or [`JELLYFIN_SCAN_WAIT`] passes.
async fn jellyfin_wait_for_new(
    server: &jellyfin::Jellyfin<'_>,
    settings: &jellyfin::Settings,
    songs: &[jellyfin::matching::DestinationSong],
    chosen: &HashSet<i64>,
    mut items: Vec<jellyfin::matching::ServerItem>,
) -> Result<Vec<jellyfin::matching::ServerItem>, Error> {
    let missing_of = |items: &[jellyfin::matching::ServerItem]| -> Vec<i64> {
        jellyfin::matching::match_songs(songs, items)
            .missing
            .into_iter()
            .filter(|t| chosen.contains(t))
            .collect()
    };
    let mut missing = missing_of(&items);
    if missing.is_empty() {
        return Ok(items);
    }
    let locations = server.library_locations(&settings.library.id).await?;
    let not_scanned: HashSet<i64> = missing.iter().copied().collect();
    let paths: Vec<String> = songs
        .iter()
        .filter(|s| not_scanned.contains(&s.track_id))
        .flat_map(|s| jellyfin::matching::server_paths(&locations, &s.rel))
        .collect();
    server.report_new_files(&paths).await?;
    let started = std::time::Instant::now();
    let mut quiet_polls = 0;
    while !missing.is_empty() && started.elapsed() < JELLYFIN_SCAN_WAIT && quiet_polls < 6 {
        tokio::time::sleep(JELLYFIN_SCAN_POLL).await;
        items = server
            .audio_items(&settings.library.id, &settings.user.id)
            .await?;
        let now_missing = missing_of(&items);
        quiet_polls = if now_missing.len() < missing.len() {
            0
        } else {
            quiet_polls + 1
        };
        missing = now_missing;
    }
    Ok(items)
}

/// Works out what a push would change, reading the server for its songs and playlists. With
/// `wait_for_new`, chosen songs Jellyfin has not scanned yet are waited for first.
async fn jellyfin_prepare(
    state: &AppState,
    target_id: i64,
    wait_for_new: bool,
) -> Result<Vec<jellyfin::push::Planned>, Error> {
    let (settings, wanted, songs, known) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        let settings = db::jellyfin_settings(&conn, target_id)?
            .ok_or_else(|| Error::Msg("connect a Jellyfin server first".to_owned()))?;
        let selection =
            db::export_selection(&conn, &jellyfin_destination(target_id))?.unwrap_or_default();
        (
            settings,
            jellyfin_wanted(&conn, &selection)?,
            destination_songs(&conn, target_id)?,
            db::jellyfin_known(&conn, target_id)?,
        )
    };
    let key = jellyfin::load_key(target_id)?;
    let server = jellyfin::Jellyfin::new(&state.http, &settings.url, &key);
    let mut items = server
        .audio_items(&settings.library.id, &settings.user.id)
        .await?;
    if wait_for_new {
        let chosen: HashSet<i64> = wanted
            .iter()
            .flat_map(|w| w.track_ids.iter().copied())
            .collect();
        items = jellyfin_wait_for_new(&server, &settings, &songs, &chosen, items).await?;
    }
    let found = jellyfin::matching::match_songs(&songs, &items).found;
    // Songs are read only for playlists manplay may change: its own, and same-named ones.
    let names: HashSet<&str> = wanted.iter().map(|w| w.name.as_str()).collect();
    let owned: HashSet<&jellyfin::PlaylistId> = known.values().map(|s| &s.id).collect();
    let mut on_server = Vec::new();
    for p in server.playlists(&settings.user.id).await? {
        if !owned.contains(&p.id) && !names.contains(p.name.as_str()) {
            continue;
        }
        let entries = server.playlist_entries(&p.id, &settings.user.id).await?;
        on_server.push(jellyfin::push::OnServer {
            songs: entries.into_iter().map(|e| e.song).collect(),
            id: p.id,
            name: p.name,
        });
    }
    Ok(jellyfin::push::plan(
        &wanted,
        &known,
        &on_server,
        &found,
        &settings.visibility,
    ))
}

/// A playlist's name and songs before it is changed or deleted, under
/// `jellyfin-backups/<unix time>/`, pruned like the sync backups.
fn jellyfin_backup(
    dir: &Path,
    target_id: i64,
    id: &jellyfin::PlaylistId,
    name: &str,
    songs: &[jellyfin::AudioId],
) -> Result<(), Error> {
    std::fs::create_dir_all(dir)?;
    let json = serde_json::json!({ "targetId": target_id, "playlistId": id, "name": name, "songs": songs });
    let file = dir.join(format!(
        "{target_id}-{}.json",
        id.0.replace(['/', '\\'], "_")
    ));
    std::fs::write(
        file,
        serde_json::to_vec_pretty(&json).map_err(|e| Error::Msg(e.to_string()))?,
    )?;
    Ok(())
}

/// Carries out one planned playlist change.
async fn jellyfin_apply_one(
    state: &AppState,
    server: &jellyfin::Jellyfin<'_>,
    settings: &jellyfin::Settings,
    target_id: i64,
    backup_dir: &Path,
    p: &jellyfin::push::Planned,
) -> Result<(), Error> {
    use jellyfin::push::Action;
    let user = &settings.user.id;
    let visibility = &settings.visibility;
    // `made` is who a new playlist was made visible to; `None` keeps what was recorded.
    let remember = |id: &jellyfin::PlaylistId, made: Option<&jellyfin::Visibility>| {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::set_jellyfin_known(&conn, target_id, &p.key, id, made)
    };
    match &p.action {
        Action::Create => {
            let id = server
                .create_playlist(&p.name, &p.songs, user, visibility)
                .await?;
            remember(&id, Some(visibility))?;
        }
        Action::Refill { id } => {
            jellyfin_backup(backup_dir, target_id, id, &p.name, &p.before)?;
            remember(id, None)?;
            let entries: Vec<jellyfin::EntryId> = server
                .playlist_entries(id, user)
                .await?
                .into_iter()
                .map(|e| e.entry)
                .collect();
            server.remove_entries(id, &entries).await?;
            server.add_songs(id, &p.songs, user).await?;
        }
        Action::Rename { old, old_name } => {
            let id = server
                .create_playlist(&p.name, &p.songs, user, visibility)
                .await?;
            remember(&id, Some(visibility))?;
            jellyfin_backup(backup_dir, target_id, old, old_name, &p.before)?;
            server.delete_playlist(old, user).await?;
        }
        Action::Reshare { old } => {
            let id = server
                .create_playlist(&p.name, &p.songs, user, visibility)
                .await?;
            remember(&id, Some(visibility))?;
            jellyfin_backup(backup_dir, target_id, old, &p.name, &p.before)?;
            server.delete_playlist(old, user).await?;
        }
        Action::Remove { id } => {
            jellyfin_backup(backup_dir, target_id, id, &p.name, &p.before)?;
            server.delete_playlist(id, user).await?;
            let conn = state.db.lock().map_err(|_| Error::Lock)?;
            db::forget_jellyfin_known(&conn, target_id, &p.key)?;
        }
        Action::Unchanged { id } => remember(id, None)?,
    }
    Ok(())
}

/// Sends planned changes. Without `reviewed`, changes that delete or take over a playlist are
/// left for a review and counted as waiting.
async fn jellyfin_send(
    state: &AppState,
    target_id: i64,
    planned: &[jellyfin::push::Planned],
    reviewed: bool,
) -> Result<jellyfin::push::Summary, Error> {
    use jellyfin::push::{Action, Summary};
    let _one_at_a_time = state.jellyfin_pushing.lock().await;
    let settings = with_db!(state, |c| db::jellyfin_settings(c, target_id))?
        .ok_or_else(|| Error::Msg("connect a Jellyfin server first".to_owned()))?;
    let key = jellyfin::load_key(target_id)?;
    let server = jellyfin::Jellyfin::new(&state.http, &settings.url, &key);
    let now = unix_now();
    let backups = state.data_dir.join("jellyfin-backups");
    let backup_dir = backups.join(format!("{now:012}"));
    let mut summary = Summary::default();
    for p in planned {
        if !reviewed && p.needs_review() {
            summary.waiting += usize::from(p.changes() || p.adopted);
            continue;
        }
        match jellyfin_apply_one(state, &server, &settings, target_id, &backup_dir, p).await {
            Ok(()) => match p.action {
                Action::Create => summary.created += 1,
                Action::Refill { .. } => summary.updated += 1,
                Action::Rename { .. } => summary.renamed += 1,
                Action::Reshare { .. } => summary.reshared += 1,
                Action::Remove { .. } => summary.removed += 1,
                Action::Unchanged { .. } => {}
            },
            Err(e) => summary.failed.push(format!("{}: {e}", p.name)),
        }
    }
    let json = serde_json::to_string(&summary).map_err(|e| Error::Msg(e.to_string()))?;
    with_db!(state, |c| db::record_jellyfin_push(
        c, target_id, now, &json
    ))?;
    sync::prune_backups(&backups, now, SYNC_BACKUP_KEEP_SECS);
    Ok(summary)
}

/// What sending the chosen playlists would change, for review. Kept until Send.
#[tauri::command]
async fn jellyfin_plan(
    state: State<'_, AppState>,
    target_id: i64,
) -> Result<Vec<jellyfin::push::Row>, Error> {
    let planned = jellyfin_prepare(&state, target_id, false).await?;
    let rows = planned.iter().map(jellyfin::push::Planned::row).collect();
    state
        .jellyfin_plans
        .lock()
        .map_err(|_| Error::Lock)?
        .insert(target_id, planned);
    Ok(rows)
}

/// Sends the reviewed playlists to Jellyfin, exactly as the review showed them.
#[tauri::command]
async fn jellyfin_push(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: i64,
) -> Result<jellyfin::push::Summary, Error> {
    let planned = state
        .jellyfin_plans
        .lock()
        .map_err(|_| Error::Lock)?
        .remove(&target_id)
        .ok_or_else(|| Error::Msg("review the playlists again before sending".to_owned()))?;
    let summary = jellyfin_send(&state, target_id, &planned, true).await?;
    let _ = app.emit("jellyfin-push", target_id);
    Ok(summary)
}

/// After a sync: sends new songs and new playlists to each synced destination's Jellyfin server.
/// Renames, removals and take-overs wait for a review.
async fn jellyfin_after_sync(app: AppHandle, target_ids: Vec<i64>) {
    let state = app.state::<AppState>();
    for target_id in target_ids {
        // Nothing chosen and nothing sent before: no need to read the server.
        let has_work = state.db.lock().is_ok_and(|c| {
            let connected = db::jellyfin_settings(&c, target_id)
                .ok()
                .flatten()
                .is_some();
            let chosen = db::export_selection(&c, &jellyfin_destination(target_id))
                .ok()
                .flatten()
                .is_some_and(|s| {
                    !(s.playlists.is_empty() && s.tags.is_empty() && s.smart.is_empty())
                });
            let sent = db::jellyfin_known(&c, target_id).is_ok_and(|k| !k.is_empty());
            connected && (chosen || sent)
        });
        if !has_work {
            continue;
        }
        let outcome = match jellyfin_prepare(&state, target_id, true).await {
            Ok(planned) => jellyfin_send(&state, target_id, &planned, false).await,
            Err(e) => Err(e),
        };
        if let Err(e) = outcome {
            let failed = jellyfin::push::Summary {
                failed: vec![e.to_string()],
                ..Default::default()
            };
            if let (Ok(json), Ok(conn)) = (serde_json::to_string(&failed), state.db.lock()) {
                let _ = db::record_jellyfin_push(&conn, target_id, unix_now(), &json);
            }
        }
        let _ = app.emit("jellyfin-push", target_id);
    }
}

/// Forgets a destination's Jellyfin server and its API key. Playlists already on the server stay.
#[tauri::command]
fn jellyfin_forget(state: State<'_, AppState>, target_id: i64) -> Result<(), Error> {
    with_db!(state, |c| db::remove_jellyfin(c, target_id))?;
    jellyfin::forget_key(target_id);
    Ok(())
}

#[tauri::command]
fn dismiss_sync_runs(state: State<'_, AppState>, ids: Vec<i64>) -> Result<(), Error> {
    with_db!(state, |c| db::dismiss_runs(c, &ids))
}

#[tauri::command]
fn sync_history(state: State<'_, AppState>, limit: i64) -> Result<Vec<RunView>, Error> {
    with_db!(state, |c| db::history(c, limit))
}

/// Removable drives that are plugged in right now.
#[tauri::command]
async fn usb_drives(app: AppHandle) -> Result<Vec<usb::Drive>, Error> {
    let drives = tauri::async_runtime::spawn_blocking(usb::list)
        .await
        .map_err(|e| Error::Msg(e.to_string()))?;
    for d in &drives {
        allow_assets(&app, &d.mount);
    }
    Ok(drives)
}

/// Which rekordbox library formats a plugged-in drive holds, with their sizes.
#[tauri::command]
async fn usb_formats(mount: PathBuf) -> Result<usb::Formats, Error> {
    tauri::async_runtime::spawn_blocking(move || {
        usb::check_mount(&mount)?;
        Ok(usb::formats(&mount))
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?
    .map_err(Error::Msg)
}

/// One of the libraries on a plugged-in drive (its main one, rekordbox's or manplay's own list,
/// when `format` is not given); empty if it has none.
#[tauri::command]
async fn usb_library(
    mount: PathBuf,
    format: Option<usb_browse::Format>,
) -> Result<pdb::Library, Error> {
    tauri::async_runtime::spawn_blocking(move || {
        usb::check_mount(&mount)?;
        match format {
            None => usb::library(&mount),
            Some(format) => usb_browse::library(&mount, format),
        }
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?
    .map_err(Error::Msg)
}

/// What was last exported to a drive (by its `Drive::id`); `None` before its first export.
#[tauri::command]
fn usb_export_selection(
    state: State<'_, AppState>,
    drive_id: String,
) -> Result<Option<db::ExportSelection>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::export_selection(&conn, &format!("usb:{drive_id}"))
}

/// The drive now holds this choice, so the next export to it starts from it.
fn remember_usb_selection(
    state: &AppState,
    drive_id: &str,
    selection: db::ExportSelection,
) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_owned())?;
    db::set_export_selection(&conn, &format!("usb:{drive_id}"), &selection)
        .map_err(|e| e.to_string())
}

/// What goes onto a drive: the chosen library playlists, then tags and smart playlists as
/// top-level playlists (tags named as in the rekordbox file, "Genre › House"). Empty ones are left out.
fn usb_playlists(
    conn: &Connection,
    lists: &[db::ExportPlaylist],
    selection: &db::ExportSelection,
) -> Result<Vec<usb_export::SourcePlaylist>, Error> {
    let library = selection
        .playlists
        .iter()
        .filter_map(|id| lists.iter().find(|p| p.id == Some(*id)))
        .map(|p| usb_export::SourcePlaylist {
            name: p.name.clone(),
            track_ids: p.track_ids.clone(),
        });
    let tags = db::export_tag_playlists(conn, &selection.tags)?
        .into_iter()
        .filter(|p| !p.track_ids.is_empty())
        .map(|p| usb_export::SourcePlaylist {
            name: p.name.replace('/', " › "),
            track_ids: p.track_ids,
        });
    let smart =
        chosen_smart(conn, &selection.smart)?
            .into_iter()
            .map(|p| usb_export::SourcePlaylist {
                name: p.name,
                track_ids: p.track_ids,
            });
    Ok(library.chain(tags).chain(smart).collect())
}

/// The chosen smart playlists with the songs their rules pick now. Empty ones are left out, as
/// empty tag playlists are.
fn chosen_smart(conn: &Connection, ids: &[i64]) -> Result<Vec<db::ExportPlaylist>, Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let tracks = db::list(conn)?;
    let now = unix_now();
    Ok(db::smart_playlists(conn)?
        .into_iter()
        .filter(|p| ids.contains(&p.id))
        .map(|p| db::ExportPlaylist {
            id: None,
            track_ids: smart::resolve(&p.rules, &tracks, now),
            name: p.name,
        })
        .filter(|p| !p.track_ids.is_empty())
        .collect())
}

/// Every smart playlist in the library.
#[tauri::command]
fn smart_playlists(state: State<'_, AppState>) -> Result<Vec<db::SmartListing>, Error> {
    with_db!(state, |c| db::smart_listing(c))
}

/// Adds (`id` 0) or changes a smart playlist. Only its rules are kept; its songs are worked out
/// whenever it is shown or exported.
#[tauri::command]
fn smart_playlist_save(
    state: State<'_, AppState>,
    playlist: smart::SmartPlaylist,
) -> Result<smart::SmartPlaylist, Error> {
    let name = playlist.name.trim();
    if name.is_empty() {
        return Err(Error::Msg("Give the smart playlist a name.".into()));
    }
    let playlist = smart::SmartPlaylist {
        name: name.to_owned(),
        ..playlist
    };
    with_db!(state, |c| db::save_smart_playlist(c, &playlist))
}

#[tauri::command]
fn smart_playlist_delete(state: State<'_, AppState>, id: i64) -> Result<(), Error> {
    with_db!(state, |c| db::delete_smart_playlist(c, id))
}

/// The songs a rule set picks right now.
#[tauri::command]
fn smart_playlist_preview(
    state: State<'_, AppState>,
    rules: smart::Rules,
) -> Result<smart::Preview, Error> {
    with_db!(state, |c| Ok(smart::preview(
        &rules,
        &db::list(c)?,
        unix_now()
    )))
}

/// The library's songs and the chosen playlists, as a USB export or its preview takes them.
fn usb_inputs(
    state: &AppState,
    selection: &db::ExportSelection,
) -> Result<
    (
        Vec<usb_export::Source>,
        Vec<usb_export::SourcePlaylist>,
        bool,
    ),
    Error,
> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    let camelot = analysis_settings_of(&conn)?.key_format == KeyFormat::Camelot;
    let (tracks, lists) = db::export_data(&conn)?;
    let sources: Vec<usb_export::Source> = tracks
        .into_iter()
        .map(|t| usb_export::Source {
            id: t.id,
            path: PathBuf::from(&t.path),
            artist: t.artist,
            album: t.album,
            title: t.title,
            size: u64::try_from(t.size).unwrap_or(0),
            duration_ms: t.duration_ms,
            bitrate: t.bitrate,
            sample_rate: t.sample_rate,
            bpm: t.bpm,
            key: t.key.map(|k| {
                if camelot {
                    analysis::camelot(&k).unwrap_or(k)
                } else {
                    k
                }
            }),
            cues: t
                .audio_fp
                .as_deref()
                .and_then(|fp| db::cues_of(&conn, fp).ok().flatten()),
            audio_fp: t.audio_fp,
            grid_edited: t.grid_edited,
        })
        .collect();
    let playlists = usb_playlists(&conn, &lists, selection)?;
    if playlists.is_empty() {
        return Err(Error::Msg(
            "Choose at least one playlist, tag or smart playlist with songs.".into(),
        ));
    }
    Ok((sources, playlists, camelot))
}

/// What exporting `selection` would change on the drive: playlists added, changed and removed,
/// and songs copied and deleted. Nothing is written.
#[tauri::command]
async fn usb_export_preview(
    app: AppHandle,
    mount: PathBuf,
    selection: db::ExportSelection,
) -> Result<usb_export::Diff, Error> {
    tauri::async_runtime::spawn_blocking(move || {
        usb::check_mount(&mount).map_err(Error::Msg)?;
        let state = app.state::<AppState>();
        let (sources, playlists, _) = usb_inputs(&state, &selection)?;
        usb_export::preview(&mount, &sources, &playlists, selection.usb_mode).map_err(Error::Msg)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?
}

/// Copies the chosen playlists and their songs onto a USB drive and rewrites its rekordbox
/// library; `selection.usb_mode` says what happens to what is already there. Emits
/// `usb-export-progress`.
#[tauri::command]
async fn export_to_usb(
    app: AppHandle,
    state: State<'_, AppState>,
    mount: PathBuf,
    selection: db::ExportSelection,
) -> Result<usb_export::Report, Error> {
    if state.usb_exporting.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg(
            "An export to a USB drive is already running.".into(),
        ));
    }
    let _guard = SyncGuard(&state.usb_exporting);
    let (sources, playlists, camelot) = usb_inputs(&state, &selection)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let drive = usb::list()
            .into_iter()
            .find(|d| d.mount == mount)
            .ok_or_else(|| format!("{} is not a connected USB drive", mount.display()))?;
        if !drive.writable {
            return Err(format!("{} is read-only.", drive.name));
        }
        let now = unix_now();
        let today = usb_export::date(now);
        let secs = now.rem_euclid(86_400);
        let stamp = format!(
            "{today}-{:02}{:02}{:02}",
            secs / 3600,
            secs / 60 % 60,
            secs % 60
        );
        let opts = usb_export::Options {
            today: &today,
            stamp: &stamp,
            free_bytes: drive.free_bytes,
            store: Some(&state.db),
            camelot,
            mode: selection.usb_mode,
            outputs: selection.usb_outputs,
            folder_file_names: &selection.usb_folder_file_names,
        };
        let report = usb_export::export(&mount, &sources, &playlists, &opts, |p| {
            let _ = app.emit("usb-export-progress", p);
        })?;
        remember_usb_selection(&state, &drive.id, selection)?;
        Ok(report)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?
    .map_err(Error::Msg)
}

/// Renames, deletes, creates or moves a playlist on a USB drive, or takes songs out of one.
/// Returns the drive's library as it is now.
#[tauri::command]
async fn usb_edit_playlists(
    state: State<'_, AppState>,
    mount: PathBuf,
    edit: usb_edit::Edit,
) -> Result<usb_edit::Outcome, Error> {
    if state.usb_exporting.load(Ordering::SeqCst) {
        return Err(Error::Msg(
            "Songs are being exported to a USB drive. Try again when that finishes.".into(),
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        usb::check_mount(&mount)?;
        let today = usb_export::date(unix_now());
        let stamp = format!("{today}-edits");
        usb_edit::edit(&mount, edit, &stamp, &today)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?
    .map_err(Error::Msg)
}

/// Unmounts a drive so it can be unplugged.
#[tauri::command]
async fn usb_eject(state: State<'_, AppState>, mount: PathBuf) -> Result<(), Error> {
    if state.usb_exporting.load(Ordering::SeqCst) {
        return Err(Error::Msg(
            "Songs are being exported to a USB drive. Eject it when that finishes.".into(),
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        usb::check_mount(&mount)?;
        usb::eject(&mount)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?
    .map_err(Error::Msg)
}

/// Opens a drive in Finder.
#[tauri::command]
async fn usb_reveal(mount: PathBuf) -> Result<(), Error> {
    tauri::async_runtime::spawn_blocking(move || {
        usb::check_mount(&mount)?;
        usb::reveal(&mount)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?
    .map_err(Error::Msg)
}

/// The copies of earlier libraries manplay kept on a drive.
#[tauri::command]
async fn usb_backups(mount: PathBuf) -> Result<usb::Backups, Error> {
    tauri::async_runtime::spawn_blocking(move || {
        usb::check_mount(&mount)?;
        Ok(usb::backups(&mount))
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?
    .map_err(Error::Msg)
}

/// Deletes all but the newest `keep` library backups on a drive; returns what is left.
#[tauri::command]
async fn usb_delete_backups(
    state: State<'_, AppState>,
    mount: PathBuf,
    keep: usize,
) -> Result<usb::Backups, Error> {
    if state.usb_exporting.load(Ordering::SeqCst) {
        return Err(Error::Msg(
            "Songs are being exported to a USB drive. Try again when that finishes.".into(),
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        usb::check_mount(&mount)?;
        usb::delete_backups(&mount, keep)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?
    .map_err(Error::Msg)
}

/// Starts a drive afresh: moves its rekordbox libraries, analysis files, artwork and the songs
/// exported to it into the drive's Trash. Player settings and other files stay.
#[tauri::command]
async fn usb_reset(state: State<'_, AppState>, mount: PathBuf) -> Result<usize, Error> {
    if state.usb_exporting.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg(
            "Songs are being exported to a USB drive. Try again when that finishes.".into(),
        ));
    }
    let _guard = SyncGuard(&state.usb_exporting);
    tauri::async_runtime::spawn_blocking(move || {
        usb::check_mount(&mount)?;
        if !usb::list().iter().any(|d| d.mount == mount && d.writable) {
            return Err(format!("{} is read-only.", mount.display()));
        }
        usb_edit::reset(&mount)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?
    .map_err(Error::Msg)
}

/// Whether songs are being copied onto a USB drive right now.
#[tauri::command]
fn is_exporting_to_usb(state: State<'_, AppState>) -> bool {
    state.usb_exporting.load(Ordering::SeqCst)
}

/// What the library shows for a track's analysis: its beat grid and detail waveform.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackAnalysisView {
    grid_bpm: Option<f64>,
    first_beat: f64,
    bar_offset: u8,
    duration: f64,
    /// Columns per second of `detail`.
    rate: f64,
    /// Each whiteness << 5 | height, as on a CDJ.
    detail: Vec<u8>,
}

/// The kept beat grid and waveform of a track; `None` until it has been analysed.
#[tauri::command]
async fn track_analysis(
    state: State<'_, AppState>,
    track_id: i64,
) -> Result<Option<TrackAnalysisView>, Error> {
    let (fp, stored) = with_db!(state, |c| {
        db::audio_fp_of(c, track_id).map(|fp| {
            let stored = fp.as_deref().and_then(|fp| anlz::load(c, fp));
            (fp, stored)
        })
    })?;
    let stored = match (stored, fp) {
        (Some(s), _) => Some(s),
        // Analysed on another device: the waveform comes from the sharing destination.
        (None, Some(fp)) => {
            fetch_shared_waveform(&state, &fp).await;
            with_db!(state, |c| Ok::<_, Error>(anlz::load(c, &fp)))?
        }
        (None, None) => None,
    };
    Ok(stored.map(|s| TrackAnalysisView {
        grid_bpm: s.grid_bpm,
        first_beat: s.first_beat,
        bar_offset: s.bar_offset,
        duration: s.duration,
        rate: analysis::WAVEFORM_RATE,
        detail: s.detail,
    }))
}

/// Asks the sharing destination for the waveform of audio that has an analysis here but no
/// waveform (it was analysed on another device). Failing is fine: the song shows without one.
async fn fetch_shared_waveform(state: &AppState, audio_fp: &str) {
    let place = state.db.lock().ok().and_then(|c| {
        let waiting = c
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM analysis WHERE audio_fp = ?1 AND waveform IS NULL)",
                [audio_fp],
                |r| r.get::<_, bool>(0),
            )
            .unwrap_or(false);
        if !waiting {
            return None;
        }
        shared_place_of(&c).ok().flatten()
    });
    let fetched = match place {
        Some(SharedPlace::Target(target)) => {
            sync::fetch_waveform(&state.http, &target, &state.db, &state.wf_misses, audio_fp).await
        }
        Some(SharedPlace::Folder(root)) => {
            let store = libsync::folder::FolderStore::new(&root);
            libsync::waveforms::fetch(&state.db, &store, &state.wf_misses, audio_fp).await
        }
        None => return,
    };
    if let Err(e) = fetched {
        log::debug!("no waveform from the shared library: {e}");
    }
}

/// Replaces a track's kept beat grid, as edited in the grid editor, and makes its BPM match.
/// USB exports and the rekordbox file use the edited grid from then on.
#[tauri::command]
async fn set_beat_grid(
    state: State<'_, AppState>,
    track_id: i64,
    grid_bpm: Option<f64>,
    first_beat: f64,
    bar_offset: u8,
) -> Result<Option<TrackAnalysisView>, Error> {
    let Some(fp) = with_db!(state, |c| db::audio_fp_of(c, track_id))? else {
        return Err(Error::Msg(
            "This song has no audio to keep a grid for.".into(),
        ));
    };
    let stored = with_db!(state, |c| {
        let mut s = anlz::load(c, &fp).ok_or_else(|| {
            Error::Msg("Analyze the song first; there is no grid to edit yet.".into())
        })?;
        s.set_grid(grid_bpm, first_beat, bar_offset);
        anlz::save(c, &fp, &s)?;
        Ok::<_, Error>(s)
    })?;
    with_db!(state, |c| {
        if let Some(bpm) = stored.grid_bpm {
            db::set_tempo_key(c, track_id, Some(Some(bpm)), None)?;
        }
        db::mark_grid_edited(c, track_id)
    })?;
    Ok(Some(TrackAnalysisView {
        grid_bpm: stored.grid_bpm,
        first_beat: stored.first_beat,
        bar_offset: stored.bar_offset,
        duration: stored.duration,
        rate: analysis::WAVEFORM_RATE,
        detail: stored.detail,
    }))
}

/// The cues set in manplay for a song; empty when there are none.
#[tauri::command]
fn track_cues(state: State<'_, AppState>, track_id: i64) -> Result<Vec<db::Cue>, Error> {
    with_db!(state, |c| {
        match db::audio_fp_of(c, track_id)? {
            Some(fp) => Ok(db::cues_of(c, &fp)?.unwrap_or_default()),
            None => Ok(Vec::new()),
        }
    })
}

/// Replaces a song's cues. From then on they go into the rekordbox file and onto USB drives,
/// replacing the cues already there.
#[tauri::command]
fn set_track_cues(
    state: State<'_, AppState>,
    track_id: i64,
    cues: Vec<db::Cue>,
) -> Result<(), Error> {
    with_db!(state, |c| db::set_cues(c, track_id, &cues))
}

#[tauri::command]
fn service_flags(state: State<'_, AppState>) -> Result<Vec<(String, String)>, Error> {
    with_db!(state, |c| db::service_flags(c))
}

#[tauri::command]
fn set_service_enabled(state: State<'_, AppState>, id: String, enabled: bool) -> Result<(), Error> {
    with_db!(state, |c| db::set_service_enabled(c, &id, enabled))
}

#[tauri::command]
fn activity_history(
    state: State<'_, AppState>,
    source: String,
    limit: i64,
) -> Result<Vec<db::Activity>, Error> {
    with_db!(state, |c| db::activity_history(c, &source, limit))
}

#[tauri::command]
fn dismiss_activity(state: State<'_, AppState>, ids: Vec<i64>) -> Result<(), Error> {
    with_db!(state, |c| db::dismiss_activity(c, &ids))
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0))
}

fn collect_items(conn: &Connection) -> Result<Vec<sync::Item>, Error> {
    let Some(root) = db::get_setting(conn, SETTING_ROOT)? else {
        return Err(Error::Msg(
            "library folder unknown: click Scan folder in Library once, then sync".to_owned(),
        ));
    };
    let root = Path::new(&root);
    let mut items: Vec<sync::Item> = db::all_track_rows(conn)?
        .into_iter()
        .filter(|t| t.missing_since.is_none())
        .filter_map(|t| {
            let local = PathBuf::from(&t.path);
            // Files deleted since the last scan are skipped rather than reported as failures.
            let meta = std::fs::metadata(&local).ok()?;
            let size = meta.len();
            let modified = sync::modified_secs(&meta);
            Some(sync::Item {
                track_id: t.id,
                rel: rel_path(root, &t.path)?,
                local,
                size,
                identity: sync::library_identity(t.audio_fp, t.fingerprint),
                modified,
            })
        })
        .collect();
    items.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(items)
}

/// Every library path (present or missing) that maps onto a destination, for recognising which
/// destination files belong to tracks that are only missing for now.
fn collect_known(conn: &Connection) -> Result<HashMap<Vec<String>, sync::Known>, Error> {
    let Some(root) = db::get_setting(conn, SETTING_ROOT)? else {
        return Ok(HashMap::new());
    };
    let root = Path::new(&root);
    let cutoff = unix_now() - GRACE_SECS;
    Ok(db::all_track_rows(conn)?
        .into_iter()
        .filter_map(|t| {
            let known = sync::Known {
                track_id: t.id,
                missing: t.missing_since.is_some(),
                in_grace: t.missing_since.is_some_and(|m| m > cutoff),
            };
            Some((rel_path(root, &t.path)?, known))
        })
        .collect())
}

/// Clears the "sync running" flag even if the sync future is dropped or errors.
struct SyncGuard<'a>(&'a AtomicBool);

impl Drop for SyncGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// A running sync job: the "sync running" flag, and the destinations to itself once a background
/// read in progress has finished.
struct SyncClaim<'a> {
    _flag: SyncGuard<'a>,
    _io: tokio::sync::MutexGuard<'a, ()>,
    _libsync: tokio::sync::MutexGuard<'a, ()>,
}

async fn claim_sync(state: &AppState) -> Result<SyncClaim<'_>, Error> {
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a sync is already running".to_owned()));
    }
    let flag = SyncGuard(&state.syncing);
    let io = state.destination_io.lock().await;
    let libsync = state.libsync_io.lock().await;
    Ok(SyncClaim {
        _flag: flag,
        _io: io,
        _libsync: libsync,
    })
}

/// This device, as a destination lock names it to other devices.
fn lock_owner(state: &AppState) -> Result<sync::lock::Owner, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    Ok(sync::lock::Owner {
        device: sync::lock::DeviceId(libsync::write::device_id(&conn)?),
        name: libsync::membership::device_name(&conn)?,
    })
}

/// Queues destinations for a background read; `urgent` ones are read next.
fn queue_scans(app: &AppHandle, ids: &[i64], urgent: bool, depth: ReadDepth) -> Result<(), Error> {
    let state = app.state::<AppState>();
    state
        .scans
        .lock()
        .map_err(|_| Error::Lock)?
        .enqueue(ids, urgent, depth);
    state.scan_wake.notify_one();
    let _ = app.emit("sync-scan", ());
    Ok(())
}

fn queue_all_scans(app: &AppHandle, depth: ReadDepth) -> Result<(), Error> {
    let state = app.state::<AppState>();
    let ids: Vec<i64> = with_db!(state, |c| db::list_targets(c))?
        .iter()
        .map(|t| t.id)
        .collect();
    queue_scans(app, &ids, false, depth)
}

/// Reads the destinations in the background, one at a time: every destination in full at launch,
/// a quick check of each every [`sync_scans::RESCAN_INTERVAL`] and after the library changed,
/// and any queued by [`queue_scans`]. Waits while a sync runs, so a review is never compared with
/// a destination halfway through a change; a sync that starts during a read stops it.
async fn scan_worker(app: AppHandle) {
    let state = app.state::<AppState>();
    if let Err(e) = queue_all_scans(&app, ReadDepth::Full) {
        log::warn!("could not queue destination reads: {e}");
    }
    let mut last_round = std::time::Instant::now();
    loop {
        let settled = library_settled(&state);
        if settled || last_round.elapsed() >= sync_scans::RESCAN_INTERVAL {
            last_round = std::time::Instant::now();
            if let Err(e) = queue_all_scans(&app, ReadDepth::Quick) {
                log::warn!("could not queue destination reads: {e}");
            }
        }
        if state.syncing.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        }
        let next = state.scans.lock().ok().and_then(|mut s| s.start_next());
        let Some((id, depth)) = next else {
            let _ = tokio::time::timeout(next_wake(&state, last_round), state.scan_wake.notified())
                .await;
            continue;
        };
        let _ = app.emit("sync-scan", ());
        let read = tokio::select! {
            read = async {
                let _io = state.destination_io.lock().await;
                scan_target(&app, &state, id, depth).await
            } => Some(read),
            () = sync_started(&state) => None,
        };
        let Some(read) = read else {
            // Stopped for a sync: read again once it is done.
            if let Ok(mut store) = state.scans.lock() {
                store.abandon();
                store.enqueue(&[id], true, depth);
            }
            let _ = app.emit("sync-scan", ());
            continue;
        };
        if let Ok(mut store) = state.scans.lock() {
            match read {
                Ok(DestinationRead::Read(read)) => {
                    let FreshRead {
                        scan,
                        stored,
                        stamp,
                    } = *read;
                    store.finish(scan, stored, stamp, unix_now());
                }
                Ok(DestinationRead::Unchanged) => {}
                Ok(DestinationRead::Gone) => store.abandon(),
                Err(e) => {
                    log::warn!("reading destination {id} failed: {e}");
                    store.abandon();
                }
            }
        }
        let _ = app.emit("sync-scan", ());
    }
}

/// Whether the library changed and has been still for [`sync_scans::LIBRARY_SETTLE`]; clears the
/// change when it has.
fn library_settled(state: &AppState) -> bool {
    let Ok(mut changed) = state.library_changed.lock() else {
        return false;
    };
    let settled = changed.is_some_and(|at| at.elapsed() >= sync_scans::LIBRARY_SETTLE);
    if settled {
        *changed = None;
    }
    settled
}

/// How long the background reader can sleep: until the next round, or until a library change
/// has settled.
fn next_wake(state: &AppState, last_round: std::time::Instant) -> std::time::Duration {
    let round = sync_scans::RESCAN_INTERVAL.saturating_sub(last_round.elapsed());
    let settle = state
        .library_changed
        .lock()
        .ok()
        .and_then(|c| *c)
        .map(|at| sync_scans::LIBRARY_SETTLE.saturating_sub(at.elapsed()));
    settle.map_or(round, |s| s.min(round))
}

/// Resolves once a sync has started, so a background read gives way to it.
async fn sync_started(state: &AppState) {
    while !state.syncing.load(Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

/// What a read of one destination compares it with, taken from the database in one go.
struct ScanInputs {
    root: PathBuf,
    items: Vec<sync::Item>,
    known: HashMap<Vec<String>, sync::Known>,
    synced_at: HashMap<i64, i64>,
    cached: HashMap<(String, u64), String>,
    bases: HashMap<i64, db::Base>,
    signatures: sync::SignatureCache,
    library: sync_scans::KnownLibrary,
    /// `(path, size)` of every track on disk.
    present: Vec<(String, i64)>,
}

impl ScanInputs {
    /// What a [`sync_scans::ReadStamp`] holds of the library, with `bases` as they are now.
    fn library_hash(&self, bases: &HashMap<i64, db::Base>) -> sync_scans::LibraryHash {
        sync_scans::LibraryHash::of(
            &sync_scans::LibraryDigest::of(&self.items, &self.known),
            &self.synced_at,
            bases,
            &self.present,
        )
    }
}

fn scan_inputs(conn: &Connection, target_id: i64) -> Result<ScanInputs, Error> {
    let root = db::get_setting(conn, SETTING_ROOT)?.ok_or_else(|| {
        Error::Msg(
            "library folder unknown: click Scan folder in Library once, then sync".to_owned(),
        )
    })?;
    let items = collect_items(conn)?;
    // An empty library would propose deleting everything on the destination.
    if items.is_empty() {
        return Err(Error::Msg(
            "no tracks under the library folder to sync".to_owned(),
        ));
    }
    let known = collect_known(conn)?;
    let synced_at = db::synced_times(conn, target_id)?;
    let bases = db::synced_bases(conn, target_id)?;
    let present = db::present_sizes(conn)?;
    Ok(ScanInputs {
        root: PathBuf::from(root),
        items,
        known,
        synced_at,
        cached: db::remote_prints(conn, target_id)?
            .into_iter()
            .filter(|(_, print)| sync::is_identity(print))
            .collect(),
        bases,
        signatures: db::remote_signatures(conn, target_id)?,
        library: sync_scans::KnownLibrary::of(&present),
        present,
    })
}

/// What a background read of one destination came to.
enum DestinationRead {
    /// The destination was removed.
    Gone,
    /// A quick read found nothing changed; the latest read stands.
    Unchanged,
    Read(Box<FreshRead>),
}

/// A new read to store, with what it compared when a quick read can keep it.
struct FreshRead {
    scan: sync_scans::TargetScan,
    stored: sync_scans::StoredPlan,
    stamp: Option<sync_scans::ReadStamp>,
}

impl FreshRead {
    /// A read that could not start, e.g. the library folder is unknown.
    fn failed(target: &SyncTarget, plan_id: sync_scans::PlanId, now: i64, reason: String) -> Self {
        let plan = sync::TargetPlan::failed(target, reason.clone());
        Self {
            scan: sync_scans::TargetScan {
                target_id: target.id,
                plan_id: plan_id.clone(),
                scanned_at: now,
                plan: plan.clone(),
                pull: sync_scans::PullScan::failed(reason),
            },
            stored: sync_scans::StoredPlan {
                id: plan_id,
                target_id: target.id,
                scanned_at: now,
                library: sync_scans::LibraryDigest::of(&[], &HashMap::new()),
                plan,
            },
            stamp: None,
        }
    }
}

/// Reads one destination: what a push would do and what the library lacks. Changes nothing on
/// the destination; remembers fingerprints and bases it learned. A quick read stops after listing
/// the destination when nothing changed since the latest read.
async fn scan_target(
    app: &AppHandle,
    state: &AppState,
    target_id: i64,
    depth: ReadDepth,
) -> Result<DestinationRead, Error> {
    let (target, inputs) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        let Some(target) = db::get_targets(&conn, Some(&[target_id]))?
            .into_iter()
            .next()
        else {
            return Ok(DestinationRead::Gone);
        };
        let inputs = scan_inputs(&conn, target_id);
        (target, inputs)
    };
    let now = unix_now();
    let plan_id = state
        .scans
        .lock()
        .map_err(|_| Error::Lock)?
        .new_plan_id(now);
    let inputs = match inputs {
        Ok(inputs) => inputs,
        Err(e) => {
            let read = FreshRead::failed(&target, plan_id, now, e.to_string());
            return Ok(DestinationRead::Read(Box::new(read)));
        }
    };
    let listing = sync::list_remote(&state.scan_http, &target).await;
    let stamp_with = |bases: &HashMap<i64, db::Base>| {
        listing
            .as_deref()
            .ok()
            .and_then(|remote| sync_scans::ReadStamp::of(remote, inputs.library_hash(bases)))
    };
    if let (ReadDepth::Quick, Some(stamp)) = (depth, stamp_with(&inputs.bases)) {
        let confirmed =
            state
                .scans
                .lock()
                .map_err(|_| Error::Lock)?
                .confirm(target_id, stamp, unix_now());
        if confirmed {
            return Ok(DestinationRead::Unchanged);
        }
    }
    let pull = match &listing {
        Ok(remote) => sync_scans::PullScan {
            total: remote.len(),
            missing: sync_scans::missing_files(remote, &inputs.root, &inputs.library),
            error: None,
        },
        Err(e) => sync_scans::PullScan::failed(e.to_string()),
    };
    let mut next_id = state.next_action_id.load(Ordering::SeqCst);
    let mut plan = sync::plan_target(
        app,
        &state.scan_http,
        &target,
        &sync::Inputs {
            items: &inputs.items,
            known: &inputs.known,
            synced_at: &inputs.synced_at,
            cached: &inputs.cached,
            bases: &inputs.bases,
            signatures: &inputs.signatures,
        },
        listing.as_deref(),
        &mut next_id,
    )
    .await;
    state.next_action_id.store(next_id, Ordering::SeqCst);
    // Same audio in another folder is already in the library, whatever the name or path.
    let mut pull = pull;
    pull.missing
        .retain(|m| !plan.in_library.contains(&m.file.rel));
    let bases = remember_read(state, target.id, &mut plan, listing.is_ok()).await?;
    // New bases change no plan (their files match), so the stamp counts them as already there.
    let stamp = stamp_with(bases.as_ref().unwrap_or(&inputs.bases));
    let scan = sync_scans::TargetScan {
        target_id,
        plan_id: plan_id.clone(),
        scanned_at: now,
        plan: plan.clone(),
        pull,
    };
    let stored = sync_scans::StoredPlan {
        id: plan_id,
        target_id,
        scanned_at: now,
        library: sync_scans::LibraryDigest::of(&inputs.items, &inputs.known),
        plan,
    };
    // A read that failed part way is tried in full again rather than kept by a quick read.
    let stamp = stamp.filter(|_| scan.plan.error.is_none() && scan.pull.error.is_none());
    Ok(DestinationRead::Read(Box::new(FreshRead {
        scan,
        stored,
        stamp,
    })))
}

/// Stores what a read learned about a destination: fingerprints, signatures (when it could be
/// listed) and bases for files found identical, so the next review knows who edits what. Returns
/// the destination's bases when new ones were stored.
async fn remember_read(
    state: &AppState,
    target_id: i64,
    plan: &mut sync::TargetPlan,
    listed: bool,
) -> Result<Option<HashMap<i64, db::Base>>, Error> {
    {
        let mut conn = state.db.lock().map_err(|_| Error::Lock)?;
        if !plan.fresh_prints.is_empty() {
            db::store_remote_prints(&conn, target_id, &plan.fresh_prints)?;
        }
        if listed {
            db::replace_remote_signatures(&mut conn, target_id, &plan.signatures)?;
        }
    }
    let seeds = sync::seed_bases(std::mem::take(&mut plan.seeds)).await;
    if seeds.is_empty() {
        return Ok(None);
    }
    let mut conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::store_bases(&mut conn, target_id, &seeds)?;
    Ok(Some(db::synced_bases(&conn, target_id)?))
}

/// What the background reads found for each destination, and which are queued or being read.
#[tauri::command]
fn sync_scans(state: State<'_, AppState>) -> Result<sync_scans::ScanStatus, Error> {
    let ignores = with_db!(state, |c| db::sync_ignores(c))?;
    Ok(state
        .scans
        .lock()
        .map_err(|_| Error::Lock)?
        .status(&ignores))
}

/// The latest read of one destination in full, if it has been read yet, without the files the
/// user ignored there.
#[tauri::command]
fn sync_scan(
    state: State<'_, AppState>,
    target_id: i64,
) -> Result<Option<sync_ignore::ShownScan>, Error> {
    let ignores = with_db!(state, |c| db::sync_ignores(c))?;
    let list = ignores.get(&target_id).cloned().unwrap_or_default();
    Ok(state
        .scans
        .lock()
        .map_err(|_| Error::Lock)?
        .latest(target_id)
        .map(|scan| sync_ignore::shown(scan, &list)))
}

/// Leaves destination-only files or folders out of a destination's review from now on.
#[tauri::command]
fn sync_ignore(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: i64,
    rules: Vec<sync_ignore::IgnoreRule>,
) -> Result<(), Error> {
    with_db!(state, |c| db::add_sync_ignores(
        c,
        target_id,
        &rules,
        unix_now()
    ))?;
    let _ = app.emit("sync-scan", ());
    Ok(())
}

/// Shows ignored files or folders in a destination's review again.
#[tauri::command]
fn sync_unignore(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: i64,
    rules: Vec<sync_ignore::IgnoreRule>,
) -> Result<(), Error> {
    with_db!(state, |c| db::remove_sync_ignores(c, target_id, &rules))?;
    let _ = app.emit("sync-scan", ());
    Ok(())
}

/// Reads the given destinations again, before any other waiting.
#[tauri::command]
fn sync_rescan(app: AppHandle, target_ids: Vec<i64>) -> Result<(), Error> {
    queue_scans(&app, &target_ids, true, ReadDepth::Full)
}

/// Executes the actions the user confirmed from the reviewed plans (see [`scan_target`]). Each
/// plan is used once, and refused when it is older than [`sync_scans::MAX_PLAN_AGE_SECS`] or the
/// library tracks it was compared with have changed. Anything that would be overwritten or
/// deleted is copied to the app's backup folder first.
#[tauri::command]
async fn sync_apply(
    app: AppHandle,
    state: State<'_, AppState>,
    plan_ids: Vec<sync_scans::PlanId>,
    action_ids: Vec<u32>,
    resolutions: Option<HashMap<u32, sync::Resolution>>,
) -> Result<Vec<sync::ApplySummary>, Error> {
    let plans = state
        .scans
        .lock()
        .map_err(|_| Error::Lock)?
        .take(&plan_ids, unix_now())?;
    let claim = claim_sync(&state).await;
    // Taking the plans dropped these destinations' reads. Queued once this sync holds the
    // destinations, they are read again after it, whatever its outcome.
    let ids: Vec<i64> = plans.iter().map(|p| p.target_id).collect();
    queue_scans(&app, &ids, true, ReadDepth::Full)?;
    let _claim = claim?;
    {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        let items = collect_items(&conn)?;
        let known = collect_known(&conn)?;
        if plans
            .iter()
            .any(|p| !p.library.still_matches(&items, &known))
        {
            return Err(Error::Msg(sync_scans::OUT_OF_DATE.to_owned()));
        }
    }
    let selected: HashSet<u32> = action_ids.into_iter().collect();
    let review = Confirmed {
        selected: &selected,
        resolutions: &resolutions.unwrap_or_default(),
    };
    let summaries = apply_plans(&app, &state, &plans, &review).await?;
    let synced: Vec<i64> = summaries.iter().map(|s| s.target_id).collect();
    tauri::async_runtime::spawn(jellyfin_after_sync(app.clone(), synced));
    Ok(summaries)
}

/// The actions the user ticked, and how they settled merges and conflicts.
struct Confirmed<'a> {
    selected: &'a HashSet<u32>,
    resolutions: &'a HashMap<u32, sync::Resolution>,
}

async fn apply_plans(
    app: &AppHandle,
    state: &AppState,
    plans: &[sync_scans::StoredPlan],
    confirmed: &Confirmed<'_>,
) -> Result<Vec<sync::ApplySummary>, Error> {
    let Confirmed {
        selected,
        resolutions,
    } = *confirmed;

    let root = library_root(state)?;
    let ids: Vec<i64> = plans.iter().map(|p| p.target_id).collect();
    let targets = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        // Safety net for the library records, taken before anything on a destination changes.
        db::backup(
            &conn,
            &state.data_dir.join("backups"),
            unix_now(),
            BACKUPS_KEEP,
        )?;
        db::get_targets(&conn, Some(&ids))?
    };
    let owner = lock_owner(state)?;
    let backups = state.data_dir.join("sync-backups");
    let batch = unix_now();
    let backup_dir = backups.join(format!("{batch:012}"));
    let mut summaries = Vec::new();
    for tp in plans.iter().map(|p| &p.plan) {
        let Some(target) = targets.iter().find(|t| t.id == tp.target_id) else {
            continue;
        };
        if tp.error.is_some() || !tp.actions.iter().any(|a| selected.contains(&a.id)) {
            continue;
        }
        let started_at = unix_now();
        let review = sync::Review {
            selected,
            resolutions,
            backup_dir: &backup_dir,
            root: &root,
        };
        let held = match sync::lock::acquire(&state.http, target, &owner).await {
            Ok(held) => held,
            Err(e) => {
                summaries.push(sync::ApplySummary::refused(
                    target.id,
                    tp.name.clone(),
                    e.to_string(),
                ));
                continue;
            }
        };
        let applied = sync::apply_target(app, &state.http, target, tp, &review).await;
        held.release().await;
        let s = &applied.summary;
        let record = db::RunRecord {
            target_id: target.id,
            started_at,
            finished_at: unix_now(),
            uploaded: s.uploaded + s.moved + s.merged,
            skipped: tp.in_sync,
            failed: s.failed_total,
            deleted: s.deleted,
            first_error: s.failed.first().cloned(),
            errors: s.failed.clone(),
            batch,
        };
        let mut conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::record_run(&mut conn, &record, &applied.present, &applied.removed)?;
        // Destination files are now matched by content, so old-location bookkeeping is moot.
        let old_places = db::stale_for(&conn, target.id)?;
        db::clear_stale(&conn, target.id, &old_places)?;
        drop(conn);
        summaries.push(applied.summary);
    }

    // Library files rewritten by an update or merge: read them again.
    if summaries.iter().any(|s| s.updated + s.merged > 0) {
        scan_and_store(state, root, ScanDepth::Changed).await?;
    }
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    purge_expired(&conn, &state.data_dir.join("backups"), unix_now())?;
    sync::prune_backups(&backups, unix_now(), SYNC_BACKUP_KEEP_SECS);
    Ok(summaries)
}

/// Clashes waiting for the user: two items with one name.
#[tauri::command]
fn list_clashes(state: State<'_, AppState>) -> Result<Vec<libsync::clashes::Clash>, Error> {
    with_db!(state, |c| libsync::clashes::list(c))
}

/// Shared items deleted in the last 90 days, newest first.
#[tauri::command]
fn list_recently_deleted(
    state: State<'_, AppState>,
) -> Result<Vec<libsync::recent::Deleted>, Error> {
    with_db!(state, |c| libsync::recent::list(
        c,
        libsync::clock::now_ms()
    ))
}

/// Takes a deleted item back with its old uid and its songs.
#[tauri::command]
fn restore_deleted(state: State<'_, AppState>, kind: String, uid: String) -> Result<(), Error> {
    with_db!(state, |c| libsync::recent::restore(
        c,
        &kind,
        &uid,
        libsync::clock::now_ms()
    ))
}

/// What combining the two sides of a clash would share and remove.
#[tauri::command]
fn clash_combine_preview(
    state: State<'_, AppState>,
    id: i64,
) -> Result<libsync::clashes::CombinePreview, Error> {
    with_db!(state, |c| libsync::clashes::combine_preview(c, id))
}

/// Settles a clash: combine the two, or rename one side (`new_name`).
#[tauri::command]
fn resolve_clash(
    state: State<'_, AppState>,
    id: i64,
    choice: libsync::clashes::Choice,
    new_name: Option<String>,
) -> Result<(), Error> {
    with_db!(state, |c| libsync::clashes::resolve(
        c,
        id,
        choice,
        new_name.as_deref()
    ))
}

/// What sharing a local tag, playlist or smart playlist would send.
#[tauri::command]
fn share_preview(
    state: State<'_, AppState>,
    kind: String,
    id: i64,
) -> Result<libsync::share::SharePreview, Error> {
    with_db!(state, |c| libsync::share::share_preview(c, &kind, id))
}

/// Makes a local item shared. `tags` says what to do with each local tag a smart playlist uses.
#[tauri::command]
fn share_item(
    state: State<'_, AppState>,
    kind: String,
    id: i64,
    tags: std::collections::BTreeMap<String, libsync::share::TagChoice>,
) -> Result<(), Error> {
    with_db!(state, |c| libsync::share::share(c, &kind, id, &tags))
}

/// Which shared smart playlists would lose a rule if the tag became private.
#[tauri::command]
fn private_preview(
    state: State<'_, AppState>,
    kind: String,
    id: i64,
) -> Result<libsync::share::PrivatePreview, Error> {
    with_db!(state, |c| libsync::share::private_preview(c, &kind, id))
}

/// Makes a shared item private: others lose it, this device keeps a local copy.
#[tauri::command]
fn make_private(
    state: State<'_, AppState>,
    kind: String,
    id: i64,
    remove_rules: bool,
) -> Result<(), Error> {
    with_db!(state, |c| libsync::share::make_private(
        c,
        &kind,
        id,
        remove_rules
    ))
}

/// Hides an item on this device only, or shows it again.
#[tauri::command]
fn set_item_hidden(
    state: State<'_, AppState>,
    kind: String,
    id: i64,
    hidden: bool,
) -> Result<(), Error> {
    with_db!(state, |c| libsync::share::set_hidden(c, &kind, id, hidden))
}

/// Local tags the rules (as the editor shows them) use, for a smart playlist that is shared.
#[tauri::command]
fn smart_local_tags(
    state: State<'_, AppState>,
    rules: smart::Rules,
) -> Result<Vec<libsync::share::LocalTagUse>, Error> {
    with_db!(state, |c| libsync::share::local_tags_of_editor_rules(
        c, &rules
    ))
}

/// What a destination holds: a shared library with its members, or none.
#[tauri::command]
async fn libsync_inspect(
    state: State<'_, AppState>,
    target_id: i64,
) -> Result<Option<libsync::membership::Found>, Error> {
    let target = shared_target(&state, target_id)?;
    sync::inspect_library(&state.http, &target, &state.db).await
}

/// Joins the shared library on a destination, or starts one there, and syncs it once.
#[tauri::command]
async fn libsync_join(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: i64,
    choice: libsync::membership::JoinChoice,
) -> Result<sync::LibraryOutcome, Error> {
    let _claim = claim_sync(&state).await?;
    let target = shared_target(&state, target_id)?;
    state.wf_misses.clear();
    let out = sync::join_library(&state.http, &target, &state.db, choice).await?;
    let target = shared_target(&state, target_id)?;
    tauri::async_runtime::spawn(transfer_waveforms(app, SharedPlace::Target(target)));
    Ok(out)
}

/// Leaves the shared library. `sync` sends and receives one last time first.
#[tauri::command]
async fn libsync_leave(
    state: State<'_, AppState>,
    choice: libsync::membership::LeaveChoice,
    sync: bool,
) -> Result<(), Error> {
    let _claim = claim_sync(&state).await?;
    match shared_place(&state)? {
        Some(SharedPlace::Target(target)) => {
            sync::leave_library(&state.http, &target, &state.db, choice, sync).await
        }
        Some(SharedPlace::Folder(root)) => {
            let store = libsync::folder::FolderStore::new(&root);
            libsync::membership::leave(&state.db, &store, choice, sync).await
        }
        None => Err(Error::Msg(
            "This device is not in a shared library.".to_owned(),
        )),
    }
}

/// Where this device's shared library is kept, with what is needed to reach it.
#[derive(Debug, Clone)]
enum SharedPlace {
    Target(db::SyncTarget),
    /// The library folder, by its path.
    Folder(PathBuf),
}

fn shared_place(state: &AppState) -> Result<Option<SharedPlace>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    shared_place_of(&conn)
}

fn shared_place_of(conn: &rusqlite::Connection) -> Result<Option<SharedPlace>, Error> {
    Ok(match libsync::membership::home(conn)? {
        Some(libsync::membership::Home::Target(id)) => db::list_targets(conn)?
            .into_iter()
            .find(|t| t.id == id)
            .map(SharedPlace::Target),
        Some(libsync::membership::Home::Folder) => db::get_setting(conn, SETTING_ROOT)?
            .map(PathBuf::from)
            .map(SharedPlace::Folder),
        None => None,
    })
}

/// Where this device's shared library is kept, as the settings show it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum LibraryHome {
    None,
    #[serde(rename_all = "camelCase")]
    Target {
        target_id: i64,
        name: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Folder {
        root: String,
        name: Option<String>,
    },
}

#[tauri::command]
fn libsync_home(state: State<'_, AppState>) -> Result<LibraryHome, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    let name = libsync::membership::library_name(&conn)?;
    Ok(match libsync::membership::home(&conn)? {
        Some(libsync::membership::Home::Target(target_id)) => {
            LibraryHome::Target { target_id, name }
        }
        Some(libsync::membership::Home::Folder) => LibraryHome::Folder {
            root: db::get_setting(&conn, SETTING_ROOT)?.unwrap_or_default(),
            name,
        },
        None => LibraryHome::None,
    })
}

/// The name a library started in the library folder gets: the folder's own name.
fn folder_label(root: &Path) -> String {
    root.file_name()
        .and_then(|n| n.to_str())
        .map_or_else(|| "Library".to_owned(), str::to_owned)
}

/// What the library folder holds: a shared library other computers keep there (its members), or
/// none. Reads `.manplay/library.json` and `devices/`; writes nothing.
#[tauri::command]
async fn libsync_inspect_folder(
    state: State<'_, AppState>,
) -> Result<Option<libsync::membership::Found>, Error> {
    let root = library_root(&state)?;
    let store = libsync::folder::FolderStore::new(&root);
    libsync::membership::inspect(&state.db, &store).await
}

/// Joins the shared library in the library folder, or starts one there, and syncs it once.
#[tauri::command]
async fn libsync_join_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    choice: libsync::membership::JoinChoice,
) -> Result<libsync::remote::RunSummary, Error> {
    let _claim = claim_sync(&state).await?;
    let root = library_root(&state)?;
    if !root.is_dir() {
        return Err(Error::Msg(format!(
            "The library folder {} cannot be reached.",
            root.display()
        )));
    }
    let owner = lock_owner(&state)?;
    let held = sync::lock::acquire_folder(&root, &owner).await?;
    state.wf_misses.clear();
    let store = libsync::folder::FolderStore::new(&root);
    let home = libsync::membership::Home::Folder;
    let out =
        libsync::membership::join(&state.db, home, &store, choice, &folder_label(&root)).await;
    held.release().await;
    let out = out?;
    tauri::async_runtime::spawn(transfer_waveforms(app, SharedPlace::Folder(root)));
    Ok(out)
}

fn shared_target(state: &AppState, id: i64) -> Result<db::SyncTarget, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::list_targets(&conn)?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| Error::Msg("That destination no longer exists.".to_owned()))
}

/// The name other members see this device as.
#[tauri::command]
fn get_device_name(state: State<'_, AppState>) -> Result<String, Error> {
    with_db!(state, |c| libsync::membership::device_name(c))
}

/// Names this device; an empty name goes back to the machine's own.
#[tauri::command]
fn set_device_name(state: State<'_, AppState>, name: String) -> Result<String, Error> {
    with_db!(state, |c| {
        libsync::membership::set_device_name(c, &name)?;
        libsync::membership::device_name(c)
    })
}

/// Shares library data with the destinations that have it switched on: sends this device's
/// edits and applies everyone else's. Run before the files of a sync.
#[tauri::command]
async fn libsync_run(
    app: AppHandle,
    state: State<'_, AppState>,
    target_ids: Vec<i64>,
) -> Result<Vec<sync::LibraryOutcome>, Error> {
    let _claim = claim_sync(&state).await?;
    let targets = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::get_targets(&conn, Some(&target_ids))?
    };
    let mut out = Vec::new();
    for target in targets.into_iter().filter(|t| t.libsync) {
        let outcome = sync_shared_target(&app, &state, target).await;
        remember_library_sync(&app, &state, LastLibrarySync::of_outcome(&outcome));
        out.push(outcome);
    }
    Ok(out)
}

/// One sync of the shared library kept on `target`, under the destination's lock; the waveforms
/// follow in the background.
async fn sync_shared_target(
    app: &AppHandle,
    state: &AppState,
    target: db::SyncTarget,
) -> sync::LibraryOutcome {
    let owner = match lock_owner(state) {
        Ok(owner) => owner,
        Err(e) => return sync::LibraryOutcome::failed(&target, e.to_string()),
    };
    state.wf_misses.clear();
    let held = match sync::lock::acquire(&state.http, &target, &owner).await {
        Ok(held) => held,
        Err(e) => return sync::LibraryOutcome::failed(&target, e.to_string()),
    };
    let outcome = sync::run_library_data(&state.http, &target, &state.db).await;
    held.release().await;
    if outcome.error.is_none() {
        follow_shared_files(state).await;
        tauri::async_runtime::spawn(transfer_waveforms(app.clone(), SharedPlace::Target(target)));
    }
    outcome
}

/// One sync of the shared library kept in the library folder `root`, under the folder's lock;
/// the waveforms follow in the background.
async fn sync_shared_folder(
    app: &AppHandle,
    state: &AppState,
    root: PathBuf,
) -> libsync::remote::RunSummary {
    let out = run_shared_folder(state, &root).await;
    if out.error.is_none() {
        follow_shared_files(state).await;
        tauri::async_runtime::spawn(transfer_waveforms(app.clone(), SharedPlace::Folder(root)));
    }
    out
}

/// The sync itself of [`sync_shared_folder`]: takes the folder's lock, exchanges edits, gives
/// the lock back.
async fn run_shared_folder(state: &AppState, root: &Path) -> libsync::remote::RunSummary {
    let failed = |error: String| libsync::remote::RunSummary {
        error: Some(error),
        ..libsync::remote::RunSummary::default()
    };
    if !root.is_dir() {
        return failed(format!(
            "The library folder {} cannot be reached.",
            root.display()
        ));
    }
    let owner = match lock_owner(state) {
        Ok(owner) => owner,
        Err(e) => return failed(e.to_string()),
    };
    let held = match sync::lock::acquire_folder(root, &owner).await {
        Ok(held) => held,
        Err(e) => return failed(e.to_string()),
    };
    state.wf_misses.clear();
    let store = libsync::folder::FolderStore::new(root);
    let out = libsync::membership::run_joined(&state.db, &store, &folder_label(root)).await;
    held.release().await;
    out
}

/// Unix time in seconds, UTC.
type UnixSeconds = i64;

/// How the shared library's last sync went.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LastLibrarySync {
    at: UnixSeconds,
    /// This device's edits sent.
    sent: usize,
    /// Other devices' edits applied here.
    received: usize,
    error: Option<String>,
}

impl LastLibrarySync {
    fn of_summary(summary: &libsync::remote::RunSummary) -> Self {
        Self {
            at: unix_now(),
            sent: summary.sent,
            received: summary.received,
            error: summary.error.clone(),
        }
    }

    fn of_outcome(outcome: &sync::LibraryOutcome) -> Self {
        Self {
            at: unix_now(),
            sent: outcome.sent,
            received: outcome.received,
            error: outcome.error.clone(),
        }
    }
}

/// Keeps how a sync of the shared library went and tells the window (`libsync-synced`), which
/// shows what arrived.
fn remember_library_sync(app: &AppHandle, state: &AppState, last: LastLibrarySync) {
    let _ = app.emit("libsync-synced", &last);
    if let Ok(mut slot) = state.libsync_last.lock() {
        *slot = Some(last);
    }
}

/// The shared library, as the settings show its syncing.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LibrarySyncStatus {
    /// Whether it syncs on its own.
    auto: bool,
    last: Option<LastLibrarySync>,
    /// Deletions another device made that wait for the user's word.
    hold: Option<libsync::brake::Hold>,
}

#[tauri::command]
fn libsync_status(state: State<'_, AppState>) -> Result<LibrarySyncStatus, Error> {
    let last = state.libsync_last.lock().map_err(|_| Error::Lock)?.clone();
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    Ok(LibrarySyncStatus {
        auto: libsync::auto::enabled(&conn)?,
        last,
        hold: libsync::brake::waiting(&conn)?,
    })
}

/// Switches the shared library's own syncing on or off. Off, it syncs when asked and with a
/// Sync of its destination.
#[tauri::command]
fn libsync_set_auto(state: State<'_, AppState>, on: bool) -> Result<(), Error> {
    with_db!(state, |c| libsync::auto::set_enabled(c, on))?;
    state.libsync_wake.notify_one();
    Ok(())
}

/// Asks for a sync of the shared library now; it runs in the background.
#[tauri::command]
fn libsync_sync_now(state: State<'_, AppState>) {
    ask_library_sync(&state);
}

fn ask_library_sync(state: &AppState) {
    state.libsync_asked.store(true, Ordering::SeqCst);
    state.libsync_wake.notify_one();
}

/// Settles the deletions a sync held back: let them through, or keep the items (they are
/// restored for everyone). The sync that carries it out starts at once.
#[tauri::command]
fn libsync_decide_deletes(
    state: State<'_, AppState>,
    choice: libsync::brake::Decision,
) -> Result<(), Error> {
    with_db!(state, |c| libsync::brake::decide(c, choice))?;
    ask_library_sync(&state);
    Ok(())
}

/// What other devices' edits changed here in the last 30 days, one entry per sync, newest first.
#[tauri::command]
fn list_library_changes(state: State<'_, AppState>) -> Result<Vec<libsync::journal::Batch>, Error> {
    with_db!(state, |c| libsync::journal::list(
        c,
        libsync::clock::now_ms()
    ))
}

/// Takes one sync's changes back, for everyone.
#[tauri::command]
fn undo_library_changes(
    state: State<'_, AppState>,
    batch: libsync::journal::BatchId,
) -> Result<libsync::journal::Undone, Error> {
    let undone = with_db!(state, |c| libsync::journal::undo(
        c,
        batch,
        libsync::clock::now_ms()
    ))?;
    ask_library_sync(&state);
    Ok(undone)
}

/// Keeps the shared library in sync on its own while the app is open (see `libsync::auto` for
/// when). It gives way to a sync the user started and never runs beside one.
async fn libsync_worker(app: AppHandle) {
    let state = app.state::<AppState>();
    let mut pace = libsync::auto::Pace::default();
    let mut last_try: Option<std::time::Instant> = None;
    loop {
        let asked = state.libsync_asked.swap(false, Ordering::SeqCst);
        let focused = state.libsync_focused.swap(false, Ordering::SeqCst);
        match due_library_sync(&state, pace, last_try, asked, focused) {
            Ok(Some(home)) => {
                if let Some(last) = auto_sync_library(&app, &state, home).await {
                    if last.error.is_some() {
                        pace.failed();
                    } else {
                        pace.succeeded();
                    }
                    last_try = Some(std::time::Instant::now());
                    remember_library_sync(&app, &state, last);
                } else if asked {
                    // Another sync is running: what was asked for is done after it.
                    state.libsync_asked.store(true, Ordering::SeqCst);
                }
            }
            Ok(None) => {}
            Err(e) => log::warn!("could not check whether the shared library is due: {e}"),
        }
        let _ = tokio::time::timeout(libsync::auto::TICK, state.libsync_wake.notified()).await;
    }
}

/// Where the shared library is kept, when it should sync now.
fn due_library_sync(
    state: &AppState,
    pace: libsync::auto::Pace,
    last_try: Option<std::time::Instant>,
    asked: bool,
    focused: bool,
) -> Result<Option<SharedPlace>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    let auto = libsync::auto::enabled(&conn)?;
    if !auto && !asked {
        return Ok(None);
    }
    let moment = libsync::auto::Moment {
        since_last: last_try.map(|at| at.elapsed()),
        unsent_age: libsync::auto::unsent_age(&conn, libsync::clock::now_ms())?,
        asked: asked || focused,
    };
    if !pace.due(moment) {
        return Ok(None);
    }
    shared_place_of(&conn)
}

/// The right to sync the shared library on its own, held until dropped. `None` while a sync the
/// user started is running or another library sync holds the library.
fn library_sync_slot(state: &AppState) -> Option<tokio::sync::MutexGuard<'_, ()>> {
    let slot = state.libsync_io.try_lock().ok()?;
    if state.syncing.load(Ordering::SeqCst) {
        return None;
    }
    Some(slot)
}

/// One sync of the shared library at `place`. `None` when a sync the user started is running or
/// another library sync holds the library: the next look tries again.
async fn auto_sync_library(
    app: &AppHandle,
    state: &AppState,
    place: SharedPlace,
) -> Option<LastLibrarySync> {
    let _slot = library_sync_slot(state)?;
    Some(match place {
        SharedPlace::Target(target) => {
            LastLibrarySync::of_outcome(&sync_shared_target(app, state, target).await)
        }
        SharedPlace::Folder(root) => {
            LastLibrarySync::of_summary(&sync_shared_folder(app, state, root).await)
        }
    })
}

/// Uploads this device's waveforms and downloads everyone else's after a sync, all of them, in
/// the background, with `waveform-progress` events for the status bar. Problems are only logged:
/// what is left goes after the next sync, and a missing waveform is fetched when its song shows.
async fn transfer_waveforms(app: AppHandle, place: SharedPlace) {
    let state = app.state::<AppState>();
    if state.wf_filling.swap(true, Ordering::SeqCst) {
        // The running transfer goes round again for what this sync brought.
        state.wf_again.store(true, Ordering::SeqCst);
        return;
    }
    let _guard = SyncGuard(&state.wf_filling);
    loop {
        state.wf_again.store(false, Ordering::SeqCst);
        let report = |p: libsync::waveforms::Progress| {
            let _ = app.emit("waveform-progress", p);
        };
        let (moved, where_) = match &place {
            SharedPlace::Target(target) => (
                sync::transfer_waveforms(&state.http, target, &state.db, &state.wf_misses, report)
                    .await,
                sync::target_name(target),
            ),
            SharedPlace::Folder(root) => (
                libsync::waveforms::transfer(
                    &state.db,
                    &libsync::folder::FolderStore::new(root),
                    &state.wf_misses,
                    sync::WAVEFORM_BATCH,
                    sync::FILL_PAUSE,
                    report,
                )
                .await,
                "the library folder".to_owned(),
            ),
        };
        match moved {
            Ok(t) => {
                log::info!(
                    "waveforms on {where_}: {} sent, {} fetched",
                    t.sent,
                    t.fetched
                );
                if let Some(e) = t.upload_error {
                    log::warn!("waveform uploads stopped early: {e}");
                }
            }
            Err(e) => {
                log::warn!("could not move waveforms: {e}");
                let _ = app.emit("waveform-progress", libsync::waveforms::Progress::done());
            }
        }
        if !state.wf_again.load(Ordering::SeqCst) {
            break;
        }
    }
}

#[tauri::command]
fn is_syncing(state: State<'_, AppState>) -> bool {
    state.syncing.load(Ordering::SeqCst)
}

// ---- file browser ------------------------------------------------------------

fn library_root(state: &AppState) -> Result<PathBuf, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::get_setting(&conn, SETTING_ROOT)?
        .map(PathBuf::from)
        .ok_or_else(|| Error::Msg("choose a library folder in Library first".to_owned()))
}

#[tauri::command]
async fn fs_list(state: State<'_, AppState>, path: PathBuf) -> Result<Vec<fsops::FsEntry>, Error> {
    let root = library_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || fsops::list(&root, &path))
        .await
        .map_err(|e| Error::Msg(e.to_string()))?
}

/// Size of each subfolder of a library folder, by name. Slow on big folders, so the file
/// browser asks for it separately from the listing.
#[tauri::command]
async fn fs_dir_sizes(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<HashMap<String, u64>, Error> {
    let root = library_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || fsops::dir_sizes(&root, &path))
        .await
        .map_err(|e| Error::Msg(e.to_string()))?
}

/// Rescans so the database follows a change on disk: renamed and moved files keep their
/// tags and playlists (see `detect_moves`). The change itself already succeeded, so a failed
/// rescan is only logged.
async fn refresh_after_fs_change(state: &AppState, root: PathBuf) {
    if let Err(e) = scan_and_store(state, root, ScanDepth::Changed).await {
        log::warn!("rescan after file change failed: {e}");
    }
}

/// Runs a file picker read off the main thread: a slow disk or network share must not freeze
/// the window.
async fn picker_task<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| Error::Msg(e.to_string()))?
}

/// The text on the clipboard, for Paste in the app's own text-field menu; empty when it holds
/// none. Read here because the webview asks the user with a system bubble before it reads.
#[tauri::command]
async fn clipboard_read_text(app: AppHandle) -> Result<String, Error> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    Ok(app.clipboard().read_text().unwrap_or_default())
}

/// The folders the file picker's sidebar offers: the user's own, then every disk.
#[tauri::command]
async fn picker_places(app: AppHandle) -> Result<Vec<file_picker::Place>, Error> {
    use file_picker::PlaceKind;
    let paths = app.path();
    let personal = [
        (PlaceKind::Home, paths.home_dir()),
        (PlaceKind::Desktop, paths.desktop_dir()),
        (PlaceKind::Documents, paths.document_dir()),
        (PlaceKind::Downloads, paths.download_dir()),
        (PlaceKind::Music, paths.audio_dir()),
    ]
    .into_iter()
    .filter_map(|(kind, path)| path.ok().map(|path| (kind, path)))
    .collect();
    picker_task(move || Ok(file_picker::places(personal))).await
}

#[tauri::command]
async fn picker_list(path: PathBuf) -> Result<file_picker::Listing, Error> {
    picker_task(move || file_picker::list(&path)).await
}

#[tauri::command]
async fn picker_make_dir(parent: PathBuf, name: String) -> Result<PathBuf, Error> {
    picker_task(move || file_picker::make_dir(&parent, &name)).await
}

/// The bytes of a picture picked for a cover, as the response body.
#[tauri::command]
async fn picker_read_image(path: PathBuf) -> Result<tauri::ipc::Response, Error> {
    picker_task(move || file_picker::read_image(&path))
        .await
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn fs_make_dir(
    state: State<'_, AppState>,
    parent: PathBuf,
    name: String,
) -> Result<PathBuf, Error> {
    let root = library_root(&state)?;
    Ok(fsops::make_dir(&root, &parent, &name)?)
}

#[tauri::command]
async fn fs_rename(
    state: State<'_, AppState>,
    path: PathBuf,
    new_name: String,
) -> Result<PathBuf, Error> {
    let root = library_root(&state)?;
    let to = fsops::rename(&root, &path, &new_name)?;
    refresh_after_fs_change(&state, root).await;
    Ok(to)
}

#[tauri::command]
async fn fs_copy(
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
    dest: PathBuf,
) -> Result<Vec<PathBuf>, Error> {
    let root = library_root(&state)?;
    let created = fsops::copy_into(&root, &paths, &dest)?;
    refresh_after_fs_change(&state, root).await;
    Ok(created)
}

/// Shows a file or folder of the library in Finder.
#[tauri::command]
async fn fs_reveal(state: State<'_, AppState>, path: PathBuf) -> Result<(), Error> {
    let root = library_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || fsops::reveal(&root, &path))
        .await
        .map_err(|e| Error::Msg(e.to_string()))?
}

/// Moves to the system Trash. The songs that went are marked missing at once, and the shared
/// library hears they were deleted on purpose (`libsync::files::deleted_here`).
#[tauri::command]
async fn fs_trash(state: State<'_, AppState>, paths: Vec<PathBuf>) -> Result<(), Error> {
    let root = library_root(&state)?;
    let r = root.clone();
    let doomed = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        tracks_below(&conn, &paths)?
    };
    tauri::async_runtime::spawn_blocking(move || fsops::trash(&r, &paths))
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;
    {
        let gone: Vec<i64> = doomed
            .into_iter()
            .filter(|(_, path)| !path.exists())
            .map(|(id, _)| id)
            .collect();
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        libsync::files::deleted_here(&conn, &root, &gone, unix_now())?;
    }
    refresh_after_fs_change(&state, root).await;
    Ok(())
}

#[tauri::command]
async fn fs_move(
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
    dest: PathBuf,
) -> Result<(), Error> {
    let root = library_root(&state)?;
    fsops::move_into(&root, &paths, &dest)?;
    refresh_after_fs_change(&state, root).await;
    Ok(())
}

/// Whether the player should load `path` through `pcm://` (AIFF and ALAC on Windows, whose
/// webview cannot decode them).
#[tauri::command]
async fn playback_needs_decoding(path: PathBuf) -> bool {
    tauri::async_runtime::spawn_blocking(move || playback::needs_decoding(&path))
        .await
        .unwrap_or(false)
}

/// Opens the macOS Full Disk Access pane, for when the system blocks the library folder.
/// Windows has no such permission, so there it does nothing.
#[tauri::command]
fn open_privacy_settings() -> Result<(), Error> {
    #[cfg(target_os = "macos")]
    process::command("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        .spawn()?;
    Ok(())
}

// ---- tag editor --------------------------------------------------------------

/// Values already used in the library for a tag field, for the editor's pick lists.
#[tauri::command]
fn tag_values(state: State<'_, AppState>, field: String) -> Result<Vec<db::TagValue>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::tag_values(&conn, &field)
}

/// Adds a value to a tag field's pick list before any song uses it.
#[tauri::command]
fn tag_value_create(state: State<'_, AppState>, field: String, value: String) -> Result<(), Error> {
    if !tags::SUGGEST.contains(&field.as_str()) {
        return Err(Error::Msg(format!("cannot manage values of: {field}")));
    }
    let value = value.trim();
    if value.is_empty() {
        return Err(Error::Msg("a value needs a name".to_owned()));
    }
    with_db!(state, |c| db::create_tag_value(c, &field, value))
}

/// Replaces (or, with `to` unset, removes) values of a tag field in every song of the library.
#[tauri::command]
async fn tag_values_migrate(
    state: State<'_, AppState>,
    field: String,
    from: Vec<String>,
    to: Option<String>,
) -> Result<audit::FixReport, Error> {
    let root = library_root(&state)?;
    let to = to.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
    if state.fixing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a fix is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.fixing);
    {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::migrate_custom_values(&conn, &field, &from, to.as_deref())?;
    }
    let r = root.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        tags::migrate(&r, &field, &from, to.as_deref())
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))??;
    refresh_after_fs_change(&state, root).await;
    Ok(report)
}

/// Tags shared by every song at or under `paths` (songs and/or folders).
#[tauri::command]
async fn tags_read(
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
) -> Result<tags::TagView, Error> {
    let root = library_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || tags::read(&root, &paths))
        .await
        .map_err(|e| Error::Msg(e.to_string()))?
}

/// What a tag edit would change per song, without writing anything.
#[tauri::command]
async fn tags_preview(
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
    edits: std::collections::BTreeMap<String, String>,
) -> Result<tags::Preview, Error> {
    let root = library_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || tags::preview(&root, &paths, &edits))
        .await
        .map_err(|e| Error::Msg(e.to_string()))?
}

/// Looks up the songs at or under `paths` in `MusicBrainz` and says, per song, which tags it
/// would give. Nothing is written. Emits `lookup-progress`; stops early on [`cancel_tag_lookup`],
/// returning the songs done so far.
#[tauri::command]
async fn tags_lookup(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
    refresh: bool,
) -> Result<Vec<lookup::SongLookup>, Error> {
    lookup_allowed(&state)?;
    let root = library_root(&state)?;
    if state.lookup.running.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a tag lookup is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.lookup.running);
    state.lookup.cancelled.store(false, Ordering::SeqCst);

    let files = tauri::async_runtime::spawn_blocking(move || tags::songs(&root, &paths))
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;
    let source = lookup::musicbrainz::MusicBrainz::new(&state.http, &state.lookup.pace);
    let discogs = discogs(&state);
    let cache = lookup::Cache::new(&state.db, unix_now());
    let total = files.len();
    let mut looked_up = Vec::with_capacity(total);
    for (done, file) in files.into_iter().enumerate() {
        if state.lookup.cancelled.load(Ordering::SeqCst) {
            break;
        }
        let _ = app.emit("lookup-progress", lookup::Progress { done, total });
        let path = file.clone();
        let song = tauri::async_runtime::spawn_blocking(move || lookup::read_song(&path))
            .await
            .map_err(|e| Error::Msg(e.to_string()))?;
        looked_up.push(lookup::song(&source, discogs.as_ref(), &cache, &file, song, refresh).await);
    }
    let _ = app.emit(
        "lookup-progress",
        lookup::Progress {
            done: looked_up.len(),
            total,
        },
    );
    Ok(looked_up)
}

/// Stops the running tag lookup after the song in progress.
#[tauri::command]
fn cancel_tag_lookup(state: State<'_, AppState>) {
    state.lookup.cancelled.store(true, Ordering::SeqCst);
}

const SETTING_LIBRARY_VIEW: &str = "library_view";

/// Library tab last used (`albums`, `songs` or `artists`), so it is open again after leaving.
#[tauri::command]
fn get_library_view(state: State<'_, AppState>) -> Result<Option<String>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::get_setting(&conn, SETTING_LIBRARY_VIEW)
}

#[tauri::command]
fn set_library_view(state: State<'_, AppState>, view: String) -> Result<(), Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::set_setting(&conn, SETTING_LIBRARY_VIEW, Some(&view))
}

const SETTING_PANEL_TABS: &str = "panel_tabs";

/// Tabs last picked in the song and album views (JSON), so the next one opens on the same tab.
#[tauri::command]
fn get_panel_tabs(state: State<'_, AppState>) -> Result<Option<String>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::get_setting(&conn, SETTING_PANEL_TABS)
}

#[tauri::command]
fn set_panel_tabs(state: State<'_, AppState>, tabs: String) -> Result<(), Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::set_setting(&conn, SETTING_PANEL_TABS, Some(&tabs))
}

/// A display preference (JSON) such as how a list is sorted, kept under `ui.<name>`.
#[tauri::command]
fn get_ui_setting(state: State<'_, AppState>, name: String) -> Result<Option<String>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::get_setting(&conn, &format!("ui.{name}"))
}

#[tauri::command]
fn set_ui_setting(state: State<'_, AppState>, name: String, value: String) -> Result<(), Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::set_setting(&conn, &format!("ui.{name}"), Some(&value))
}

const SETTING_TAG_CLIPBOARD: &str = "tag_clipboard";

/// Tags copied in the Files view (JSON), kept across restarts. `None` when nothing is copied.
#[tauri::command]
fn get_tag_clipboard(state: State<'_, AppState>) -> Result<Option<String>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::get_setting(&conn, SETTING_TAG_CLIPBOARD)
}

#[tauri::command]
fn set_tag_clipboard(state: State<'_, AppState>, json: Option<String>) -> Result<(), Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::set_setting(&conn, SETTING_TAG_CLIPBOARD, json.as_deref())
}

/// Writes tag edits (field -> value, empty clears) to one song or every song under a folder.
#[tauri::command]
async fn tags_write(
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
    edits: std::collections::BTreeMap<String, String>,
) -> Result<audit::FixReport, Error> {
    let root = library_root(&state)?;
    if state.fixing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a fix is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.fixing);
    let r = root.clone();
    let report = tauri::async_runtime::spawn_blocking(move || tags::write(&r, &paths, &edits))
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;
    refresh_after_fs_change(&state, root).await;
    Ok(report)
}

/// One song's tag edits, for [`tags_write_many`].
#[derive(serde::Deserialize)]
struct TagWrite {
    path: PathBuf,
    edits: std::collections::BTreeMap<String, String>,
}

/// Writes several songs' edits in one go (one rescan), used to undo a tag edit.
#[tauri::command]
async fn tags_write_many(
    state: State<'_, AppState>,
    items: Vec<TagWrite>,
) -> Result<audit::FixReport, Error> {
    let root = library_root(&state)?;
    if state.fixing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a fix is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.fixing);
    let r = root.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let mut total = audit::FixReport::default();
        for item in items {
            let one = tags::write(&r, std::slice::from_ref(&item.path), &item.edits)?;
            total.fixed += one.fixed;
            total.failed.extend(one.failed);
        }
        Ok::<_, Error>(total)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))??;
    refresh_after_fs_change(&state, root).await;
    Ok(report)
}

/// Sets the front cover of a song, or of every song under a folder, from raw image bytes
/// (the request body). The target path travels URL-encoded in the `x-path` header.
#[tauri::command]
async fn tags_set_cover(
    app: AppHandle,
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<tags::CoverReport, Error> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::Msg("expected image bytes".to_owned()));
    };
    let bytes = bytes.clone();
    // Songs and/or folders, as a percent-encoded JSON array.
    let paths: Vec<PathBuf> = request
        .headers()
        .get("x-paths")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| percent_encoding::percent_decode_str(v).decode_utf8().ok())
        .and_then(|p| serde_json::from_str(&p).ok())
        .ok_or_else(|| Error::Msg("missing paths".to_owned()))?;
    write_cover(&app, &state, paths, bytes).await
}

/// Writes `bytes` as the front cover of the songs at or under `paths`, then drops their saved
/// thumbnails and rescans.
async fn write_cover(
    app: &AppHandle,
    state: &State<'_, AppState>,
    paths: Vec<PathBuf>,
    bytes: Vec<u8>,
) -> Result<tags::CoverReport, Error> {
    let root = library_root(state)?;
    if state.fixing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a fix is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.fixing);
    let (r, backups) = (root.clone(), cover_backups(state));
    let (files, report) = tauri::async_runtime::spawn_blocking(move || {
        tags::write_cover(&r, &paths, &bytes, &backups)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))??;
    covers_changed(app, state, &files, root).await;
    Ok(report)
}

/// Where the covers that were replaced are kept, so a cover change can be undone.
fn cover_backups(state: &AppState) -> PathBuf {
    state.data_dir.join("cover-backups")
}

/// After covers were rewritten: drops the songs' saved thumbnails and rescans.
async fn covers_changed(
    app: &AppHandle,
    state: &State<'_, AppState>,
    files: &[PathBuf],
    root: PathBuf,
) {
    if let Ok(dir) = app.path().app_cache_dir().map(|d| d.join("art")) {
        for f in files {
            art::forget(f, &dir);
        }
    }
    refresh_after_fs_change(state, root).await;
}

/// Puts back the covers a cover change replaced, from what that change reported.
#[tauri::command]
async fn tags_restore_covers(
    app: AppHandle,
    state: State<'_, AppState>,
    previous: Vec<tags::PreviousCover>,
) -> Result<audit::FixReport, Error> {
    let root = library_root(&state)?;
    if state.fixing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a fix is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.fixing);
    let (r, backups) = (root.clone(), cover_backups(&state));
    let (files, report) =
        tauri::async_runtime::spawn_blocking(move || tags::restore_covers(&r, &previous, &backups))
            .await
            .map_err(|e| Error::Msg(e.to_string()))??;
    covers_changed(&app, &state, &files, root).await;
    Ok(report)
}

fn lookup_allowed(state: &AppState) -> Result<(), Error> {
    if with_db!(state, |c| db::service_on(c, lookup::SERVICE))? {
        Ok(())
    } else {
        Err(Error::Msg(
            "Tag lookup is off. Turn it on in Settings to search MusicBrainz.".to_owned(),
        ))
    }
}

/// Discogs as a second place to look, when the user has saved a token for it.
fn discogs(state: &AppState) -> Option<lookup::discogs::Discogs<'_>> {
    let token = lookup::discogs::load_token().ok().flatten()?;
    Some(lookup::discogs::Discogs::new(
        &state.http,
        &state.lookup.discogs_pace,
        &state.lookup.discogs_pages,
        token,
    ))
}

/// The front cover of `release`, from the source that knows the release.
async fn fetch_cover(
    state: &AppState,
    release: &lookup::ReleaseId,
    size: lookup::CoverSize,
) -> Result<Vec<u8>, Error> {
    use lookup::Source;
    match release {
        lookup::ReleaseId::MusicBrainz(_) => {
            lookup::musicbrainz::MusicBrainz::new(&state.http, &state.lookup.pace)
                .cover(release, size)
                .await
        }
        lookup::ReleaseId::Discogs(_) => {
            discogs(state)
                .ok_or_else(|| {
                    Error::Msg("Enter a Discogs token in Settings to use its covers".to_owned())
                })?
                .cover(release, size)
                .await
        }
    }
}

/// Whether a Discogs token is saved, which is what makes lookups ask Discogs too.
#[tauri::command]
fn discogs_token_saved() -> Result<bool, Error> {
    Ok(lookup::discogs::load_token()?.is_some())
}

/// Saves the user's Discogs token in the keychain, once Discogs has accepted it.
#[tauri::command]
async fn discogs_token_save(state: State<'_, AppState>, token: String) -> Result<(), Error> {
    let token = lookup::discogs::Token::parse(&token)?;
    lookup::discogs::Discogs::new(
        &state.http,
        &state.lookup.discogs_pace,
        &state.lookup.discogs_pages,
        token.clone(),
    )
    .check_token()
    .await?;
    lookup::discogs::save_token(&token)
}

#[tauri::command]
fn discogs_token_forget() {
    lookup::discogs::forget_token();
}

/// Fetches the front cover of `release` and sets it on the songs at or under `paths`, in
/// place of any cover they have. The caller has shown the user the new cover first.
#[tauri::command]
async fn tags_lookup_cover(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
    release: lookup::ReleaseId,
) -> Result<tags::CoverReport, Error> {
    lookup_allowed(&state)?;
    let fetched = fetch_cover(&state, &release, lookup::CoverSize::Embedded).await?;
    let image = tauri::async_runtime::spawn_blocking(move || lookup::fit_cover(fetched))
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;
    write_cover(&app, &state, paths, image).await
}

/// Finds the releases of the album the songs at or under `paths` belong to, going by the first
/// song's tags, to choose a cover from. Nothing is written.
#[tauri::command]
async fn cover_search(
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
    refresh: bool,
) -> Result<lookup::CoverSearch, Error> {
    lookup_allowed(&state)?;
    let root = library_root(&state)?;
    let terms = tauri::async_runtime::spawn_blocking(move || {
        let songs = tags::songs(&root, &paths)?;
        Ok::<_, Error>(
            songs
                .first()
                .and_then(|song| lookup::read_song(song))
                .and_then(|song| lookup::ReleaseTerms::from_tags(&song.fields)),
        )
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))??
    .ok_or_else(|| {
        Error::Msg("Needs an album or title tag, and an artist, to search with".to_owned())
    })?;
    let source = lookup::musicbrainz::MusicBrainz::new(&state.http, &state.lookup.pace);
    let cache = lookup::Cache::new(&state.db, unix_now());
    lookup::cover_search(&source, discogs(&state).as_ref(), &cache, terms, refresh).await
}

/// The small cover a `lookup-cover://` request asks for, by release id: what a match's cover
/// looks like, shown before anything is written.
async fn lookup_cover_response(app: &AppHandle, uri_path: &str) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap_or_default()
    };
    let state = app.state::<AppState>();
    let raw = uri_path.strip_prefix('/').unwrap_or(uri_path);
    let Ok(release) = lookup::ReleaseId::try_from(raw.to_owned()) else {
        return not_found();
    };
    if lookup_allowed(&state).is_err() {
        return not_found();
    }
    let image = fetch_cover(&state, &release, lookup::CoverSize::Thumbnail).await;
    image.map_or_else(
        |_| not_found(),
        |bytes| {
            let png = bytes.starts_with(b"\x89PNG");
            tauri::http::Response::builder()
                .header("Content-Type", if png { "image/png" } else { "image/jpeg" })
                .header("Cache-Control", "max-age=86400")
                .body(bytes)
                .unwrap_or_default()
        },
    )
}

// ---- library health ----------------------------------------------------------

/// Lists files that break the library conventions (see `audit`).
#[tauri::command]
async fn audit_library(state: State<'_, AppState>) -> Result<Vec<audit::Issue>, Error> {
    let root = library_root(&state)?;
    let ffmpeg = convert::find_ffmpeg().is_some();
    tauri::async_runtime::spawn_blocking(move || audit::audit(&root, ffmpeg))
        .await
        .map_err(|e| Error::Msg(e.to_string()))?
}

/// Files one song under the artist and album the user typed.
#[tauri::command]
async fn audit_place(
    state: State<'_, AppState>,
    path: PathBuf,
    artist: String,
    album: String,
) -> Result<(), Error> {
    let root = library_root(&state)?;
    let r = root.clone();
    tauri::async_runtime::spawn_blocking(move || audit::place_file(&r, &path, &artist, &album))
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;
    refresh_after_fs_change(&state, root).await;
    Ok(())
}

/// Fixes the given files one by one; failures are reported per file and never undo the rest.
#[tauri::command]
async fn audit_fix(
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
) -> Result<audit::FixReport, Error> {
    let root = library_root(&state)?;
    if state.fixing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a fix is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.fixing);
    let r = root.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        audit::fix_all(&r, &paths, convert::find_ffmpeg().as_deref())
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?;
    refresh_after_fs_change(&state, root).await;
    Ok(report)
}

// ---- import folders ----------------------------------------------------------

/// Every import folder. The first time, the Downloads and iTunes sources from before are moved
/// into the list (see [`db::move_to_import_folders`]).
#[tauri::command]
fn import_folders(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<db::ImportFolder>, Error> {
    let downloads = app
        .path()
        .download_dir()
        .ok()
        .and_then(|p| p.to_str().map(str::to_owned));
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::move_to_import_folders(&conn, downloads.as_deref())?;
    db::import_folders(&conn)
}

/// Adds a folder to import from.
#[tauri::command]
fn import_add_folder(
    state: State<'_, AppState>,
    path: PathBuf,
    convert_aac: bool,
    auto_import: bool,
) -> Result<db::ImportFolder, Error> {
    if !path.is_dir() {
        return Err(Error::Msg(format!("not a folder: {}", path.display())));
    }
    let text = path
        .to_str()
        .ok_or_else(|| Error::Msg("path is not valid text".to_owned()))?;
    let folder = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::add_import_folder(&conn, text, convert_aac, auto_import)?
    };
    state.import_wake.notify_one();
    Ok(folder)
}

/// Saves a folder's switch and options.
#[tauri::command]
fn import_update_folder(state: State<'_, AppState>, folder: db::ImportFolder) -> Result<(), Error> {
    {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::update_import_folder(&conn, &folder)?;
    }
    state.import_wake.notify_one();
    Ok(())
}

/// Stops importing from a folder. Its files are never touched.
#[tauri::command]
fn import_remove_folder(state: State<'_, AppState>, id: db::ImportFolderId) -> Result<(), Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::remove_import_folder(&conn, id)
}

fn import_folder_of(state: &AppState, id: db::ImportFolderId) -> Result<db::ImportFolder, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::import_folder(&conn, id)
}

/// Looks through a folder (and inside zips) for music that is not in the library. Files that
/// have not changed since the last scan of this folder come from the cache unless `fresh`.
/// Emits `import-progress` events while it works.
#[tauri::command]
async fn import_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    folder: db::ImportFolderId,
    fresh: bool,
) -> Result<import::ImportScan, Error> {
    let folder = import_folder_of(&state, folder)?;
    scan_import_folder(&app, &state, Path::new(&folder.path), fresh).await
}

async fn scan_import_folder(
    app: &AppHandle,
    state: &AppState,
    folder: &Path,
    fresh: bool,
) -> Result<import::ImportScan, Error> {
    if !folder.is_dir() {
        return Err(Error::Msg(format!("not a folder: {}", folder.display())));
    }
    let key = folder.to_string_lossy().into_owned();
    let (known, cache, mut audio, unprinted, converted) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        let saved = if fresh {
            None
        } else {
            db::get_import_cache(&conn, &key)?
        };
        (
            db::content_index(&conn)?,
            saved
                .map(|j| import::Cache::from_json(&j))
                .unwrap_or_default(),
            db::audio_index(&conn)?,
            db::tracks_without_audio_fp(&conn)?,
            db::converted_sources(&conn)?,
        )
    };
    let app = app.clone();
    let folder = folder.to_path_buf();
    let (found, json, printed) = tauri::async_runtime::spawn_blocking(move || {
        let report = |p: &import::Progress| {
            let _ = app.emit("import-progress", p);
        };
        // Library songs not fingerprinted yet, once each, so retagged copies can be recognised.
        let mut printed = Vec::with_capacity(unprinted.len());
        for (n, (id, path)) in unprinted.into_iter().enumerate() {
            if n % 16 == 0 {
                report(&import::Progress {
                    phase: "library",
                    done: n,
                    total: printed.capacity(),
                });
            }
            let fp = audioprint::audio_print_path(Path::new(&path)).unwrap_or_default();
            if !fp.is_empty() {
                audio.insert(fp.clone(), path);
            }
            printed.push((id, fp));
        }
        audio.remove("");
        let opts = import::Options {
            cached_only: false,
            report: &report,
            same_audio: &audio,
            converted: &converted,
        };
        let (found, next) = import::scan(&folder, &known, &cache, &opts);
        (found, next.to_json(), printed)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?;
    let mut conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::set_audio_fps(&mut conn, &printed)?;
    db::put_import_cache(&conn, &key, &json)?;
    Ok(found)
}

/// Moves files, zips or folders from an import folder to the Trash. Only paths inside that
/// folder are accepted, and never the folder itself.
#[tauri::command]
async fn import_trash(
    state: State<'_, AppState>,
    folder: db::ImportFolderId,
    paths: Vec<PathBuf>,
) -> Result<(), Error> {
    let folder = import_folder_of(&state, folder)?;
    tauri::async_runtime::spawn_blocking(move || fsops::trash(Path::new(&folder.path), &paths))
        .await
        .map_err(|e| Error::Msg(e.to_string()))?
}

/// What the last scan of a folder found, rebuilt from the cache without reading any file.
/// `None` when the folder was never scanned.
#[tauri::command]
async fn import_cached(
    state: State<'_, AppState>,
    folder: db::ImportFolderId,
) -> Result<Option<import::ImportScan>, Error> {
    let folder = PathBuf::from(import_folder_of(&state, folder)?.path);
    let key = folder.to_string_lossy().into_owned();
    let (known, saved, audio, converted) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        (
            db::content_index(&conn)?,
            db::get_import_cache(&conn, &key)?,
            db::audio_index(&conn)?,
            db::converted_sources(&conn)?,
        )
    };
    let Some(json) = saved else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let opts = import::Options {
            cached_only: true,
            report: &|_| {},
            same_audio: &audio,
            converted: &converted,
        };
        let cache = import::Cache::from_json(&json);
        Some(import::scan(&folder, &known, &cache, &opts).0)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))
}

/// A local file the player can stream for an import candidate (zip entries are extracted
/// to the cache folder first).
#[tauri::command]
async fn import_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    folder: db::ImportFolderId,
    src: import::SourceRef,
) -> Result<String, Error> {
    let folder = PathBuf::from(import_folder_of(&state, folder)?.path);
    let dir = app.path().app_cache_dir()?.join("import-preview");
    let path = tauri::async_runtime::spawn_blocking(move || import::preview(&folder, &src, &dir))
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::Msg("path is not valid text".to_owned()))
}

/// Copies the chosen tracks into `library/Artist/Album/`, then rescans the library.
#[tauri::command]
async fn import_run(
    state: State<'_, AppState>,
    folder: db::ImportFolderId,
    groups: Vec<import::ImportRequest>,
) -> Result<import::ImportReport, Error> {
    let folder = import_folder_of(&state, folder)?;
    import_into_library(&state, &folder, groups).await
}

/// Covers from Apple for the bought songs among `groups` that come without one, when asking
/// Apple is switched on. Keyed by [`import::SourceRef::key`]. Songs in zips are left as they are.
async fn apple_covers_for(
    state: &AppState,
    groups: &[import::ImportRequest],
) -> HashMap<String, Vec<u8>> {
    let on = state
        .db
        .lock()
        .ok()
        .and_then(|c| db::service_on(&c, apple_art::SERVICE).ok())
        .unwrap_or(false);
    if !on {
        return HashMap::new();
    }
    let files: Vec<import::SourceRef> = groups
        .iter()
        .flat_map(|g| g.tracks.iter())
        .filter(|t| t.entry.is_none() && t.path.to_ascii_lowercase().ends_with(".m4a"))
        .cloned()
        .collect();
    let albums: Vec<(String, apple_art::AlbumId)> =
        tauri::async_runtime::spawn_blocking(move || {
            files
                .iter()
                .filter_map(|f| {
                    let bytes = std::fs::read(&f.path).ok()?;
                    if apple_art::has_cover(&bytes) {
                        return None;
                    }
                    apple_art::album_id(&bytes).map(|id| (f.key(), id))
                })
                .collect()
        })
        .await
        .unwrap_or_default();
    if albums.is_empty() {
        return HashMap::new();
    }
    let ids = albums.iter().map(|(_, id)| *id).collect();
    let found = match apple_art::covers(&state.http, &ids).await {
        Ok(found) => found,
        Err(e) => {
            log::warn!("could not fetch covers from Apple: {e}");
            return HashMap::new();
        }
    };
    albums
        .into_iter()
        .filter_map(|(key, id)| found.get(&id).map(|bytes| (key, bytes.clone())))
        .collect()
}

/// Brings the chosen songs of `folder` into the library as the folder says (converting AAC,
/// with covers from Apple when allowed), remembers converted songs, rescans the library and
/// records the run in the folder's history.
async fn import_into_library(
    state: &AppState,
    folder: &db::ImportFolder,
    groups: Vec<import::ImportRequest>,
) -> Result<import::ImportReport, Error> {
    let library = library_root(state)?;
    let ffmpeg = if folder.convert_aac {
        Some(convert::find_ffmpeg().ok_or_else(|| {
            Error::Msg("ffmpeg was not found, so AAC songs cannot be converted".to_owned())
        })?)
    } else {
        None
    };
    let started_at = unix_now();
    let items: Vec<String> = groups
        .iter()
        .filter(|g| !g.tracks.is_empty())
        .map(|g| format!("{} — {} ({} tracks)", g.artist, g.album, g.tracks.len()))
        .collect();
    let covers = apple_covers_for(state, &groups).await;
    let lib = library.clone();
    let source = PathBuf::from(&folder.path);
    let report = tauri::async_runtime::spawn_blocking(move || {
        let opts = import::RunOptions {
            convert_with: ffmpeg.as_deref(),
            covers,
        };
        import::run(&source, &lib, &groups, &opts)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?;
    {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        for c in &report.converted {
            db::record_converted(&conn, c, started_at)?;
        }
    }
    if report.imported > 0 {
        refresh_after_fs_change(state, library).await;
    }
    if report.imported > 0 || !report.failed.is_empty() {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::record_activity(
            &conn,
            &db::Activity {
                source: folder.id.activity_source(),
                started_at,
                finished_at: unix_now(),
                ok: i64::try_from(report.imported).unwrap_or(0),
                failed: i64::try_from(report.failed.len()).unwrap_or(0),
                items,
                errors: report
                    .failed
                    .iter()
                    .map(|f| format!("{}: {}", f.file, f.error))
                    .collect(),
                ..db::Activity::default()
            },
        )?;
    }
    Ok(report)
}

/// How often folders that import everything are looked at, besides when they are added or
/// changed and at launch.
const AUTO_IMPORT_EVERY: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Imports every new song from the folders set to import everything: at launch, whenever a
/// folder is added or changed, and every [`AUTO_IMPORT_EVERY`]. Songs come in as their folder
/// says, and new songs are then analysed like any other.
async fn auto_import_worker(app: AppHandle) {
    let state = app.state::<AppState>();
    tokio::time::sleep(std::time::Duration::from_secs(20)).await;
    loop {
        if let Err(e) = auto_import_once(&app, &state).await {
            log::warn!("automatic import failed: {e}");
        }
        let _ = tokio::time::timeout(AUTO_IMPORT_EVERY, state.import_wake.notified()).await;
    }
}

async fn auto_import_once(app: &AppHandle, state: &AppState) -> Result<(), Error> {
    if library_root(state).is_err() {
        return Ok(());
    }
    let folders = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::import_folders(&conn)?
    };
    for folder in folders.iter().filter(|f| f.enabled && f.auto_import) {
        let found = scan_import_folder(app, state, Path::new(&folder.path), false).await?;
        let groups: Vec<import::ImportRequest> = found
            .groups
            .into_iter()
            .map(|g| import::ImportRequest {
                tracks: g
                    .tracks
                    .into_iter()
                    .filter(|t| t.status == import::Status::New)
                    .map(|t| t.src)
                    .collect(),
                artist: g.artist,
                album: g.album,
                images: g.images,
            })
            .filter(|g| !g.tracks.is_empty())
            .collect();
        if !groups.is_empty() {
            import_into_library(state, folder, groups).await?;
            let _ = app.emit("import-folder-changed", folder.id);
        }
    }
    Ok(())
}

// ---- rekordbox ---------------------------------------------------------------

const SETTING_RB_PATH: &str = "rekordbox_xml_path";
const SETTING_RB_LAST: &str = "rekordbox_last_export";

/// What goes into the playlists part of the file: the chosen playlists, and each chosen tag as a
/// playlist. Before the first choice is saved, a file that exists holds every playlist (as manplay
/// used to export), so that is what it starts with.
fn rekordbox_selection_of(conn: &Connection) -> Result<db::ExportSelection, Error> {
    if let Some(saved) = db::export_selection(conn, db::RB_DESTINATION)? {
        return Ok(saved);
    }
    if db::get_setting(conn, SETTING_RB_PATH)?.is_none() {
        return Ok(db::ExportSelection::default());
    }
    Ok(db::ExportSelection {
        playlists: db::playlist_ids(conn)?,
        ..db::ExportSelection::default()
    })
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct RekordboxLast {
    exported_at: Option<i64>,
    playlists: usize,
    tracks: usize,
    error: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RekordboxStatus {
    path: Option<String>,
    #[serde(flatten)]
    last: RekordboxLast,
}

fn rekordbox_status_of(conn: &Connection) -> Result<RekordboxStatus, Error> {
    let last = db::get_setting(conn, SETTING_RB_LAST)?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    Ok(RekordboxStatus {
        path: db::get_setting(conn, SETTING_RB_PATH)?,
        last,
    })
}

fn store_last(conn: &Connection, last: &RekordboxLast) -> Result<(), Error> {
    let raw = serde_json::to_string(last).map_err(|e| Error::Msg(e.to_string()))?;
    db::set_setting(conn, SETTING_RB_LAST, Some(&raw))
}

/// Writes the rekordbox XML to the configured file, atomically so rekordbox never reads a
/// half-written library. `Ok(false)` when no file is configured. `record_ok` adds successful runs to the history; failures are always recorded.
fn export_inner(state: &AppState, record_ok: bool) -> Result<bool, Error> {
    let started_at = unix_now();
    let (path, tracks, playlists, tag_playlists, smart_playlists) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        let Some(path) = db::get_setting(&conn, SETTING_RB_PATH)? else {
            return Ok(false);
        };
        let selection = rekordbox_selection_of(&conn)?;
        let (mut tracks, mut playlists) = db::export_data(&conn)?;
        for t in &mut tracks {
            t.cues = t
                .audio_fp
                .as_deref()
                .map(|fp| db::cues_of(&conn, fp))
                .transpose()?
                .flatten()
                .unwrap_or_default();
            t.grid = t
                .audio_fp
                .as_deref()
                .and_then(|fp| anlz::load(&conn, fp))
                .and_then(|s| {
                    s.grid_bpm.map(|bpm| rekordbox::Grid {
                        bpm,
                        first_beat: s.first_beat,
                        bar_offset: s.bar_offset,
                    })
                });
        }
        playlists.retain(|p| p.id.is_none_or(|id| selection.playlists.contains(&id)));
        let tag_playlists = db::export_tag_playlists(&conn, &selection.tags)?;
        let smart_playlists = chosen_smart(&conn, &selection.smart)?;
        (
            PathBuf::from(path),
            tracks,
            playlists,
            tag_playlists,
            smart_playlists,
        )
    };
    let xml = rekordbox::build_xml(&tracks, &playlists, &tag_playlists, &smart_playlists);
    let tmp = path.with_extension("xml.tmp");
    let written = std::fs::write(&tmp, xml).and_then(|()| std::fs::rename(&tmp, &path));

    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    let mut last: RekordboxLast = rekordbox_status_of(&conn)?.last;
    match written {
        Ok(()) => {
            last = RekordboxLast {
                exported_at: Some(unix_now()),
                playlists: playlists.len() + tag_playlists.len() + smart_playlists.len(),
                tracks: tracks.len(),
                error: None,
            };
            store_last(&conn, &last)?;
            if record_ok {
                db::record_activity(
                    &conn,
                    &db::Activity {
                        source: "rekordbox".to_owned(),
                        started_at,
                        finished_at: unix_now(),
                        ok: i64::try_from(tracks.len()).unwrap_or(0),
                        items: vec![format!(
                            "{} tracks · {} playlists",
                            tracks.len(),
                            playlists.len() + tag_playlists.len() + smart_playlists.len()
                        )],
                        ..db::Activity::default()
                    },
                )?;
            }
            Ok(true)
        }
        Err(e) => {
            let msg = format!("could not write {}: {e}", path.display());
            last.error = Some(msg.clone());
            store_last(&conn, &last)?;
            db::record_activity(
                &conn,
                &db::Activity {
                    source: "rekordbox".to_owned(),
                    started_at,
                    finished_at: unix_now(),
                    failed: 1,
                    errors: vec![msg],
                    ..db::Activity::default()
                },
            )?;
            Err(Error::Io(e))
        }
    }
}

#[tauri::command]
fn rekordbox_status(state: State<'_, AppState>) -> Result<RekordboxStatus, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    rekordbox_status_of(&conn)
}

/// Chooses (or clears, with `None`) the XML file. Nothing is written until an export is asked for.
#[tauri::command]
fn rekordbox_set_path(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<RekordboxStatus, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::set_setting(&conn, SETTING_RB_PATH, path.as_deref())?;
    if path.is_none() {
        db::set_setting(&conn, SETTING_RB_LAST, None)?;
    }
    rekordbox_status_of(&conn)
}

#[tauri::command]
fn rekordbox_export(state: State<'_, AppState>) -> Result<RekordboxStatus, Error> {
    if !export_inner(&state, true)? {
        return Err(Error::Msg(
            "choose where to save the rekordbox file first".to_owned(),
        ));
    }
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    rekordbox_status_of(&conn)
}

/// What the configured rekordbox file holds right now, read back from disk. `None` before a file
/// is chosen or written.
#[tauri::command]
fn rekordbox_library(state: State<'_, AppState>) -> Result<Option<rekordbox::Library>, Error> {
    let path = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::get_setting(&conn, SETTING_RB_PATH)?
    };
    let Some(path) = path else {
        return Ok(None);
    };
    let xml = match std::fs::read_to_string(&path) {
        Ok(xml) => xml,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Error::Io(e)),
    };
    rekordbox::read_library(&xml).map(Some).map_err(Error::Msg)
}

#[tauri::command]
fn rekordbox_selection(state: State<'_, AppState>) -> Result<db::ExportSelection, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    rekordbox_selection_of(&conn)
}

/// Saves what to export and writes the file (recorded in the history).
#[tauri::command]
fn rekordbox_set_selection(
    state: State<'_, AppState>,
    selection: db::ExportSelection,
) -> Result<db::ExportSelection, Error> {
    {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::set_export_selection(&conn, db::RB_DESTINATION, &selection)?;
    }
    export_inner(&state, true)?;
    Ok(selection)
}

/// What an `art://` request asks for: a track id, or a path in the library (file browser).
enum ArtTarget {
    None,
    Track(i64),
    Path(PathBuf),
}

impl ArtTarget {
    fn parse(uri_path: &str) -> Self {
        let raw = uri_path.strip_prefix('/').unwrap_or(uri_path);
        if let Ok(id) = raw.parse::<i64>() {
            return Self::Track(id);
        }
        percent_encoding::percent_decode_str(raw)
            .decode_utf8()
            .map_or(Self::None, |p| Self::Path(PathBuf::from(p.as_ref())))
    }
}

/// The audio file whose artwork represents `path` (itself, or the first track inside a folder).
/// Only paths inside the library folder qualify, and songs on a mounted drive (for the review of
/// an export, which lists songs only the drive has).
fn fs_art_source(state: &AppState, path: &Path) -> Option<String> {
    if usb::on_drive(path)
        && !path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        && scan::is_audio(path)
        && path.is_file()
    {
        return path.to_str().map(str::to_owned);
    }
    let root = library_root(state).ok()?;
    let resolved = fsops::inside(&root, path).ok()?;
    let track = if resolved.is_dir() {
        fsops::first_audio(&resolved)?
    } else if scan::is_audio(&resolved) {
        resolved
    } else {
        return None;
    };
    track.to_str().map(str::to_owned)
}

fn art_response(app: &AppHandle, target: ArtTarget) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap_or_default()
    };
    let state = app.state::<AppState>();
    let path = match target {
        ArtTarget::None => None,
        ArtTarget::Track(id) => state
            .db
            .lock()
            .ok()
            .and_then(|c| db::track_path(&c, id).ok().flatten()),
        ArtTarget::Path(p) => fs_art_source(&state, &p),
    };
    let cache = app.path().app_cache_dir().map(|d| d.join("art"));
    let bytes = path
        .zip(cache.ok())
        .and_then(|(p, dir)| art::thumbnail(Path::new(&p), &dir));
    bytes.map_or_else(not_found, |b| {
        tauri::http::Response::builder()
            .header("Content-Type", "image/jpeg")
            .header("Cache-Control", "max-age=31536000")
            .body(b)
            .unwrap_or_default()
    })
}

/// # Panics
/// Panics if the Tauri application fails to start.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(clippy::expect_used)]
pub fn run() {
    launch_mark("the app started");
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Focused(true))
                && let Some(state) = window.try_state::<AppState>()
            {
                state.libsync_focused.store(true, Ordering::SeqCst);
                state.libsync_wake.notify_one();
            }
        })
        .on_page_load(|_, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                launch_mark("the page loaded");
            }
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .register_asynchronous_uri_scheme_protocol("art", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let target = ArtTarget::parse(request.uri().path());
            std::thread::spawn(move || responder.respond(art_response(&app, target)));
        })
        .register_asynchronous_uri_scheme_protocol("lookup-cover", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_owned();
            tauri::async_runtime::spawn(async move {
                responder.respond(lookup_cover_response(&app, &path).await);
            });
        })
        .register_asynchronous_uri_scheme_protocol("pcm", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_owned();
            let range = request
                .headers()
                .get("range")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            tauri::async_runtime::spawn_blocking(move || {
                let scope = app.asset_protocol_scope();
                responder.respond(playback::respond(&path, range.as_deref(), |p| {
                    scope.is_allowed(p)
                }));
            });
        })
        .register_asynchronous_uri_scheme_protocol("remote", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_owned();
            let range = request
                .headers()
                .get("range")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            tauri::async_runtime::spawn(async move {
                responder.respond(stream::respond(&app, &path, range.as_deref()).await);
            });
        })
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::open(&dir.join("library.db"))?;
            if let Some(root) = db::get_setting(&conn, SETTING_ROOT)? {
                allow_assets(app.handle(), Path::new(&root));
            }
            let http = reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(5))
                .build()
                .map_err(|e| Error::Msg(e.to_string()))?;
            let scan_http = reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(5))
                .read_timeout(sync_scans::STALLED_AFTER)
                .build()
                .map_err(|e| Error::Msg(e.to_string()))?;
            app.manage(AppState {
                db: Mutex::new(conn),
                data_dir: dir.clone(),
                http,
                scan_http,
                syncing: AtomicBool::new(false),
                fixing: AtomicBool::new(false),
                analyzing: AtomicBool::new(false),
                usb_exporting: AtomicBool::new(false),
                cancel_analysis: AtomicBool::new(false),
                lookup: lookup::Session::default(),
                scans: Mutex::new(sync_scans::ScanStore::default()),
                scan_wake: tokio::sync::Notify::new(),
                analysis_wake: tokio::sync::Notify::new(),
                import_wake: tokio::sync::Notify::new(),
                destination_io: tokio::sync::Mutex::new(()),
                next_action_id: AtomicU32::new(0),
                library_changed: Mutex::new(None),
                wf_misses: libsync::waveforms::Misses::default(),
                wf_filling: AtomicBool::new(false),
                wf_again: AtomicBool::new(false),
                jellyfin_plans: Mutex::new(HashMap::new()),
                jellyfin_pushing: tokio::sync::Mutex::new(()),
                libsync_io: tokio::sync::Mutex::new(()),
                libsync_wake: tokio::sync::Notify::new(),
                libsync_asked: AtomicBool::new(false),
                libsync_focused: AtomicBool::new(false),
                libsync_last: Mutex::new(None),
            });
            tauri::async_runtime::spawn(fill_audio_fps(app.handle().clone()));
            tauri::async_runtime::spawn(reprint_audio_fps(app.handle().clone()));
            tauri::async_runtime::spawn(scan_worker(app.handle().clone()));
            tauri::async_runtime::spawn(libsync_worker(app.handle().clone()));
            tauri::async_runtime::spawn(analysis_worker(app.handle().clone()));
            tauri::async_runtime::spawn(auto_import_worker(app.handle().clone()));
            launch_mark("the backend is set up");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_library,
            get_library_root,
            library_status,
            list_missing,
            list_duplicates,
            list_carry_candidates,
            carry_over,
            dismiss_carry,
            remove_missing_now,
            rescan_library,
            reset_library,
            list_tracks,
            analyze_tracks,
            cancel_analysis,
            is_analyzing,
            analysis_settings,
            set_analysis_settings,
            analysis_failures,
            usb_drives,
            playback_needs_decoding,
            usb_library,
            usb_formats,
            export_to_usb,
            usb_edit_playlists,
            usb_reset,
            usb_eject,
            usb_reveal,
            usb_backups,
            usb_delete_backups,
            set_beat_grid,
            track_cues,
            set_track_cues,
            track_analysis,
            is_exporting_to_usb,
            save_analysis_to_files,
            set_tempo_key,
            list_playlists,
            create_playlist,
            create_tag,
            default_scope,
            set_default_scope,
            rename_playlist,
            delete_playlist,
            add_to_playlist,
            remove_from_playlist,
            playlist_tracks,
            list_tags,
            tag_tracks,
            untag_track,
            delete_tag,
            migrate_library_tags,
            tailscale_status,
            drive_list,
            list_sync_targets,
            add_sync_target,
            add_r2_target,
            update_sync_target,
            libsync_inspect,
            libsync_inspect_folder,
            libsync_join_folder,
            libsync_status,
            libsync_set_auto,
            libsync_sync_now,
            libsync_decide_deletes,
            list_library_changes,
            list_file_removals,
            keep_file_removals,
            apply_file_removals,
            undo_library_changes,
            libsync_home,
            libsync_join,
            libsync_leave,
            get_device_name,
            set_device_name,
            list_clashes,
            list_recently_deleted,
            restore_deleted,
            clash_combine_preview,
            resolve_clash,
            share_preview,
            share_item,
            private_preview,
            make_private,
            set_item_hidden,
            smart_local_tags,
            libsync_run,
            remove_sync_target,
            jellyfin_settings,
            jellyfin_probe,
            jellyfin_save,
            jellyfin_forget,
            jellyfin_check_songs,
            jellyfin_destinations,
            jellyfin_set_selection,
            jellyfin_server_playlists,
            jellyfin_plan,
            jellyfin_push,
            sync_history,
            activity_history,
            service_flags,
            set_service_enabled,
            dismiss_activity,
            dismiss_sync_runs,
            sync_scans,
            sync_scan,
            sync_ignore,
            sync_unignore,
            sync_rescan,
            sync_apply,
            remote_list,
            remote_download,
            remote_upload,
            remote_move,
            remote_dir_sizes,
            remote_pull,
            remote_verify,
            is_syncing,
            rekordbox_status,
            rekordbox_set_path,
            rekordbox_export,
            rekordbox_library,
            rekordbox_selection,
            usb_export_selection,
            smart_playlists,
            smart_playlist_save,
            smart_playlist_delete,
            smart_playlist_preview,
            usb_export_preview,
            rekordbox_set_selection,
            clipboard_read_text,
            picker_places,
            picker_list,
            picker_make_dir,
            picker_read_image,
            fs_list,
            fs_dir_sizes,
            fs_reveal,
            fs_make_dir,
            fs_rename,
            fs_move,
            fs_copy,
            fs_trash,
            trash_duplicates,
            open_privacy_settings,
            audit_library,
            tags_read,
            tag_values,
            tag_value_create,
            tag_values_migrate,
            tags_preview,
            tags_lookup,
            tags_lookup_cover,
            tags_restore_covers,
            cover_search,
            cancel_tag_lookup,
            discogs_token_saved,
            discogs_token_save,
            discogs_token_forget,
            get_library_view,
            set_library_view,
            get_panel_tabs,
            set_panel_tabs,
            get_ui_setting,
            import_trash,
            set_ui_setting,
            get_tag_clipboard,
            set_tag_clipboard,
            tags_write,
            tags_write_many,
            tags_set_cover,
            audit_fix,
            audit_place,
            import_folders,
            import_add_folder,
            import_update_folder,
            import_remove_folder,
            import_scan,
            import_cached,
            import_preview,
            import_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unused_self)] // test fixtures: panicking is the failure mode
mod tests {
    use super::*;

    #[test]
    fn analysis_edits_round_bpm_and_pick_key_notation() {
        let result = db::AnalysisResult {
            path: "/a.mp3".into(),
            bpm: Some(127.6),
            key: Some("Am".into()),
        };
        let musical = analysis_edits(&result, KeyFormat::Musical);
        assert_eq!(musical.get("bpm").map(String::as_str), Some("128"));
        assert_eq!(musical.get("key").map(String::as_str), Some("Am"));
        let camelot = analysis_edits(&result, KeyFormat::Camelot);
        assert_eq!(camelot.get("key").map(String::as_str), Some("8A"));

        let only_key = db::AnalysisResult {
            bpm: None,
            ..result
        };
        assert!(!analysis_edits(&only_key, KeyFormat::Musical).contains_key("bpm"));
    }

    #[test]
    fn analysis_settings_read_old_and_new_shapes() {
        for (json, format, replace) in [
            ("{}", KeyFormat::Musical, false),
            // Saved before tags were always written: the old switch is ignored.
            (
                r#"{"writeTags":false,"keyFormat":"camelot"}"#,
                KeyFormat::Camelot,
                false,
            ),
            (
                r#"{"keyFormat":"musical","replaceEdits":true}"#,
                KeyFormat::Musical,
                true,
            ),
        ] {
            let parsed: AnalysisSettings = serde_json::from_str(json).expect("json");
            assert_eq!(parsed.key_format, format, "{json}");
            assert_eq!(parsed.replace_edits, replace, "{json}");
        }
    }
    use crate::db::NewTrack;
    use crate::scan::ScanResult;

    struct Fixture {
        dir: PathBuf,
        conn: Connection,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("manplay-test-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap_or_default();
            let conn = db::open(&dir.join("library.db")).expect("open db");
            Self { dir, conn }
        }

        fn root(&self) -> PathBuf {
            PathBuf::from("/music")
        }

        fn scan_of(&self, names: &[&str], errors: usize) -> ScanResult {
            ScanResult {
                values: HashMap::new(),
                tracks: names
                    .iter()
                    .map(|n| NewTrack {
                        path: format!("/music/{n}"),
                        artist: "a".into(),
                        album: "b".into(),
                        title: (*n).into(),
                        size: 1,
                        fingerprint: Some(format!("fp-{}", n.rsplit('/').next().unwrap_or(n))),
                        ..NewTrack::default()
                    })
                    .collect(),
                errors,
            }
        }

        fn apply(&mut self, scan: &ScanResult) {
            let root = self.root();
            detect_moves(&mut self.conn, &self.dir, &root, scan).expect("moves");
            db::upsert(&mut self.conn, &scan.tracks).expect("upsert");
            reconcile_missing(&mut self.conn, &self.dir, scan).expect("reconcile");
        }

        fn visible(&self) -> usize {
            db::list(&self.conn).expect("list").len()
        }

        fn backups(&self) -> usize {
            std::fs::read_dir(self.dir.join("backups")).map_or(0, Iterator::count)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn clean_scan_soft_deletes_missing_tracks_after_backing_up() {
        let mut f = Fixture::new("softdelete");
        f.apply(&f.scan_of(&["1", "2", "3"], 0));
        assert_eq!(f.visible(), 3);
        assert_eq!(f.backups(), 0);

        f.apply(&f.scan_of(&["1", "2"], 0));
        assert_eq!(f.visible(), 2);
        assert_eq!(db::missing_count(&f.conn).expect("count"), 1);
        assert_eq!(f.backups(), 1);
    }

    /// A file that changed bytes and path together is followed by its audio, but only when the
    /// match is unambiguous.
    #[test]
    fn moves_fall_back_to_the_audio_fingerprint_only_when_unambiguous() {
        struct Case {
            name: &'static str,
            /// `(path, audio_fp)` of the first scan.
            before: &'static [(&'static str, &'static str)],
            /// `(path, audio_fp)` of the second scan; every whole-file print is new.
            after: &'static [(&'static str, &'static str)],
            moved: usize,
        }
        let cases = [
            Case {
                name: "one gone, one new",
                before: &[("a/1.mp3", "a1:x")],
                after: &[("b/1.mp3", "a1:x")],
                moved: 1,
            },
            Case {
                name: "one gone, two new",
                before: &[("a/1.mp3", "a1:x")],
                after: &[("b/1.mp3", "a1:x"), ("c/1.mp3", "a1:x")],
                moved: 0,
            },
            Case {
                name: "two gone, one new",
                before: &[("a/1.mp3", "a1:x"), ("a/2.mp3", "a1:x")],
                after: &[("b/1.mp3", "a1:x")],
                moved: 0,
            },
            Case {
                name: "audio not fingerprinted",
                before: &[("a/1.mp3", "")],
                after: &[("b/1.mp3", "")],
                moved: 0,
            },
            Case {
                name: "different audio",
                before: &[("a/1.mp3", "a1:x")],
                after: &[("b/1.mp3", "a1:y")],
                moved: 0,
            },
        ];
        for case in cases {
            let mut f = Fixture::new(&format!("audiomove-{}", case.name.replace(' ', "-")));
            let scan = |files: &[(&str, &str)], generation: &str| ScanResult {
                values: HashMap::new(),
                errors: 0,
                tracks: files
                    .iter()
                    .map(|(path, audio)| NewTrack {
                        path: format!("/music/{path}"),
                        title: (*path).into(),
                        size: 1,
                        fingerprint: Some(format!("{generation}-{path}")),
                        audio_fp: Some((*audio).into()),
                        ..NewTrack::default()
                    })
                    .collect(),
            };
            f.apply(&scan(case.before, "old"));
            let after = scan(case.after, "new");
            let root = f.root();
            let moved = detect_moves(&mut f.conn, &f.dir, &root, &after).expect("moves");
            assert_eq!(moved, case.moved, "{}", case.name);
        }
    }

    /// Songs left from a library folder used before are not part of the library any more.
    #[test]
    fn songs_outside_the_scanned_folder_are_marked_missing() {
        let mut f = Fixture::new("old-folder");
        let mut first = f.scan_of(&["1", "2"], 0);
        first.tracks[1].path = "/old-music/2".into();
        f.apply(&first);
        assert_eq!(f.visible(), 2);

        f.apply(&f.scan_of(&["1"], 0));
        assert_eq!(f.visible(), 1);
        assert_eq!(db::missing_count(&f.conn).expect("count"), 1);
        assert_eq!(f.backups(), 1, "backed up first");
    }

    #[test]
    fn scan_with_errors_marks_nothing() {
        let mut f = Fixture::new("errors");
        f.apply(&f.scan_of(&["1", "2", "3"], 0));
        f.apply(&f.scan_of(&["1"], 2));
        assert_eq!(f.visible(), 3);
        assert_eq!(f.backups(), 0);
    }

    #[test]
    fn empty_scan_marks_nothing() {
        let mut f = Fixture::new("empty");
        f.apply(&f.scan_of(&["1", "2"], 0));
        f.apply(&f.scan_of(&[], 0));
        assert_eq!(f.visible(), 2);
    }

    /// How long each step of a launch takes on a real library:
    /// `MANPLAY_BENCH_DB=<a copy of library.db> MANPLAY_BENCH_ROOT=<library folder>
    /// cargo test --release launch_timing -- --ignored --nocapture`. It writes to the copy.
    #[test]
    #[ignore = "timing, not a check; needs a library"]
    fn launch_timing() {
        let (Ok(db_path), Ok(root)) = (
            std::env::var("MANPLAY_BENCH_DB"),
            std::env::var("MANPLAY_BENCH_ROOT"),
        ) else {
            return;
        };
        let root = PathBuf::from(root);
        let dir = std::env::temp_dir().join("manplay-launch-timing");
        let mut last = std::time::Instant::now();
        let mut step = |name: &str| {
            println!("{:>8.1} ms  {name}", last.elapsed().as_secs_f64() * 1000.0);
            last = std::time::Instant::now();
        };
        let mut conn = db::open(Path::new(&db_path)).expect("open");
        step("open the database");
        let listed = db::list(&conn).expect("list").len();
        step("list the songs");
        let known = db::scanned_tracks(&conn).expect("known");
        let remembered = known.len();
        step("load what the last scan read");
        let result = scan::scan(&root, known);
        step("walk the folder and read changed files");
        detect_moves(&mut conn, &dir, &root, &result).expect("moves");
        step("detect moves");
        db::upsert(&mut conn, &result.tracks).expect("upsert");
        step("store the songs");
        db::rekey_legacy(&mut conn).expect("rekey");
        step("rekey legacy analysis");
        libsync::apply::materialize_pending(&mut conn).expect("pending");
        step("apply waiting shared edits");
        db::replace_tag_values(&mut conn, &result.values).expect("values");
        step("replace tag values");
        reconcile_missing(&mut conn, &dir, &result).expect("missing");
        step("reconcile missing");
        let everything = scan::scan(&root, HashMap::new()).tracks.len();
        step("read every file, as a full rescan does");
        let http = reqwest::Client::builder().build().is_ok();
        step("make an HTTP client");
        println!("{everything} read in full, HTTP client made: {http}");
        println!(
            "{listed} songs listed, {remembered} remembered, {} found, {} errors",
            result.tracks.len(),
            result.errors
        );
    }

    #[test]
    fn reappearing_file_comes_back_with_its_tags_and_playlists() {
        let mut f = Fixture::new("reappear");
        f.apply(&f.scan_of(&["1", "2"], 0));
        let id = db::list(&f.conn).expect("list")[0].id;
        db::tag_tracks(&mut f.conn, "keep", &[id]).expect("tag");
        let pl = db::create_playlist(&f.conn, "p", None).expect("playlist");
        db::add_to_playlist(&mut f.conn, pl, &[id]).expect("add");

        f.apply(&f.scan_of(&["2"], 0)); // track 1 disappears
        assert_eq!(db::playlist_tracks(&f.conn, pl).expect("pl").len(), 0);

        f.apply(&f.scan_of(&["1", "2"], 0)); // and comes back
        let back = db::playlist_tracks(&f.conn, pl).expect("pl");
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].tags, vec!["keep".to_owned()]);
    }

    fn tag_counts(conn: &rusqlite::Connection) -> Vec<(String, i64)> {
        db::list_tags(conn)
            .expect("tags")
            .into_iter()
            .map(|t| (t.name, t.track_count))
            .collect()
    }

    #[test]
    fn hierarchical_tags_count_songs_of_every_level_below() {
        let mut f = Fixture::new("tag-tree");
        f.apply(&f.scan_of(&["1", "2", "3"], 0));
        let ids: Vec<i64> = db::list(&f.conn)
            .expect("list")
            .iter()
            .map(|t| t.id)
            .collect();
        db::tag_tracks(&mut f.conn, " Genre / Electronic /House ", &[ids[0]]).expect("tag");
        db::tag_tracks(&mut f.conn, "Genre/Electronic", &[ids[0], ids[1]]).expect("tag");
        db::tag_tracks(&mut f.conn, "Mood/Calm", &[ids[2]]).expect("tag");
        assert_eq!(
            tag_counts(&f.conn),
            vec![
                ("Genre".into(), 2),
                ("Genre/Electronic".into(), 2),
                ("Genre/Electronic/House".into(), 1),
                ("Mood".into(), 1),
                ("Mood/Calm".into(), 1),
            ]
        );
    }

    #[test]
    fn renaming_a_parent_tag_moves_its_children() {
        let mut f = Fixture::new("tag-rename");
        f.apply(&f.scan_of(&["1"], 0));
        let id = db::list(&f.conn).expect("list")[0].id;
        db::tag_tracks(&mut f.conn, "Genre/House", &[id]).expect("tag");
        db::migrate_tags(&mut f.conn, &["genre".into()], Some("Style")).expect("rename");
        assert_eq!(
            tag_counts(&f.conn),
            vec![("Style".into(), 1), ("Style/House".into(), 1)]
        );
        db::migrate_tags(&mut f.conn, &["Style".into()], Some("Style/Old")).expect("nest");
        assert_eq!(
            tag_counts(&f.conn),
            vec![
                ("Style".into(), 1),
                ("Style/Old".into(), 1),
                ("Style/Old/House".into(), 1),
            ]
        );
        db::migrate_tags(&mut f.conn, &["Style".into()], None).expect("delete");
        assert!(tag_counts(&f.conn).is_empty());
    }

    #[test]
    fn purge_waits_for_grace_period_and_remote_copies() {
        let mut f = Fixture::new("purge");
        f.apply(&f.scan_of(&["1", "2"], 0));
        let ids: Vec<i64> = db::list(&f.conn)
            .expect("list")
            .iter()
            .map(|t| t.id)
            .collect();
        let target = db::add_target(
            &f.conn,
            &db::NewTarget {
                tailnet: "t".into(),
                machine: "m".into(),
                path: vec!["s".into()],
            },
        )
        .expect("target");
        let record = db::RunRecord {
            target_id: target,
            started_at: 1,
            finished_at: 1,
            uploaded: 2,
            skipped: 0,
            failed: 0,
            deleted: 0,
            first_error: None,
            errors: Vec::new(),
            batch: 0,
        };
        db::record_run(
            &mut f.conn,
            &record,
            &[db::Synced::kept(ids[0], 1), db::Synced::kept(ids[1], 1)],
            &[],
        )
        .expect("run");

        f.apply(&f.scan_of(&["2"], 0)); // track 1 now missing, marked just now
        assert_eq!(db::missing_count(&f.conn).expect("count"), 1);

        // Inside the grace period nothing is purged.
        purge_expired(&f.conn, &f.dir.join("backups"), unix_now()).expect("purge");
        assert_eq!(db::missing_count(&f.conn).expect("count"), 1);

        // Past the grace period it is still kept while a remote copy is recorded.
        let later = unix_now() + GRACE_SECS + 10;
        purge_expired(&f.conn, &f.dir.join("backups"), later).expect("purge");
        assert_eq!(db::missing_count(&f.conn).expect("count"), 1);

        // Once the remote copy is deleted, the track record can go.
        db::record_run(&mut f.conn, &record, &[], &[ids[0]]).expect("run");
        purge_expired(&f.conn, &f.dir.join("backups"), later).expect("purge");
        assert_eq!(db::missing_count(&f.conn).expect("count"), 0);
    }

    #[test]
    fn a_sync_stores_replaces_keeps_and_clears_the_base_of_a_file() {
        let mut f = Fixture::new("base");
        f.apply(&f.scan_of(&["1"], 0));
        let id = ids_by_title(&f)["1"];
        let target = db::add_target(
            &f.conn,
            &db::NewTarget {
                tailnet: "t".into(),
                machine: "m".into(),
                path: vec!["s".into()],
            },
        )
        .expect("target");
        let record = db::RunRecord {
            target_id: target,
            started_at: 0,
            finished_at: 1,
            uploaded: 0,
            skipped: 0,
            failed: 0,
            deleted: 0,
            first_error: None,
            errors: Vec::new(),
            batch: 0,
        };
        let base = |sig: &str| db::Base {
            local_sig: sig.to_owned(),
            remote_sig: sig.to_owned(),
            tags: Some("{}".to_owned()),
            exact: Some(db::Exact {
                content: format!("content-{sig}"),
                local_modified: 7,
                remote_version: (sig == "b").then(|| "etag".to_owned()),
            }),
        };
        let synced = |update| db::Synced {
            track_id: id,
            size: 1,
            base: update,
        };
        db::record_run(
            &mut f.conn,
            &record,
            &[synced(db::BaseUpdate::Set(base("a")))],
            &[],
        )
        .expect("set");
        assert_eq!(
            db::synced_bases(&f.conn, target).expect("read")[&id],
            base("a")
        );
        // A file nothing happened to keeps its base.
        db::record_run(&mut f.conn, &record, &[synced(db::BaseUpdate::Keep)], &[]).expect("keep");
        assert_eq!(
            db::synced_bases(&f.conn, target).expect("read")[&id],
            base("a")
        );
        // Seeding replaces it in place.
        db::store_bases(&mut f.conn, target, &[(id, base("b"))]).expect("seed");
        assert_eq!(
            db::synced_bases(&f.conn, target).expect("read")[&id],
            base("b")
        );
        // A file the sync may have left different forgets it: rows without a base fall back.
        db::record_run(&mut f.conn, &record, &[synced(db::BaseUpdate::Clear)], &[]).expect("clear");
        assert_eq!(db::synced_bases(&f.conn, target).expect("read").len(), 0);
    }

    fn ids_by_title(f: &Fixture) -> HashMap<String, i64> {
        db::list(&f.conn)
            .expect("list")
            .into_iter()
            .map(|t| (t.title, t.id))
            .collect()
    }

    #[test]
    fn rename_keeps_identity_tags_and_playlists() {
        let mut f = Fixture::new("rename");
        f.apply(&f.scan_of(&["1", "2"], 0));
        let id = ids_by_title(&f)["1"];
        db::tag_tracks(&mut f.conn, "keep", &[id]).expect("tag");
        let pl = db::create_playlist(&f.conn, "p", None).expect("playlist");
        db::add_to_playlist(&mut f.conn, pl, &[id]).expect("add");

        f.apply(&f.scan_of(&["new/1", "2"], 0)); // "1" moved to new/1

        assert_eq!(f.visible(), 2);
        assert_eq!(db::missing_count(&f.conn).expect("count"), 0);
        let moved = db::playlist_tracks(&f.conn, pl).expect("pl");
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].id, id);
        assert_eq!(moved[0].path, "/music/new/1");
        assert_eq!(moved[0].tags, vec!["keep".to_owned()]);
        assert!(f.backups() >= 1);
    }

    #[test]
    fn a_copy_is_a_new_track_not_a_move() {
        let mut f = Fixture::new("copy");
        f.apply(&f.scan_of(&["1"], 0));
        f.apply(&f.scan_of(&["1", "copy/1"], 0));
        assert_eq!(f.visible(), 2);
        assert_eq!(db::missing_count(&f.conn).expect("count"), 0);
    }

    #[test]
    fn ambiguous_matches_are_not_guessed() {
        let mut f = Fixture::new("ambiguous");
        f.apply(&f.scan_of(&["x/1", "y/1", "keep"], 0));
        f.apply(&f.scan_of(&["z/1", "keep"], 0)); // both x/1 and y/1 vanish, z/1 appears
        let titles = ids_by_title(&f);
        assert!(titles.contains_key("z/1"));
        assert_eq!(db::missing_count(&f.conn).expect("count"), 2);
    }

    #[test]
    fn missing_track_that_reappears_elsewhere_is_recognised() {
        let mut f = Fixture::new("late-move");
        f.apply(&f.scan_of(&["1", "2"], 0));
        let id = ids_by_title(&f)["1"];
        f.apply(&f.scan_of(&["2"], 0)); // "1" goes missing
        assert_eq!(db::missing_count(&f.conn).expect("count"), 1);
        f.apply(&f.scan_of(&["moved/1", "2"], 0)); // and shows up at a new path
        assert_eq!(db::missing_count(&f.conn).expect("count"), 0);
        assert_eq!(ids_by_title(&f)["moved/1"], id);
    }

    #[test]
    fn move_queues_the_old_remote_copy_and_resets_sync_state() {
        let mut f = Fixture::new("stale");
        f.apply(&f.scan_of(&["1", "2"], 0));
        let id = ids_by_title(&f)["1"];
        let target = db::add_target(
            &f.conn,
            &db::NewTarget {
                tailnet: "t".into(),
                machine: "m".into(),
                path: vec!["s".into()],
            },
        )
        .expect("target");
        let record = db::RunRecord {
            target_id: target,
            started_at: 1,
            finished_at: 1,
            uploaded: 1,
            skipped: 0,
            failed: 0,
            deleted: 0,
            first_error: None,
            errors: Vec::new(),
            batch: 0,
        };
        db::record_run(&mut f.conn, &record, &[db::Synced::kept(id, 1)], &[]).expect("run");
        assert_eq!(db::list(&f.conn).expect("list")[0].synced_count, 1);

        f.apply(&f.scan_of(&["new/1", "2"], 0));

        let moved = db::list(&f.conn)
            .expect("list")
            .into_iter()
            .find(|t| t.id == id)
            .expect("track");
        assert_eq!(moved.synced_count, 0, "must be re-synced at the new path");
        let stale = db::stale_for(&f.conn, target).expect("stale");
        assert_eq!(stale, vec![(id, vec!["1".to_owned()])]);

        db::clear_stale(&f.conn, target, &stale).expect("clear");
        assert_eq!(db::stale_for(&f.conn, target).expect("stale"), vec![]);
    }

    #[test]
    fn export_writes_the_xml_file_with_playlists_and_updates_status() {
        let mut f = Fixture::new("rekordbox");
        f.apply(&f.scan_of(&["1", "2", "3"], 0));
        let ids: Vec<i64> = db::list(&f.conn)
            .expect("list")
            .iter()
            .map(|t| t.id)
            .collect();
        let pl = db::create_playlist(&f.conn, "Friday", None).expect("playlist");
        db::add_to_playlist(&mut f.conn, pl, &[ids[2], ids[0]]).expect("add");

        let out = f.dir.join("out").join("rekordbox.xml");
        std::fs::create_dir_all(out.parent().expect("parent")).expect("mkdir");
        db::set_setting(&f.conn, SETTING_RB_PATH, out.to_str()).expect("setting");

        let dir = f.dir.clone();
        let conn = std::mem::replace(&mut f.conn, Connection::open_in_memory().expect("mem"));
        let state = AppState {
            db: Mutex::new(conn),
            data_dir: dir,
            http: reqwest::Client::new(),
            scan_http: reqwest::Client::new(),
            syncing: AtomicBool::new(false),
            fixing: AtomicBool::new(false),
            analyzing: AtomicBool::new(false),
            usb_exporting: AtomicBool::new(false),
            cancel_analysis: AtomicBool::new(false),
            lookup: lookup::Session::default(),
            scans: Mutex::new(sync_scans::ScanStore::default()),
            scan_wake: tokio::sync::Notify::new(),
            analysis_wake: tokio::sync::Notify::new(),
            import_wake: tokio::sync::Notify::new(),
            destination_io: tokio::sync::Mutex::new(()),
            next_action_id: AtomicU32::new(0),
            library_changed: Mutex::new(None),
            wf_misses: libsync::waveforms::Misses::default(),
            wf_filling: AtomicBool::new(false),
            wf_again: AtomicBool::new(false),
            jellyfin_plans: Mutex::new(HashMap::new()),
            jellyfin_pushing: tokio::sync::Mutex::new(()),
            libsync_io: tokio::sync::Mutex::new(()),
            libsync_wake: tokio::sync::Notify::new(),
            libsync_asked: AtomicBool::new(false),
            libsync_focused: AtomicBool::new(false),
            libsync_last: Mutex::new(None),
        };
        assert!(export_inner(&state, false).expect("export"));

        let xml = std::fs::read_to_string(&out).expect("file written");
        let doc = roxmltree::Document::parse(&xml).expect("well-formed");
        assert_eq!(
            doc.descendants()
                .filter(|n| n.has_tag_name("TRACK") && n.has_attribute("Location"))
                .count(),
            3
        );
        let node = doc
            .descendants()
            .find(|n| n.has_tag_name("NODE") && n.attribute("Name") == Some("Friday"))
            .expect("playlist node");
        assert_eq!(node.attribute("Entries"), Some("2"));
        assert!(
            !out.with_extension("xml.tmp").exists(),
            "temp file is renamed away"
        );

        let conn = state.db.lock().expect("lock");
        let status = rekordbox_status_of(&conn).expect("status");
        assert_eq!(status.last.playlists, 1);
        assert_eq!(status.last.tracks, 3);
        assert!(status.last.error.is_none());
    }

    #[test]
    fn export_honours_chosen_playlists_and_tag_selection() {
        let mut f = Fixture::new("rekordbox-select");
        f.apply(&f.scan_of(&["1", "2", "3"], 0));
        let ids: Vec<i64> = db::list(&f.conn)
            .expect("list")
            .iter()
            .map(|t| t.id)
            .collect();
        let keep = db::create_playlist(&f.conn, "Keep", None).expect("playlist");
        let skip = db::create_playlist(&f.conn, "Skip", None).expect("playlist");
        db::add_to_playlist(&mut f.conn, keep, &[ids[0]]).expect("add");
        db::add_to_playlist(&mut f.conn, skip, &[ids[1]]).expect("add");
        db::tag_tracks(&mut f.conn, "Genre/House", &[ids[0], ids[2]]).expect("tag");
        db::tag_tracks(&mut f.conn, "Genre/House/Deep", &[ids[1]]).expect("tag");

        let out = f.dir.join("out").join("rekordbox.xml");
        std::fs::create_dir_all(out.parent().expect("parent")).expect("mkdir");
        db::set_setting(&f.conn, SETTING_RB_PATH, out.to_str()).expect("setting");
        let deep = db::save_smart_playlist(
            &f.conn,
            &smart::SmartPlaylist {
                id: 0,
                name: "Deep cuts".to_owned(),
                rules: smart::Rules {
                    all_tags: vec!["Genre/House/Deep".to_owned()],
                    ..smart::Rules::default()
                },
            },
        )
        .expect("smart");
        let nothing = db::save_smart_playlist(
            &f.conn,
            &smart::SmartPlaylist {
                id: 0,
                name: "Matches nothing".to_owned(),
                rules: smart::Rules {
                    all_tags: vec!["Nope".to_owned()],
                    ..smart::Rules::default()
                },
            },
        )
        .expect("smart");
        let selection = db::ExportSelection {
            playlists: vec![keep],
            tags: vec!["genre/house".to_owned(), "Nope".to_owned()],
            smart: vec![deep.id, nothing.id],
            ..db::ExportSelection::default()
        };
        db::set_export_selection(&f.conn, db::RB_DESTINATION, &selection).expect("selection");

        let dir = f.dir.clone();
        let conn = std::mem::replace(&mut f.conn, Connection::open_in_memory().expect("mem"));
        let state = AppState {
            db: Mutex::new(conn),
            data_dir: dir,
            http: reqwest::Client::new(),
            scan_http: reqwest::Client::new(),
            syncing: AtomicBool::new(false),
            fixing: AtomicBool::new(false),
            analyzing: AtomicBool::new(false),
            usb_exporting: AtomicBool::new(false),
            cancel_analysis: AtomicBool::new(false),
            lookup: lookup::Session::default(),
            scans: Mutex::new(sync_scans::ScanStore::default()),
            scan_wake: tokio::sync::Notify::new(),
            analysis_wake: tokio::sync::Notify::new(),
            import_wake: tokio::sync::Notify::new(),
            destination_io: tokio::sync::Mutex::new(()),
            next_action_id: AtomicU32::new(0),
            library_changed: Mutex::new(None),
            wf_misses: libsync::waveforms::Misses::default(),
            wf_filling: AtomicBool::new(false),
            wf_again: AtomicBool::new(false),
            jellyfin_plans: Mutex::new(HashMap::new()),
            jellyfin_pushing: tokio::sync::Mutex::new(()),
            libsync_io: tokio::sync::Mutex::new(()),
            libsync_wake: tokio::sync::Notify::new(),
            libsync_asked: AtomicBool::new(false),
            libsync_focused: AtomicBool::new(false),
            libsync_last: Mutex::new(None),
        };
        assert!(export_inner(&state, false).expect("export"));

        let lib = rekordbox::read_library(&std::fs::read_to_string(&out).expect("file"))
            .expect("library");
        let names: Vec<_> = lib
            .playlists
            .iter()
            .map(|p| (p.folders.join("/"), p.name.clone(), p.tracks.len()))
            .collect();
        assert_eq!(
            names,
            [
                ("manplay".to_owned(), "Keep".to_owned(), 1),
                ("manplay/Tags".to_owned(), "Genre › House".to_owned(), 3),
                ("manplay/Smart".to_owned(), "Deep cuts".to_owned(), 1),
            ],
            "Skip is not chosen, the tag includes songs from tags below it, unknown tags and \
             empty smart playlists vanish"
        );
    }

    #[test]
    fn export_is_a_no_op_until_a_file_is_chosen() {
        let mut f = Fixture::new("rekordbox-off");
        f.apply(&f.scan_of(&["1"], 0));
        let dir = f.dir.clone();
        let conn = std::mem::replace(&mut f.conn, Connection::open_in_memory().expect("mem"));
        let state = AppState {
            db: Mutex::new(conn),
            data_dir: dir,
            http: reqwest::Client::new(),
            scan_http: reqwest::Client::new(),
            syncing: AtomicBool::new(false),
            fixing: AtomicBool::new(false),
            analyzing: AtomicBool::new(false),
            usb_exporting: AtomicBool::new(false),
            cancel_analysis: AtomicBool::new(false),
            lookup: lookup::Session::default(),
            scans: Mutex::new(sync_scans::ScanStore::default()),
            scan_wake: tokio::sync::Notify::new(),
            analysis_wake: tokio::sync::Notify::new(),
            import_wake: tokio::sync::Notify::new(),
            destination_io: tokio::sync::Mutex::new(()),
            next_action_id: AtomicU32::new(0),
            library_changed: Mutex::new(None),
            wf_misses: libsync::waveforms::Misses::default(),
            wf_filling: AtomicBool::new(false),
            wf_again: AtomicBool::new(false),
            jellyfin_plans: Mutex::new(HashMap::new()),
            jellyfin_pushing: tokio::sync::Mutex::new(()),
            libsync_io: tokio::sync::Mutex::new(()),
            libsync_wake: tokio::sync::Notify::new(),
            libsync_asked: AtomicBool::new(false),
            libsync_focused: AtomicBool::new(false),
            libsync_last: Mutex::new(None),
        };
        assert!(!export_inner(&state, false).expect("no-op"));
    }
}
