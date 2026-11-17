#![allow(clippy::needless_pass_by_value)] // Tauri command args are taken by value

mod analysis;
mod anlz;
mod art;
mod audioprint;
mod audit;
mod db;
mod error;
mod fsops;
mod import;
mod itunes;
mod libsync;
mod onelib;
mod pdb;
mod playback;
mod process;
mod r2;
mod rekordbox;
mod scan;
mod smart;
mod stream;
mod sync;
mod tag_region;
mod tags;
mod tailscale;
mod usb;
mod usb_edit;
mod usb_export;
mod webdav;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{NewTarget, Playlist, RunView, SyncTarget, Tag, Track};
use crate::error::Error;

struct AppState {
    db: Mutex<Connection>,
    data_dir: PathBuf,
    http: reqwest::Client,
    syncing: AtomicBool,
    fixing: AtomicBool,
    analyzing: AtomicBool,
    /// Held while songs are being copied onto a USB drive.
    usb_exporting: AtomicBool,
    /// Set to stop the running analysis after the files in progress.
    cancel_analysis: AtomicBool,
    /// The last sync review, awaiting the user's confirmation.
    plan: Mutex<Option<sync::Plan>>,
    /// Waveforms the sharing destination did not have since the last sync.
    wf_misses: libsync::waveforms::Misses,
    /// Held while waveforms are being downloaded in the background.
    wf_filling: AtomicBool,
    /// A sync asked for a waveform transfer while one was running: run again when it ends.
    wf_again: AtomicBool,
}

const SETTING_ROOT: &str = "library_root";
/// How long a track must stay missing before its record and remote copies are removed.
const GRACE_SECS: i64 = 7 * 24 * 60 * 60;
const GRACE_DAYS: i64 = 7;
const BACKUPS_KEEP: usize = 5;
/// How long copies of files removed from destinations are kept.
const SYNC_BACKUP_KEEP_SECS: i64 = 30 * 24 * 60 * 60;

/// Scans `root` off the UI thread, stores the results, and remembers `root` as the library folder.
async fn scan_and_store(state: &AppState, root: PathBuf) -> Result<usize, Error> {
    let scan_root = root.clone();
    let result = tauri::async_runtime::spawn_blocking(move || scan::scan(&scan_root))
        .await
        .map_err(|e| Error::Msg(e.to_string()))?;
    let mut conn = state.db.lock().map_err(|_| Error::Lock)?;
    detect_moves(&mut conn, &state.data_dir, &root, &result)?;
    db::upsert(&mut conn, &result.tracks)?;
    db::rekey_legacy(&mut conn)?;
    // Shared tags and playlists that were waiting for these songs.
    libsync::apply::materialize_pending(&mut conn)?;
    db::replace_tag_values(&mut conn, &result.values)?;
    db::set_setting(&conn, SETTING_ROOT, root.to_str())?;
    reconcile_missing(&mut conn, &state.data_dir, &root, &result)?;
    drop(conn);
    Ok(result.tracks.len())
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
        .and_then(|()| libsync::apply::materialize_pending(&mut conn).map(|_| ()));
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

/// Soft-deletes tracks the scan could not find, then purges ones that have been gone
/// past the grace period. The database is backed up before either step changes anything.
fn reconcile_missing(
    conn: &mut Connection,
    data_dir: &Path,
    root: &Path,
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
            .filter(|(_, p)| Path::new(p).starts_with(root) && !found.contains(p.as_str()))
            .map(|(id, _)| id)
            .collect();
        if !gone.is_empty() {
            db::backup(conn, &backups, now, BACKUPS_KEEP)?;
            db::mark_missing(conn, &gone, now)?;
        }
    }

    purge_expired(conn, &backups, now)
}

/// Removes missing tracks past the grace period that have no remote copies left.
fn purge_expired(conn: &Connection, backups: &Path, now: i64) -> Result<(), Error> {
    let cutoff = now - GRACE_SECS;
    if db::purgeable_count(conn, cutoff)? > 0 {
        db::backup(conn, backups, now, BACKUPS_KEEP)?;
        db::purge_expired(conn, cutoff)?;
    }
    Ok(())
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

/// Groups of present songs with the same audio (see `db::duplicate_groups`).
#[tauri::command]
fn list_duplicates(state: State<'_, AppState>) -> Result<Vec<db::DuplicateGroup>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::duplicate_groups(&conn)
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
    scan_and_store(&state, root).await
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

/// Rescans the remembered library folder. `None` when no folder was ever chosen.
#[tauri::command]
async fn rescan_library(state: State<'_, AppState>) -> Result<Option<usize>, Error> {
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
    scan_and_store(&state, root).await.map(Some)
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
    rescan_library(state).await
}

#[tauri::command]
fn list_tracks(state: State<'_, AppState>) -> Result<Vec<Track>, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::list(&conn)
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

/// How analysis results are kept, beyond manplay's own database.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct AnalysisSettings {
    /// Write detected BPM and key into the files' tags after each analysis.
    write_tags: bool,
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
    state: State<'_, AppState>,
    track_ids: Option<Vec<i64>>,
    force: bool,
    replace_edits: Option<bool>,
) -> Result<AnalysisReport, Error> {
    if state.analyzing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("an analysis is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.analyzing);
    state.cancel_analysis.store(false, Ordering::SeqCst);
    let (jobs, ids, replace_edits) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        let replace_edits = replace_edits.unwrap_or(analysis_settings_of(&conn)?.replace_edits);
        let jobs = db::analysis_jobs(&conn, track_ids.as_deref(), force)?;
        let ids = db::track_ids_with_audio_fps(
            &conn,
            &jobs.iter().map(|j| j.audio_fp.as_str()).collect::<Vec<_>>(),
        )?;
        (jobs, ids, replace_edits)
    };
    let jobs = if force {
        jobs
    } else {
        drop_analysed_elsewhere(&state, jobs).await
    };
    if jobs.is_empty() {
        return Ok(AnalysisReport::default());
    }
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let report = |p: AnalysisProgress| {
            let _ = handle.emit("analysis-progress", p);
        };
        run_analysis(&state, &jobs, replace_edits, &report)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))??;
    let mut result = result;
    let write = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        analysis_settings_of(&conn)?.write_tags
    };
    if write && !state.cancel_analysis.load(Ordering::SeqCst) {
        // Only the songs this run looked at; older results are saved from the drawer.
        result.tags = Some(save_analysis_tags(&app, &state, Some(&ids)).await?);
    }
    Ok(result)
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
fn add_sync_target(state: State<'_, AppState>, target: NewTarget) -> Result<i64, Error> {
    with_db!(state, |c| db::add_target(c, &target))
}

#[tauri::command]
async fn add_r2_target(
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
    Ok(id)
}

/// Edits a destination: its folder (clears synced state when it changes) and,
/// for R2, the access key. A blank `secret` keeps the stored credentials.
#[tauri::command]
async fn update_sync_target(
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
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteScan {
    /// Every file found on the destination, audio or not.
    total: usize,
    /// Audio files the library does not have.
    missing: Vec<MissingFile>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MissingFile {
    #[serde(flatten)]
    file: sync::Remote,
    /// Extension of a library track with the same name but another format (e.g. `flac`).
    other_format: Option<String>,
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

fn local_path(root: &Path, rel: &[String]) -> PathBuf {
    rel.iter().fold(root.to_path_buf(), |p, s| p.join(s))
}

/// Library lookups for [`remote_scan`]: lower-cased paths, `(file name, size)` pairs, and
/// file name without extension -> extension.
type KnownLibrary = (
    HashSet<String>,
    HashSet<(String, i64)>,
    HashMap<String, String>,
);

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

/// Looks inside a destination for audio files the library is missing.
#[tauri::command]
async fn remote_scan(state: State<'_, AppState>, target_id: i64) -> Result<RemoteScan, Error> {
    let (target, root) = find_target(&state, target_id)?;
    // A library file counts as a match by path (any letter case) or by file name plus size,
    // so tracks that were organised into different folders locally are not offered again.
    let (known_paths, known_files, known_stems): KnownLibrary = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        let rows = db::present_sizes(&conn)?;
        let paths = rows.iter().map(|(p, _)| p.to_lowercase()).collect();
        let files = rows
            .iter()
            .filter_map(|(p, size)| {
                let name = Path::new(p).file_name()?.to_str()?.to_lowercase();
                Some((name, *size))
            })
            .collect();
        let stems = rows
            .iter()
            .filter_map(|(p, _)| {
                let p = Path::new(p);
                let stem = p.file_stem()?.to_str()?.to_lowercase();
                let ext = p.extension()?.to_str()?.to_lowercase();
                Some((stem, ext))
            })
            .collect();
        (paths, files, stems)
    };
    let remote = sync::list_remote(&state.http, &target).await?;
    let total = remote.len();
    let missing = remote
        .into_iter()
        .filter(|r| {
            let name = r.rel.last().map_or("", String::as_str);
            if name.starts_with('.') || !scan::is_audio(Path::new(name)) {
                return false;
            }
            let path = local_path(&root, &r.rel);
            let size = i64::try_from(r.size).unwrap_or(i64::MAX);
            !path.exists()
                && path
                    .to_str()
                    .is_none_or(|p| !known_paths.contains(&p.to_lowercase()))
                && !known_files.contains(&(name.to_lowercase(), size))
        })
        .map(|file| {
            let p = Path::new(file.rel.last().map_or("", String::as_str));
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
            let other_format = known_stems
                .get(&stem.to_lowercase())
                .filter(|e| !e.eq_ignore_ascii_case(ext))
                .cloned();
            MissingFile { file, other_format }
        })
        .collect();
    Ok(RemoteScan { total, missing })
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
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a sync is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.syncing);
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
        scan_and_store(&state, root).await?;
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
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a sync is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.syncing);
    let outcome = sync::transfer::download(&app, &state.http, &target, &items, &dest).await?;
    if outcome.pulled > 0 {
        scan_and_store(&state, root).await?;
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
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a sync is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.syncing);
    sync::transfer::upload(&app, &state.http, &target, &files).await
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
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a sync is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.syncing);
    sync::transfer::move_items(&state.http, &target, &items, &dest).await
}

#[tauri::command]
fn remove_sync_target(state: State<'_, AppState>, id: i64) -> Result<(), Error> {
    with_db!(state, |c| db::remove_target(c, id))?;
    r2::forget_credentials(id);
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

/// The rekordbox library on a plugged-in drive; empty if it has none.
#[tauri::command]
async fn usb_library(mount: PathBuf) -> Result<pdb::Library, Error> {
    tauri::async_runtime::spawn_blocking(move || {
        usb::check_mount(&mount)?;
        usb::library(&mount)
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
    let target = state.db.lock().ok().and_then(|c| {
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
        db::get_targets(&c, None)
            .ok()
            .and_then(|t| t.into_iter().find(|t| t.libsync))
    });
    if let Some(target) = target
        && let Err(e) =
            sync::fetch_waveform(&state.http, &target, &state.db, &state.wf_misses, audio_fp).await
    {
        log::debug!("no waveform from the destination: {e}");
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
            let modified = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0));
            Some(sync::Item {
                track_id: t.id,
                rel: rel_path(root, &t.path)?,
                local,
                size,
                fingerprint: t.fingerprint,
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

/// Compares the given targets (or every target of an enabled service) with the library and
/// returns what a sync would push, rename and delete. Changes nothing on any destination.
#[tauri::command]
async fn sync_plan(
    app: AppHandle,
    state: State<'_, AppState>,
    target_ids: Option<Vec<i64>>,
) -> Result<sync::Plan, Error> {
    let (targets, items, known, synced, prints, bases) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        let targets = db::get_targets(&conn, target_ids.as_deref())?;
        let synced = targets
            .iter()
            .map(|t| Ok((t.id, db::synced_times(&conn, t.id)?)))
            .collect::<Result<HashMap<_, _>, Error>>()?;
        let prints = targets
            .iter()
            .map(|t| Ok((t.id, db::remote_prints(&conn, t.id)?)))
            .collect::<Result<HashMap<_, _>, Error>>()?;
        let bases = targets
            .iter()
            .map(|t| Ok((t.id, db::synced_bases(&conn, t.id)?)))
            .collect::<Result<HashMap<_, _>, Error>>()?;
        (
            targets,
            collect_items(&conn)?,
            collect_known(&conn)?,
            synced,
            prints,
            bases,
        )
    };
    if targets.is_empty() {
        return Err(Error::Msg("no sync target selected".to_owned()));
    }
    // An empty library would propose deleting everything on the destination.
    if items.is_empty() {
        return Err(Error::Msg(
            "no tracks under the library folder to sync".to_owned(),
        ));
    }
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a sync is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.syncing);

    let mut next_id = 0;
    let mut plans = Vec::new();
    for target in &targets {
        let times = synced.get(&target.id).cloned().unwrap_or_default();
        let cached = prints.get(&target.id).cloned().unwrap_or_default();
        let target_bases = bases.get(&target.id).cloned().unwrap_or_default();
        let mut plan = sync::plan_target(
            &app,
            &state.http,
            target,
            &sync::Inputs {
                items: &items,
                known: &known,
                synced_at: &times,
                cached: &cached,
                bases: &target_bases,
            },
            &mut next_id,
        )
        .await;
        if !plan.fresh_prints.is_empty() {
            let conn = state.db.lock().map_err(|_| Error::Lock)?;
            db::store_remote_prints(&conn, target.id, &plan.fresh_prints)?;
        }
        // Files found identical get a base now, so the next review knows who edits what.
        let seeds = sync::seed_bases(std::mem::take(&mut plan.seeds)).await;
        if !seeds.is_empty() {
            let mut conn = state.db.lock().map_err(|_| Error::Lock)?;
            db::store_bases(&mut conn, target.id, &seeds)?;
        }
        plans.push(plan);
    }
    let plan = sync::Plan {
        id: unix_now().to_string(),
        targets: plans,
    };
    *state.plan.lock().map_err(|_| Error::Lock)? = Some(plan.clone());
    Ok(plan)
}

/// Executes the actions the user confirmed from the last [`sync_plan`]. Anything that would be
/// overwritten or deleted is copied to the app's backup folder first.
#[tauri::command]
async fn sync_apply(
    app: AppHandle,
    state: State<'_, AppState>,
    plan_id: String,
    action_ids: Vec<u32>,
    resolutions: Option<HashMap<u32, sync::Resolution>>,
) -> Result<Vec<sync::ApplySummary>, Error> {
    let plan = {
        let mut slot = state.plan.lock().map_err(|_| Error::Lock)?;
        match slot.as_ref() {
            Some(p) if p.id == plan_id => slot.take(),
            _ => None,
        }
    }
    .ok_or_else(|| Error::Msg("this review is out of date: review the changes again".to_owned()))?;
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a sync is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.syncing);

    let selected: HashSet<u32> = action_ids.into_iter().collect();
    let resolutions = resolutions.unwrap_or_default();
    let root = library_root(&state)?;
    let ids: Vec<i64> = plan.targets.iter().map(|t| t.target_id).collect();
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
    let backups = state.data_dir.join("sync-backups");
    let batch = unix_now();
    let backup_dir = backups.join(format!("{batch:012}"));
    let mut summaries = Vec::new();
    for tp in &plan.targets {
        let Some(target) = targets.iter().find(|t| t.id == tp.target_id) else {
            continue;
        };
        if tp.error.is_some() || !tp.actions.iter().any(|a| selected.contains(&a.id)) {
            continue;
        }
        let started_at = unix_now();
        let review = sync::Review {
            selected: &selected,
            resolutions: &resolutions,
            backup_dir: &backup_dir,
            root: &root,
        };
        let applied = sync::apply_target(&app, &state.http, target, tp, &review).await;
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
        scan_and_store(&state, root).await?;
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

/// How many tags, playlists and smart playlists "Join and replace mine" would drop.
#[tauri::command]
fn libsync_replace_count(state: State<'_, AppState>) -> Result<i64, Error> {
    with_db!(state, |c| libsync::membership::replace_count(c))
}

/// Joins the shared library on a destination, or starts one there, and syncs it once.
#[tauri::command]
async fn libsync_join(
    app: AppHandle,
    state: State<'_, AppState>,
    target_id: i64,
    choice: libsync::membership::JoinChoice,
) -> Result<sync::LibraryOutcome, Error> {
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a sync is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.syncing);
    let target = shared_target(&state, target_id)?;
    state.wf_misses.clear();
    let out = sync::join_library(&state.http, &target, &state.db, choice).await?;
    let target = shared_target(&state, target_id)?;
    tauri::async_runtime::spawn(transfer_waveforms(app, target));
    Ok(out)
}

/// Leaves the shared library. `sync` sends and receives one last time first.
#[tauri::command]
async fn libsync_leave(
    state: State<'_, AppState>,
    choice: libsync::membership::LeaveChoice,
    sync: bool,
) -> Result<(), Error> {
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a sync is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.syncing);
    let target = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::list_targets(&conn)?.into_iter().find(|t| t.libsync)
    }
    .ok_or_else(|| Error::Msg("This device is not in a shared library.".to_owned()))?;
    sync::leave_library(&state.http, &target, &state.db, choice, sync).await
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
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a sync is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.syncing);
    let targets = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::get_targets(&conn, Some(&target_ids))?
    };
    let mut out = Vec::new();
    state.wf_misses.clear();
    for target in targets.iter().filter(|t| t.libsync) {
        out.push(sync::run_library_data(&state.http, target, &state.db).await);
    }
    if let Some(target) = targets.into_iter().find(|t| t.libsync) {
        tauri::async_runtime::spawn(transfer_waveforms(app, target));
    }
    Ok(out)
}

/// Uploads this device's waveforms and downloads everyone else's after a sync, all of them, in
/// the background, with `waveform-progress` events for the status bar. Problems are only logged:
/// what is left goes after the next sync, and a missing waveform is fetched when its song shows.
async fn transfer_waveforms(app: AppHandle, target: db::SyncTarget) {
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
        match sync::transfer_waveforms(&state.http, &target, &state.db, &state.wf_misses, report)
            .await
        {
            Ok(t) => {
                log::info!(
                    "waveforms on {}: {} sent, {} fetched",
                    sync::target_name(&target),
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
    if let Err(e) = scan_and_store(state, root).await {
        log::warn!("rescan after file change failed: {e}");
    }
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

/// Moves to the system Trash. Tracks that vanish are soft-deleted by the rescan, as usual.
#[tauri::command]
async fn fs_trash(state: State<'_, AppState>, paths: Vec<PathBuf>) -> Result<(), Error> {
    let root = library_root(&state)?;
    let r = root.clone();
    tauri::async_runtime::spawn_blocking(move || fsops::trash(&r, &paths))
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;
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
) -> Result<audit::FixReport, Error> {
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
    let root = library_root(&state)?;
    if state.fixing.swap(true, Ordering::SeqCst) {
        return Err(Error::Msg("a fix is already running".to_owned()));
    }
    let _guard = SyncGuard(&state.fixing);
    let r = root.clone();
    let (files, report) =
        tauri::async_runtime::spawn_blocking(move || tags::write_cover(&r, &paths, &bytes))
            .await
            .map_err(|e| Error::Msg(e.to_string()))??;
    if let Ok(dir) = app.path().app_cache_dir().map(|d| d.join("art")) {
        for f in &files {
            art::forget(f, &dir);
        }
    }
    refresh_after_fs_change(&state, root).await;
    Ok(report)
}

// ---- library health ----------------------------------------------------------

/// Lists files that break the library conventions (see `audit`).
#[tauri::command]
async fn audit_library(state: State<'_, AppState>) -> Result<Vec<audit::Issue>, Error> {
    let root = library_root(&state)?;
    let ffmpeg = itunes::find_ffmpeg().is_some();
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
        audit::fix_all(&r, &paths, itunes::find_ffmpeg().as_deref())
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?;
    refresh_after_fs_change(&state, root).await;
    Ok(report)
}

// ---- import from downloads ---------------------------------------------------

const SETTING_IMPORT_FOLDER: &str = "import_folder";

/// The folder to import from: the last one used, else the system Downloads folder.
#[tauri::command]
fn import_get_folder(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, Error> {
    let saved = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::get_setting(&conn, SETTING_IMPORT_FOLDER)?
    };
    Ok(saved.or_else(|| {
        app.path()
            .download_dir()
            .ok()
            .and_then(|p| p.to_str().map(str::to_owned))
    }))
}

/// Looks through `folder` (and inside zips) for music that is not in the library. Files that
/// have not changed since the last scan of this folder come from the cache unless `fresh`.
/// Emits `import-progress` events while it works.
#[tauri::command]
async fn import_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    folder: PathBuf,
    fresh: bool,
) -> Result<import::ImportScan, Error> {
    if !folder.is_dir() {
        return Err(Error::Msg(format!("not a folder: {}", folder.display())));
    }
    let key = folder.to_string_lossy().into_owned();
    let (known, cache, mut audio, unprinted) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::set_setting(&conn, SETTING_IMPORT_FOLDER, folder.to_str())?;
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
        )
    };
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

/// Moves files, zips or folders from the Downloads folder to the Trash. Only paths inside the
/// saved Downloads folder are accepted, and never the folder itself.
#[tauri::command]
async fn import_trash(state: State<'_, AppState>, paths: Vec<PathBuf>) -> Result<(), Error> {
    let folder = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::get_setting(&conn, SETTING_IMPORT_FOLDER)?
    }
    .ok_or_else(|| Error::Msg("no Downloads folder chosen".to_owned()))?;
    tauri::async_runtime::spawn_blocking(move || fsops::trash(Path::new(&folder), &paths))
        .await
        .map_err(|e| Error::Msg(e.to_string()))?
}

/// What the last scan of `folder` found, rebuilt from the cache without reading any file.
/// `None` when the folder was never scanned.
#[tauri::command]
async fn import_cached(
    state: State<'_, AppState>,
    folder: PathBuf,
) -> Result<Option<import::ImportScan>, Error> {
    let key = folder.to_string_lossy().into_owned();
    let (known, saved, audio) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        (
            db::content_index(&conn)?,
            db::get_import_cache(&conn, &key)?,
            db::audio_index(&conn)?,
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
    folder: PathBuf,
    src: import::SourceRef,
) -> Result<String, Error> {
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
    folder: PathBuf,
    groups: Vec<import::ImportRequest>,
) -> Result<import::ImportReport, Error> {
    let library = library_root(&state)?;
    let lib = library.clone();
    let started_at = unix_now();
    let items: Vec<String> = groups
        .iter()
        .filter(|g| !g.tracks.is_empty())
        .map(|g| format!("{} — {} ({} tracks)", g.artist, g.album, g.tracks.len()))
        .collect();
    let report = tauri::async_runtime::spawn_blocking(move || import::run(&folder, &lib, &groups))
        .await
        .map_err(|e| Error::Msg(e.to_string()))?;
    if report.imported > 0 {
        refresh_after_fs_change(&state, library).await;
    }
    if report.imported > 0 || !report.failed.is_empty() {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        db::record_activity(
            &conn,
            &db::Activity {
                source: "downloads".to_owned(),
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

// ---- iTunes import -----------------------------------------------------------

const SETTING_ITUNES_PATH: &str = "itunes_path";
const SETTING_ITUNES_LAST: &str = "itunes_last_import";
const ITUNES_KEEP: usize = 50;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ItunesStatus {
    path: Option<String>,
    last: Option<itunes::ImportReport>,
}

fn itunes_status_of(conn: &Connection) -> Result<ItunesStatus, Error> {
    Ok(ItunesStatus {
        path: db::get_setting(conn, SETTING_ITUNES_PATH)?,
        last: db::get_setting(conn, SETTING_ITUNES_LAST)?
            .and_then(|raw| serde_json::from_str(&raw).ok()),
    })
}

#[tauri::command]
fn itunes_status(state: State<'_, AppState>) -> Result<ItunesStatus, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    itunes_status_of(&conn)
}

/// Chooses (or clears, with `None`) the iTunes folder to import from.
#[tauri::command]
fn itunes_set_path(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<ItunesStatus, Error> {
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    db::set_setting(&conn, SETTING_ITUNES_PATH, path.as_deref())?;
    if path.is_none() {
        db::set_setting(&conn, SETTING_ITUNES_LAST, None)?;
    }
    itunes_status_of(&conn)
}

/// Songs in the iTunes folder that an import would add. Empty when iTunes is off or unset.
#[tauri::command]
async fn itunes_pending(state: State<'_, AppState>) -> Result<Vec<itunes::Converted>, Error> {
    let (source, known) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        if db::service_off(&conn, "itunes")? {
            return Ok(Vec::new());
        }
        let Some(source) = db::get_setting(&conn, SETTING_ITUNES_PATH)? else {
            return Ok(Vec::new());
        };
        (PathBuf::from(source), itunes::Known::load(&conn)?)
    };
    tauri::async_runtime::spawn_blocking(move || itunes::pending(&source, known))
        .await
        .map_err(|e| Error::Msg(e.to_string()))
}

/// Converts new iTunes songs into the library, then rescans so they show up.
/// `Ok(None)` when no iTunes folder or library folder is configured.
#[tauri::command]
async fn itunes_import(state: State<'_, AppState>) -> Result<Option<ItunesStatus>, Error> {
    let (source, library, known) = {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        if db::service_off(&conn, "itunes")? {
            return Ok(None);
        }
        let source = db::get_setting(&conn, SETTING_ITUNES_PATH)?;
        let library = db::get_setting(&conn, SETTING_ROOT)?;
        let (Some(source), Some(library)) = (source, library) else {
            return Ok(None);
        };
        (
            PathBuf::from(source),
            PathBuf::from(library),
            itunes::Known::load(&conn)?,
        )
    };
    let now = unix_now();
    let lib = library.clone();
    let (mut report, imported) = tauri::async_runtime::spawn_blocking(move || {
        let mut imported = Vec::new();
        let report = itunes::import(&source, &lib, known, now, |c, dest| {
            imported.push((c.clone(), dest.to_path_buf()));
            Ok(())
        });
        (report, imported)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?;

    {
        let conn = state.db.lock().map_err(|_| Error::Lock)?;
        for (c, dest) in &imported {
            itunes::record_imported(&conn, c, dest, now)?;
        }
    }
    if !report.converted.is_empty() {
        scan_and_store(&state, library).await?;
    }
    let conn = state.db.lock().map_err(|_| Error::Lock)?;
    if !report.converted.is_empty() || !report.failed.is_empty() || report.error.is_some() {
        db::record_activity(
            &conn,
            &db::Activity {
                source: "itunes".to_owned(),
                started_at: now,
                finished_at: unix_now(),
                ok: i64::try_from(report.converted.len()).unwrap_or(0),
                skipped: i64::try_from(report.skipped).unwrap_or(0),
                failed: i64::try_from(report.failed.len()).unwrap_or(0)
                    + i64::from(report.error.is_some()),
                items: report
                    .converted
                    .iter()
                    .map(|c| format!("{} — {} · {}", c.artist, c.title, c.album))
                    .collect(),
                errors: report
                    .error
                    .iter()
                    .cloned()
                    .chain(
                        report
                            .failed
                            .iter()
                            .map(|f| format!("{}: {}", f.file, f.error)),
                    )
                    .collect(),
                ..db::Activity::default()
            },
        )?;
    }
    report.converted.truncate(ITUNES_KEEP);
    report.failed.truncate(ITUNES_KEEP);
    let raw = serde_json::to_string(&report).map_err(|e| Error::Msg(e.to_string()))?;
    db::set_setting(&conn, SETTING_ITUNES_LAST, Some(&raw))?;
    itunes_status_of(&conn).map(Some)
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .register_asynchronous_uri_scheme_protocol("art", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let target = ArtTarget::parse(request.uri().path());
            std::thread::spawn(move || responder.respond(art_response(&app, target)));
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
            app.manage(AppState {
                db: Mutex::new(conn),
                data_dir: dir.clone(),
                http,
                syncing: AtomicBool::new(false),
                fixing: AtomicBool::new(false),
                analyzing: AtomicBool::new(false),
                usb_exporting: AtomicBool::new(false),
                cancel_analysis: AtomicBool::new(false),
                plan: Mutex::new(None),
                wf_misses: libsync::waveforms::Misses::default(),
                wf_filling: AtomicBool::new(false),
                wf_again: AtomicBool::new(false),
            });
            tauri::async_runtime::spawn(fill_audio_fps(app.handle().clone()));
            tauri::async_runtime::spawn(reprint_audio_fps(app.handle().clone()));
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
            libsync_replace_count,
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
            sync_history,
            activity_history,
            service_flags,
            set_service_enabled,
            dismiss_activity,
            dismiss_sync_runs,
            sync_plan,
            sync_apply,
            remote_scan,
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
            itunes_status,
            itunes_set_path,
            itunes_import,
            itunes_pending,
            fs_list,
            fs_dir_sizes,
            fs_reveal,
            fs_make_dir,
            fs_rename,
            fs_move,
            fs_copy,
            fs_trash,
            open_privacy_settings,
            audit_library,
            tags_read,
            tag_values,
            tag_value_create,
            tag_values_migrate,
            tags_preview,
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
            import_get_folder,
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
    fn analysis_settings_default_to_not_writing_files() {
        let parsed: AnalysisSettings = serde_json::from_str("{}").expect("json");
        assert!(!parsed.write_tags);
        assert_eq!(parsed.key_format, KeyFormat::Musical);
        let parsed: AnalysisSettings =
            serde_json::from_str(r#"{"writeTags":true,"keyFormat":"camelot"}"#).expect("json");
        assert!(parsed.write_tags);
        assert_eq!(parsed.key_format, KeyFormat::Camelot);
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
            reconcile_missing(&mut self.conn, &self.dir, &root, scan).expect("reconcile");
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

    #[test]
    fn tracks_outside_the_scanned_root_are_left_alone() {
        let mut f = Fixture::new("outside");
        let other = ScanResult {
            values: HashMap::new(),
            tracks: vec![NewTrack {
                path: "/elsewhere/x".into(),
                artist: "a".into(),
                album: "b".into(),
                title: "x".into(),
                size: 1,
                fingerprint: Some("fp-x".into()),
                ..NewTrack::default()
            }],
            errors: 0,
        };
        db::upsert(&mut f.conn, &other.tracks).expect("upsert");
        f.apply(&f.scan_of(&["1"], 0));
        assert_eq!(f.visible(), 2);
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
            syncing: AtomicBool::new(false),
            fixing: AtomicBool::new(false),
            analyzing: AtomicBool::new(false),
            usb_exporting: AtomicBool::new(false),
            cancel_analysis: AtomicBool::new(false),
            plan: Mutex::new(None),
            wf_misses: libsync::waveforms::Misses::default(),
            wf_filling: AtomicBool::new(false),
            wf_again: AtomicBool::new(false),
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
            syncing: AtomicBool::new(false),
            fixing: AtomicBool::new(false),
            analyzing: AtomicBool::new(false),
            usb_exporting: AtomicBool::new(false),
            cancel_analysis: AtomicBool::new(false),
            plan: Mutex::new(None),
            wf_misses: libsync::waveforms::Misses::default(),
            wf_filling: AtomicBool::new(false),
            wf_again: AtomicBool::new(false),
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
            syncing: AtomicBool::new(false),
            fixing: AtomicBool::new(false),
            analyzing: AtomicBool::new(false),
            usb_exporting: AtomicBool::new(false),
            cancel_analysis: AtomicBool::new(false),
            plan: Mutex::new(None),
            wf_misses: libsync::waveforms::Misses::default(),
            wf_filling: AtomicBool::new(false),
            wf_again: AtomicBool::new(false),
        };
        assert!(!export_inner(&state, false).expect("no-op"));
    }
}
