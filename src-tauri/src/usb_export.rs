//! Copies playlists onto a USB drive and writes them in the formats asked for ([`Outputs`]):
//! rekordbox's two libraries (the Device Library `export.pdb` for the CDJ-3000 and older, and
//! `OneLibrary` `exportLibrary.db` for the CDJ-3000X, OPUS-QUAD, XDJ-AZ, OMNIS-DUO), Serato
//! crates, a Gemini library, and the playlists as folders. All are written from one list of the
//! drive's songs and playlists, so they hold the same tracks, ids and playlists. That list is
//! the rekordbox library when one is written, and manplay's own copy of it otherwise.
//!
//! The drive's existing library is kept: its tracks keep their ids (so rekordbox's beat grids and
//! `exportExt.pdb` tags still line up) and its playlists stay, except ones with the same name as
//! an exported playlist, which are replaced. `Mode` can also take every other playlist and
//! folder away, and then every song no remaining playlist holds. [`preview`] works out the same
//! changes without writing anything, for the review before an export. Songs already on the drive, matched by path or by
//! exact file size, are not copied again.

#![allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]

use crate::analysis::{self, Detail};
use crate::anlz;
use crate::gemini;
use crate::onelib;
use crate::pdb::{self, Library};
use crate::playlist_folders;
use crate::serato;
use crate::usb::{BACKUP_DIR, ONE_LIBRARY_PATH, OWN_LIBRARY_PATH, PDB_PATH};
use crate::usb_files::on_drive;
use crate::usb_files::remove_if_there;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// A library song to put on the drive.
#[derive(Debug, Clone)]
pub struct Source {
    pub id: i64,
    pub path: PathBuf,
    pub artist: String,
    pub album: String,
    pub title: String,
    pub size: u64,
    pub duration_ms: Option<i64>,
    pub bitrate: Option<i64>,
    pub sample_rate: Option<i64>,
    pub bpm: Option<f64>,
    /// As the player should show it, already in the chosen notation.
    pub key: Option<String>,
    /// `audio_fp`, under which manplay keeps the song's analysis.
    pub audio_fp: Option<String>,
    /// The beat grid was set by hand: it replaces the grid in analysis files rekordbox wrote.
    pub grid_edited: bool,
    /// Cues set in manplay, which replace the drive's own; `None` when never set here.
    pub cues: Option<Vec<crate::db::Cue>>,
}

#[derive(Debug, Clone)]
pub struct SourcePlaylist {
    pub name: String,
    pub track_ids: Vec<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Copying,
    /// Working out beat grids and waveforms for songs new to the drive.
    Analyzing,
    Writing,
    /// Copying songs that are in more than one playlist into the further playlist folders.
    Folders,
    /// Writing the libraries other than rekordbox's that were asked for (see [`Outputs`]).
    Libraries,
}

/// What an export writes onto the drive besides the songs, each for the players that read it.
/// All are made from the same list of the drive's songs and playlists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
#[allow(clippy::struct_excessive_bools)] // one switch a format, each on or off by itself
pub struct Outputs {
    /// rekordbox's libraries, for Pioneer's players (CDJ, XDJ, OPUS). Without it, one already on
    /// the drive is removed (a copy is kept), so no player reads a library that is out of date.
    pub rekordbox: bool,
    /// The playlists as Serato crates (see [`serato`]).
    pub serato: bool,
    /// The library Gemini MDJ players read (see [`gemini`]).
    pub gemini: bool,
    /// Each playlist as a folder of its songs, for players that only browse folders (see
    /// [`playlist_folders`]).
    pub playlist_folders: bool,
}

impl Default for Outputs {
    /// rekordbox alone, which is what an export wrote before there was a choice.
    fn default() -> Self {
        Self {
            rekordbox: true,
            serato: false,
            gemini: false,
            playlist_folders: false,
        }
    }
}

impl Outputs {
    /// Whether songs need a beat grid and waveform on the drive: rekordbox's players read them,
    /// and the Gemini library is made from them.
    fn needs_analysis(self) -> bool {
        self.rekordbox || self.gemini
    }

    /// The libraries written after the drive's own list of songs.
    fn any_other_library(self) -> bool {
        self.serato || self.gemini
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: Phase,
    pub done: usize,
    pub total: usize,
    pub current: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Songs copied onto the drive.
    pub copied: usize,
    /// Songs that were already on the drive.
    pub already_there: usize,
    pub bytes_copied: u64,
    /// Songs given a beat grid and waveform.
    pub analyzed: usize,
    /// Songs already on the drive whose beat grid changed since (edited in manplay) and was
    /// rewritten.
    pub regridded: usize,
    /// Playlists written (new or replaced).
    pub playlists: usize,
    /// Playlists and folders taken off the drive because they were not exported.
    pub playlists_removed: usize,
    /// Songs deleted from the drive because no playlist held them any more.
    pub songs_deleted: usize,
    pub bytes_freed: u64,
    /// Tracks in the drive's library afterwards.
    pub library_tracks: usize,
    /// Folder on the drive holding copies of both previous databases.
    pub backup: Option<String>,
    /// Whether rekordbox's libraries were written.
    pub rekordbox: bool,
    /// Whether `exportLibrary.db` was written alongside `export.pdb`.
    pub one_library: bool,
    /// Why it was not; the drive's old copy is then removed so players never read a stale one.
    pub one_library_error: Option<String>,
    /// Serato crates written; `None` when the export was not asked to write them.
    pub serato_crates: Option<usize>,
    /// Serato crates taken off the drive with their playlists.
    pub serato_crates_removed: usize,
    /// Why the Serato crates could not be written. The rekordbox libraries were written.
    pub serato_error: Option<String>,
    /// The Gemini library written; `None` when the export was not asked to write it.
    pub gemini: Option<gemini::Summary>,
    /// Why it could not be written. The rekordbox libraries were written.
    pub gemini_error: Option<String>,
    /// What the playlist folders hold; `None` when the export was not asked for them.
    pub playlist_folders: Option<playlist_folders::Summary>,
    /// Why the playlist folders could not be finished. The rekordbox libraries were written.
    pub playlist_folders_error: Option<String>,
    pub failed: Vec<Failure>,
}

/// Rekordbox's names for a song with no artist or album.
const UNKNOWN_ARTIST: &str = "UnknownArtist";
const UNKNOWN_ALBUM: &str = "UnknownAlbum";
/// Longest file or folder name written; rekordbox stays well inside FAT32's 255.
const MAX_NAME: usize = 120;
/// rekordbox's newer database and its SQLite side files. The side files go before a new database
/// goes in: SQLite would replay an old `-wal` into it.
const ONE_LIBRARY: [&str; 3] = [
    "exportLibrary.db",
    "exportLibrary.db-wal",
    "exportLibrary.db-shm",
];

/// A file or folder name FAT32 and exFAT accept.
pub fn safe_name(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let mut out = cleaned.trim().trim_end_matches(['.', ' ']).to_owned();
    if out.len() > MAX_NAME {
        let mut cut = MAX_NAME;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        let kept = out.trim_end_matches(['.', ' ']).len();
        out.truncate(kept);
    }
    if out.is_empty() || out.chars().all(|c| c == '.') {
        fallback.to_owned()
    } else {
        out
    }
}

/// Keeps the extension when shortening a file name.
fn safe_file_name(name: &str) -> String {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && e.len() <= 5 => (s, Some(e)),
        _ => (name, None),
    };
    let ext = ext.map(|e| safe_name(e, "")).unwrap_or_default();
    let room = MAX_NAME.saturating_sub(ext.len() + 1).max(1);
    let mut stem = safe_name(stem, "track");
    if stem.len() > room {
        let mut cut = room;
        while !stem.is_char_boundary(cut) {
            cut -= 1;
        }
        stem.truncate(cut);
    }
    if ext.is_empty() {
        stem
    } else {
        format!("{stem}.{ext}")
    }
}

/// `/Contents/Artist/Album/file.mp3`, the layout rekordbox uses.
fn content_path(s: &Source) -> String {
    let file = s
        .path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    content_path_of(&s.artist, &s.album, &file)
}

/// Where a song with these tags and file name goes in `Contents`.
pub(crate) fn content_path_of(artist: &str, album: &str, file_name: &str) -> String {
    format!(
        "/Contents/{}/{}/{}",
        safe_name(artist, UNKNOWN_ARTIST),
        safe_name(album, UNKNOWN_ALBUM),
        safe_file_name(file_name)
    )
}

/// `/Contents/A/B/x.mp3` → `/Contents/A/B/x (2).mp3`.
pub(crate) fn numbered(path: &str, n: usize) -> String {
    match path.rsplit_once('.') {
        Some((stem, ext)) if !ext.contains('/') => format!("{stem} ({n}).{ext}"),
        _ => format!("{path} ({n})"),
    }
}

/// `YYYY-MM-DD` for a Unix time, in UTC.
pub fn date(unix: i64) -> String {
    // Howard Hinnant's days-to-civil.
    let z = unix.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Copies without extended attributes, so macOS leaves no `._` files on FAT drives. Writes to a
/// temporary name first so a pulled drive never holds half a song under the real name.
pub(crate) fn copy_file(from: &Path, to: &Path) -> io::Result<u64> {
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir)?;
    }
    let part = to.with_extension("manplay-part");
    let result = (|| {
        let mut src = fs::File::open(from)?;
        let mut dst = fs::File::create(&part)?;
        let n = io::copy(&mut src, &mut dst)?;
        dst.sync_all()?;
        Ok(n)
    })();
    match result {
        Ok(n) => {
            fs::rename(&part, to)?;
            Ok(n)
        }
        Err(e) => {
            let _ = fs::remove_file(&part);
            Err(e)
        }
    }
}

struct Planned<'a> {
    source: &'a Source,
    /// Path on the drive.
    dest: String,
    /// Existing drive track to reuse, if the song is already there.
    existing: Option<u32>,
}

/// Decides where each song goes and which are already on the drive.
fn plan<'a>(lib: &Library, mount: &Path, sources: &[&'a Source]) -> Vec<Planned<'a>> {
    let by_path: HashMap<String, u32> = lib
        .tracks
        .iter()
        .map(|t| (t.path.to_lowercase(), t.id))
        .collect();
    let mut by_size: HashMap<u32, Vec<u32>> = HashMap::new();
    // A song in a playlist folder is not at its `Contents` path, but keeps its file name.
    let mut by_name_and_size: HashMap<(String, u32), Vec<u32>> = HashMap::new();
    for t in &lib.tracks {
        by_size.entry(t.file_size).or_default().push(t.id);
        let name = playlist_folders::base_name(&t.path).to_lowercase();
        by_name_and_size
            .entry((name, t.file_size))
            .or_default()
            .push(t.id);
    }
    let mut taken: HashSet<String> = by_path.keys().cloned().collect();
    let mut out = Vec::new();
    for &s in sources {
        let dest = content_path(s);
        let size = u32::try_from(s.size).unwrap_or(u32::MAX);
        let name = dest.rsplit('/').next().unwrap_or_default().to_lowercase();
        let only = |ids: Option<&Vec<u32>>| match ids.map(Vec::as_slice) {
            Some([only]) if size > 0 => Some(*only),
            _ => None,
        };
        let existing = by_path
            .get(&dest.to_lowercase())
            .copied()
            .or_else(|| only(by_name_and_size.get(&(name, size))))
            // rekordbox shortens long names, so fall back to an exact size match.
            .or_else(|| only(by_size.get(&size)));
        if let Some(id) = existing {
            out.push(Planned {
                source: s,
                dest: String::new(),
                existing: Some(id),
            });
            continue;
        }
        // A file already sitting at the destination with the same size is this song from an
        // earlier export that did not finish writing the database.
        let mut chosen = dest.clone();
        let mut n = 1;
        loop {
            let path = on_drive(mount, &chosen);
            let free = !taken.contains(&chosen.to_lowercase());
            let same = fs::metadata(&path).is_ok_and(|m| m.len() == s.size);
            if free && (same || !path.exists()) {
                break;
            }
            n += 1;
            chosen = numbered(&dest, n);
        }
        taken.insert(chosen.to_lowercase());
        out.push(Planned {
            source: s,
            dest: chosen,
            existing: None,
        });
    }
    out
}

fn new_track(s: &Source, id: u32, dest: &str, today: &str) -> pdb::Track {
    let ext = dest.rsplit_once('.').map(|(_, e)| e).unwrap_or_default();
    let title = if s.title.is_empty() {
        dest.rsplit('/')
            .next()
            .and_then(|f| f.rsplit_once('.').map(|(stem, _)| stem))
            .unwrap_or_default()
            .to_owned()
    } else {
        s.title.clone()
    };
    pdb::Track {
        id,
        title,
        artist: s.artist.clone(),
        album: s.album.clone(),
        key: s.key.clone().unwrap_or_default(),
        path: dest.to_owned(),
        date_added: today.to_owned(),
        duration_secs: s
            .duration_ms
            .map_or(0, |ms| u16::try_from((ms + 500) / 1000).unwrap_or(u16::MAX)),
        tempo: s.bpm.map_or(0, |b| (b * 100.0).round() as u32),
        bitrate: s.bitrate.map_or(0, |b| u32::try_from(b).unwrap_or(0)),
        sample_rate: s.sample_rate.map_or(0, |r| u32::try_from(r).unwrap_or(0)),
        file_size: u32::try_from(s.size).unwrap_or(u32::MAX),
        file_type: pdb::file_type(ext),
        ..pdb::Track::default()
    }
}

/// Keeps a copy of both current databases in `PIONEER/manplay-backup/<stamp>`.
pub(crate) fn back_up(mount: &Path, stamp: &str) -> io::Result<Option<String>> {
    let rekordbox = mount.join("PIONEER/rekordbox");
    let pdb = rekordbox.join("export.pdb");
    let one: Vec<PathBuf> = ONE_LIBRARY
        .iter()
        .map(|n| rekordbox.join(n))
        .filter(|p| p.exists())
        .collect();
    if !pdb.exists() && one.is_empty() {
        return Ok(None);
    }
    let rel = format!("PIONEER/manplay-backup/{stamp}");
    let dir = mount.join(&rel);
    fs::create_dir_all(&dir)?;
    // A folder already holding a copy keeps it: that copy is the older, the one worth keeping.
    let copy = dir.join("export.pdb");
    if pdb.exists() && !copy.exists() {
        copy_file(&pdb, &copy)?;
    }
    for p in one {
        if let Some(name) = p.file_name() {
            copy_file(&p, &dir.join(name))?;
        }
    }
    Ok(Some(format!("/{rel}")))
}

/// The library database, where each song's beat grid and waveform are kept (see [`anlz::load`]).
pub type Store = std::sync::Mutex<rusqlite::Connection>;

/// A song's analysis for the drive, and a key detected along the way.
struct Analyzed {
    stored: anlz::Stored,
    key: Option<String>,
}

/// The analysis manplay already keeps for the song, or a fresh one (then kept too). A kept
/// analysis without a beat grid is redone when the library has a tempo to lay one out with.
fn analyzed(source: &Source, store: Option<&Store>) -> Result<Analyzed, String> {
    let kept = store
        .zip(source.audio_fp.as_deref())
        .and_then(|(db, fp)| anlz::load(&*db.lock().ok()?, fp))
        .filter(|s| s.grid_bpm.is_some() || source.bpm.is_none());
    if let Some(stored) = kept {
        return Ok(Analyzed { stored, key: None });
    }
    let d: Detail = analysis::analyze_detail(&source.path, source.bpm)?;
    let stored = anlz::Stored::from_detail(&d);
    if let (Some(db), Some(fp)) = (store, source.audio_fp.as_deref())
        && let Ok(conn) = db.lock()
    {
        // Keeping it only saves time next export; failing to is not worth stopping for.
        if anlz::save(&conn, fp, &stored).is_ok()
            && let Ok(mut ops) = crate::libsync::Batch::new(&conn)
        {
            crate::db::share_auto_grid(&mut ops, fp, &stored);
            let _ = ops.commit(&conn);
        }
    }
    Ok(Analyzed {
        stored,
        key: d.analysis.key,
    })
}

/// Beat grid and waveform for each job's source file, on all but one core.
fn analyze_all(
    jobs: &[(usize, &Source)],
    store: Option<&Store>,
    progress: &mut impl FnMut(Progress),
) -> Vec<Result<Analyzed, String>> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let total = jobs.len();
    let mut out: Vec<Option<Result<Analyzed, String>>> = (0..total).map(|_| None).collect();
    if total == 0 {
        return Vec::new();
    }
    let workers = std::thread::available_parallelism()
        .map_or(2, std::num::NonZero::get)
        .saturating_sub(1)
        .clamp(1, 8)
        .min(total);
    let next = AtomicUsize::new(0);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        for _ in 0..workers {
            let tx = tx.clone();
            let next = &next;
            scope.spawn(move || {
                loop {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    let Some((_, source)) = jobs.get(i) else {
                        break;
                    };
                    let result = analyzed(source, store);
                    if tx.send((i, result)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);
        for (done, (i, result)) in rx.iter().enumerate() {
            progress(Progress {
                phase: Phase::Analyzing,
                done,
                total,
                current: jobs[i].1.title.clone(),
            });
            out[i] = Some(result);
        }
    });
    out.into_iter()
        .map(|r| r.unwrap_or_else(|| Err("not analyzed".to_owned())))
        .collect()
}

/// Writes a track's `.DAT` and `.EXT` files and points the track at them; fills in a tempo and
/// key the library did not have.
fn write_analysis(
    mount: &Path,
    track: &mut pdb::Track,
    a: &Analyzed,
    source: &Source,
    camelot: bool,
) -> Result<(), String> {
    let d = &a.stored;
    let rel = anlz::dat_path(track.id, &track.path);
    let (dat, ext) = anlz::files(
        &track.path,
        d,
        source.cues.as_deref().unwrap_or_default(),
        anlz::mp3_samples(&source.path),
    );
    let dat_path = on_drive(mount, &rel);
    write_atomic(&dat_path, &dat).map_err(|e| e.to_string())?;
    write_atomic(&dat_path.with_extension("EXT"), &ext).map_err(|e| e.to_string())?;
    track.analyze_path = rel;
    if track.tempo == 0
        && let Some(bpm) = d.grid_bpm
    {
        track.tempo = (bpm * 100.0).round() as u32;
    }
    if track.key.is_empty()
        && let Some(key) = &a.key
    {
        track.key = if camelot {
            analysis::camelot(key).unwrap_or_else(|| key.clone())
        } else {
            key.clone()
        };
    }
    Ok(())
}

/// New contents for a song's analysis files on the drive, from the kept analysis: the whole files
/// when manplay wrote them; when rekordbox did, just what was set by hand in manplay (beat grid,
/// cues) swapped into its files, keeping the rest. `None` to leave the song alone.
fn refreshed(
    mount: &Path,
    track: &pdb::Track,
    stored: &anlz::Stored,
    source: &Source,
) -> Option<Vec<(PathBuf, Vec<u8>)>> {
    if track.analyze_path.is_empty() {
        return None;
    }
    let dat_path = on_drive(mount, &track.analyze_path);
    let ext_path = dat_path.with_extension("EXT");
    let cues = source.cues.as_deref();
    if track.analyze_path == anlz::dat_path(track.id, &track.path) {
        let (dat, ext) = anlz::files(
            &track.path,
            stored,
            cues.unwrap_or_default(),
            anlz::mp3_samples(&source.path),
        );
        return Some(vec![(dat_path, dat), (ext_path, ext)]);
    }
    let grid = source.grid_edited.then_some(stored);
    if grid.is_none() && cues.is_none() {
        return None;
    }
    let mut out = Vec::new();
    for path in [dat_path, ext_path] {
        if let Ok(old) = fs::read(&path)
            && let Some(new) = anlz::patch(&old, grid, cues)
        {
            out.push((path, new));
        }
    }
    Some(out)
}

/// Songs already on the drive get their beat grid and waveform rewritten from the kept analysis
/// when it changed since, so grid edits reach the drive (see [`refreshed`]).
fn refresh_grids(
    mount: &Path,
    lib: &mut Library,
    planned: &[Planned],
    store: Option<&Store>,
    report: &mut Report,
) {
    let Some(db) = store else { return };
    for p in planned {
        let Some(id) = p.existing else { continue };
        let Some(track) = lib.tracks.iter_mut().find(|t| t.id == id) else {
            continue;
        };
        let Some(stored) = p
            .source
            .audio_fp
            .as_deref()
            .and_then(|fp| anlz::load(&*db.lock().ok()?, fp))
        else {
            continue;
        };
        let Some(files) = refreshed(mount, track, &stored, p.source) else {
            continue;
        };
        let changed: Vec<_> = files
            .into_iter()
            .filter(|(path, bytes)| fs::read(path).ok().as_deref() != Some(bytes.as_slice()))
            .collect();
        // The tempo the player lists goes with the grid it draws (unless that grid is rekordbox's).
        if let (Some(bpm), true) = (
            stored.grid_bpm,
            p.source.grid_edited || track.analyze_path == anlz::dat_path(track.id, &track.path),
        ) {
            track.tempo = (bpm * 100.0).round() as u32;
        }
        if changed.is_empty() {
            continue;
        }
        match changed
            .iter()
            .try_for_each(|(path, bytes)| write_atomic(path, bytes))
        {
            Ok(()) => report.regridded += 1,
            Err(e) => report.failed.push(Failure {
                path: p.source.path.display().to_string(),
                error: format!("beat grid: {e}"),
            }),
        }
    }
}

/// Writes under a temporary name and renames, so a pulled drive never holds half a file.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("manplay-tmp");
    let mut f = fs::File::create(&tmp)?;
    io::Write::write_all(&mut f, bytes)?;
    f.sync_all()?;
    fs::rename(&tmp, path)
}

pub struct Options<'a> {
    pub today: &'a str,
    /// Names the backup folder, e.g. `2026-11-15-1530`.
    pub stamp: &'a str,
    pub free_bytes: u64,
    /// The library database, whose kept analyses are reused and added to; `None` to always
    /// analyse afresh.
    pub store: Option<&'a Store>,
    /// Show detected keys as Camelot codes (`8A`) rather than `Am`.
    pub camelot: bool,
    pub mode: Mode,
    pub outputs: Outputs,
}

/// What happens to what is already on the drive.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Other playlists stay; same-named ones are replaced.
    #[default]
    Add,
    /// Only the exported playlists stay; every song stays.
    ReplacePlaylists,
    /// Only the exported playlists stay, and songs none of them hold are deleted.
    ReplaceAll,
}

impl Mode {
    fn removes_playlists(self) -> bool {
        self != Self::Add
    }
}

/// Removes the drive's `OneLibrary` and its side files.
fn remove_one_library(mount: &Path) -> io::Result<()> {
    let rekordbox = mount.join("PIONEER/rekordbox");
    for name in ONE_LIBRARY {
        match fs::remove_file(rekordbox.join(name)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

/// The drive's songs and playlists, and the sequence number to write after: its `export.pdb`
/// with what only its `OneLibrary` has added, or the list manplay keeps on a drive without a
/// rekordbox library. Ids are kept.
pub(crate) fn read_libraries(mount: &Path) -> Result<(Library, u32), String> {
    let pdb_path = mount.join(PDB_PATH);
    let own_path = mount.join(OWN_LIBRARY_PATH);
    let read = |path: &Path| -> Result<Option<(Library, u32)>, String> {
        match fs::read(path) {
            Ok(bytes) => {
                let lib = pdb::read(&bytes).map_err(|e| {
                    format!("The drive's library could not be read, so it was left alone: {e}")
                })?;
                Ok(Some((lib, pdb::sequence(&bytes).unwrap_or(1))))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    };
    let (mut lib, sequence) = match read(&pdb_path)? {
        Some(found) => found,
        None => read(&own_path)?.unwrap_or_else(|| (Library::default(), 1)),
    };
    // Tracks and playlists rekordbox put only in the newer library (it does not always write
    // the same playlists to both). An unreadable one is replaced, its copy kept in the backup.
    let one_path = mount.join(ONE_LIBRARY_PATH);
    if one_path.is_file()
        && let Ok(one) = onelib::read(&one_path)
    {
        onelib::merge(&mut lib, one);
    }
    Ok((lib, sequence))
}

/// Whether the drive at `mount` has a rekordbox library.
pub(crate) fn has_rekordbox(mount: &Path) -> bool {
    mount.join(PDB_PATH).is_file() || mount.join(ONE_LIBRARY_PATH).is_file()
}

/// Whether the drive at `mount` has a list of songs and playlists at all.
pub(crate) fn has_library(mount: &Path) -> bool {
    has_rekordbox(mount) || mount.join(OWN_LIBRARY_PATH).is_file()
}

/// Saves `lib` as the drive's list of songs and playlists, after keeping a copy of the rekordbox
/// libraries there. With `rekordbox` that is both rekordbox libraries (`export.pdb` and
/// `OneLibrary`); without, manplay's own file, and the rekordbox libraries are removed so no
/// player reads one that is out of date. Returns the backup folder, and whether the `OneLibrary`
/// could be written; when it could not, the old one is removed for the same reason.
pub(crate) fn write_libraries(
    mount: &Path,
    lib: &Library,
    sequence: u32,
    stamp: &str,
    today: &str,
    rekordbox: bool,
) -> Result<(Option<String>, Result<(), String>), String> {
    let pdb_path = mount.join(PDB_PATH);
    let one_path = mount.join(ONE_LIBRARY_PATH);
    let own_path = mount.join(OWN_LIBRARY_PATH);
    let bytes = pdb::write(lib, sequence + 1);
    if !rekordbox {
        let backup =
            back_up(mount, stamp).map_err(|e| format!("backing up the old library: {e}"))?;
        write_atomic(&own_path, &bytes)
            .map_err(|e| format!("writing {}: {e}", own_path.display()))?;
        remove_if_there(&pdb_path)
            .and_then(|()| remove_one_library(mount))
            .map_err(|e| format!("removing the rekordbox library: {e}"))?;
        return Ok((backup, Ok(())));
    }
    // Built before anything on the drive changes; written after export.pdb.
    let one_bytes = onelib::build(one_path.is_file().then_some(one_path.as_path()), lib, today);
    let backup = back_up(mount, stamp).map_err(|e| format!("backing up the old library: {e}"))?;
    write_atomic(&pdb_path, &bytes).map_err(|e| format!("writing {}: {e}", pdb_path.display()))?;
    let written = one_bytes.and_then(|b| {
        remove_one_library(mount).map_err(|e| e.to_string())?;
        write_atomic(&one_path, &b).map_err(|e| e.to_string())
    });
    let one = written.map_err(|e| match remove_one_library(mount) {
        Ok(()) => e,
        Err(r) => format!("{e}; the old OneLibrary could not be removed either: {r}"),
    });
    // The rekordbox library is the drive's list now; a second one would only go stale.
    remove_if_there(&own_path).map_err(|e| format!("removing {}: {e}", own_path.display()))?;
    Ok((backup, one))
}

/// Puts `playlists` (with their songs from `sources`) on the drive at `mount`.
#[allow(clippy::too_many_lines)] // one pass: read, plan, copy, playlists, back up, write
pub fn export(
    mount: &Path,
    sources: &[Source],
    playlists: &[SourcePlaylist],
    opts: &Options,
    mut progress: impl FnMut(Progress),
) -> Result<Report, String> {
    let (mut lib, sequence) = read_libraries(mount)?;

    let by_id: HashMap<i64, &Source> = sources.iter().map(|s| (s.id, s)).collect();
    let mut wanted = Vec::new();
    let mut seen = HashSet::new();
    for p in playlists {
        for id in &p.track_ids {
            if let Some(s) = by_id.get(id)
                && seen.insert(*id)
            {
                wanted.push(*s);
            }
        }
    }
    let planned = plan(&lib, mount, &wanted);
    let to_copy: Vec<&Planned> = planned
        .iter()
        .filter(|p| p.existing.is_none() && !on_drive(mount, &p.dest).exists())
        .collect();
    let needed: u64 = to_copy.iter().map(|p| p.source.size).sum();
    // Leave room for the database and analysis files.
    if needed + 16 * 1024 * 1024 > opts.free_bytes {
        return Err(format!(
            "Not enough space on the drive: the songs need {} MB and {} MB is free.",
            needed / 1_000_000,
            opts.free_bytes / 1_000_000
        ));
    }

    let mut report = Report::default();
    let mut placed: HashMap<i64, u32> = HashMap::new();
    let mut next_id = lib.tracks.iter().map(|t| t.id).max().unwrap_or(0) + 1;
    let total = to_copy.len();
    let mut done = 0;
    for p in &planned {
        if let Some(id) = p.existing {
            report.already_there += 1;
            placed.insert(p.source.id, id);
            continue;
        }
        let dest = on_drive(mount, &p.dest);
        if dest.exists() {
            report.already_there += 1;
        } else {
            progress(Progress {
                phase: Phase::Copying,
                done,
                total,
                current: p.source.title.clone(),
            });
            match copy_file(&p.source.path, &dest) {
                Ok(n) => {
                    report.copied += 1;
                    report.bytes_copied += n;
                }
                Err(e) => {
                    report.failed.push(Failure {
                        path: p.source.path.display().to_string(),
                        error: e.to_string(),
                    });
                    done += 1;
                    continue;
                }
            }
            done += 1;
        }
        lib.tracks
            .push(new_track(p.source, next_id, &p.dest, opts.today));
        placed.insert(p.source.id, next_id);
        next_id += 1;
    }

    let jobs: Vec<(usize, &Source)> = lib
        .tracks
        .iter()
        .enumerate()
        .filter(|(_, t)| opts.outputs.needs_analysis() && t.analyze_path.is_empty())
        .filter_map(|(i, t)| {
            let source = planned
                .iter()
                .find(|p| placed.get(&p.source.id) == Some(&t.id))?
                .source;
            Some((i, source))
        })
        .collect();
    let results = analyze_all(&jobs, opts.store, &mut progress);
    for ((index, source), result) in jobs.iter().zip(results) {
        let track = &mut lib.tracks[*index];
        match result
            .and_then(|d| write_analysis(mount, track, &d, source, opts.camelot).map(|()| d))
        {
            Ok(_) => report.analyzed += 1,
            Err(e) => report.failed.push(Failure {
                path: source.path.display().to_string(),
                error: format!("analysis: {e}"),
            }),
        }
    }

    if opts.outputs.needs_analysis() {
        refresh_grids(mount, &mut lib, &planned, opts.store, &mut report);
    }

    progress(Progress {
        phase: Phase::Writing,
        done: total,
        total,
        current: String::new(),
    });
    let removed = if opts.mode.removes_playlists() {
        remove_other_playlists(&mut lib, playlists)
    } else {
        Vec::new()
    };
    report.playlists_removed = removed.len();
    let mut next_playlist = lib.playlists.iter().map(|p| p.id).max().unwrap_or(0) + 1;
    let mut next_sort = lib
        .playlists
        .iter()
        .filter(|p| p.parent_id == 0)
        .map(|p| p.sort_order + 1)
        .max()
        .unwrap_or(0);
    for p in playlists {
        let track_ids: Vec<u32> = p
            .track_ids
            .iter()
            .filter_map(|id| placed.get(id).copied())
            .collect();
        if let Some(existing) = lib
            .playlists
            .iter_mut()
            .find(|e| e.parent_id == 0 && !e.is_folder && e.name == p.name)
        {
            existing.track_ids = track_ids;
        } else {
            lib.playlists.push(pdb::Playlist {
                id: next_playlist,
                parent_id: 0,
                name: p.name.clone(),
                is_folder: false,
                sort_order: next_sort,
                track_ids,
            });
            next_playlist += 1;
            next_sort += 1;
        }
        report.playlists += 1;
    }

    let unheld = if opts.mode == Mode::ReplaceAll {
        take_unheld_tracks(&mut lib)
    } else {
        Vec::new()
    };
    // Songs move to where the playlists put them before the libraries are written, so the
    // libraries name the files where they are.
    let arrangement = playlist_folders::move_homes(mount, &mut lib, opts.outputs.playlist_folders);
    for (path, error) in &arrangement.failed {
        report.failed.push(Failure {
            path: path.clone(),
            error: format!("could not be moved to its playlist folder: {error}"),
        });
    }
    let (backup, one) = write_libraries(
        mount,
        &lib,
        sequence,
        opts.stamp,
        opts.today,
        opts.outputs.rekordbox,
    )?;
    report.backup = backup;
    report.rekordbox = opts.outputs.rekordbox;
    let mut gone: Vec<String> = unheld.iter().map(|t| t.path.clone()).collect();
    gone.extend(arrangement.moved_from.iter().cloned());
    let filled = arrangement.fill(mount, &lib, |done, total, name| {
        progress(Progress {
            phase: Phase::Folders,
            done,
            total,
            current: name.to_owned(),
        });
    });
    let copies = match filled {
        Ok((summary, copies)) => {
            report.playlist_folders = opts.outputs.playlist_folders.then_some(summary);
            copies
        }
        Err(e) => {
            report.playlist_folders_error = Some(e);
            Vec::new()
        }
    };
    if opts.outputs.any_other_library() {
        progress(Progress {
            phase: Phase::Libraries,
            done: 0,
            total: 0,
            current: String::new(),
        });
    }
    if opts.outputs.serato {
        let removals = SeratoRemovals {
            playlists: &removed,
            songs: &gone,
        };
        write_serato(mount, &lib, playlists, &removals, opts.stamp, &mut report);
    }
    if opts.outputs.gemini {
        let known: HashMap<u32, gemini::FromLibrary> = planned
            .iter()
            .filter_map(|p| {
                let from_library = gemini::FromLibrary {
                    cues: p.source.cues.clone(),
                    art_from: Some(p.source.path.clone()),
                };
                Some((*placed.get(&p.source.id)?, from_library))
            })
            .collect();
        match gemini::write(mount, &lib, &known, opts.stamp, &copies) {
            Ok(summary) => report.gemini = Some(summary),
            Err(e) => report.gemini_error = Some(e),
        }
    }
    // Only once the libraries no longer list them, so a player never sees a missing file.
    delete_track_files(mount, &lib, &unheld, &mut report);
    match one {
        Ok(()) => report.one_library = opts.outputs.rekordbox,
        Err(e) => report.one_library_error = Some(e),
    }
    report.library_tracks = lib.tracks.len();
    Ok(report)
}

/// Takes out of the library every track no playlist holds, returning them.
fn take_unheld_tracks(lib: &mut Library) -> Vec<pdb::Track> {
    let held: HashSet<u32> = lib
        .playlists
        .iter()
        .flat_map(|p| p.track_ids.iter().copied())
        .collect();
    let (keep, gone): (Vec<_>, Vec<_>) = std::mem::take(&mut lib.tracks)
        .into_iter()
        .partition(|t| held.contains(&t.id));
    lib.tracks = keep;
    gone
}

/// Deletes the song files and analysis files of tracks taken out of the library. Analysis files
/// another track still uses stay.
fn delete_track_files(mount: &Path, lib: &Library, gone: &[pdb::Track], report: &mut Report) {
    let in_use: HashSet<&str> = lib.tracks.iter().map(|t| t.analyze_path.as_str()).collect();
    for t in gone {
        let song = on_drive(mount, &t.path);
        let size = fs::metadata(&song).map_or(0, |m| m.len());
        match fs::remove_file(&song) {
            Ok(()) => {
                report.songs_deleted += 1;
                report.bytes_freed += size;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => report.songs_deleted += 1,
            Err(e) => report.failed.push(Failure {
                path: t.path.clone(),
                error: format!("could not delete: {e}"),
            }),
        }
        if t.analyze_path.is_empty() || in_use.contains(t.analyze_path.as_str()) {
            continue;
        }
        let dat = on_drive(mount, &t.analyze_path);
        for ext in ["DAT", "EXT", "2EX"] {
            let _ = fs::remove_file(dat.with_extension(ext));
        }
    }
}

/// A song as the review lists it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongRef {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub bpm: Option<f64>,
    pub key: Option<String>,
    pub duration_secs: Option<u32>,
    /// The library song, when there is one (for its artwork).
    pub track_id: Option<i64>,
    /// The file on the drive, for a song only the drive has.
    pub file: Option<String>,
}

impl SongRef {
    fn of_source(s: &Source) -> Self {
        Self {
            title: s.title.clone(),
            artist: s.artist.clone(),
            album: s.album.clone(),
            bpm: s.bpm,
            key: s.key.clone(),
            duration_secs: s.duration_ms.and_then(|ms| u32::try_from(ms / 1000).ok()),
            track_id: Some(s.id),
            file: None,
        }
    }

    fn of_drive(mount: &Path, t: &pdb::Track) -> Self {
        Self {
            title: t.title.clone(),
            artist: t.artist.clone(),
            album: t.album.clone(),
            bpm: (t.tempo > 0).then(|| f64::from(t.tempo) / 100.0),
            key: (!t.key.is_empty()).then(|| t.key.clone()),
            duration_secs: (t.duration_secs > 0).then_some(u32::from(t.duration_secs)),
            track_id: None,
            file: Some(on_drive(mount, &t.path).display().to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Change {
    Added,
    Updated,
    Unchanged,
    Removed,
}

/// What an export does to one playlist on the drive.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistChange {
    pub name: String,
    pub change: Change,
    /// Songs in it afterwards (before, for a removed one).
    pub songs: usize,
    pub added: Vec<SongRef>,
    pub removed: Vec<SongRef>,
    /// Every song in it afterwards, in order (before, for a removed one).
    pub tracks: Vec<SongRef>,
}

/// Everything an export would change on the drive, worked out without writing.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    pub playlists: Vec<PlaylistChange>,
    /// Songs new to the drive.
    pub copy: Vec<SongRef>,
    pub copy_bytes: u64,
    /// Songs deleted from the drive (`Mode::ReplaceAll`).
    pub delete: Vec<SongRef>,
    pub delete_bytes: u64,
}

/// A song in an exported playlist: one the drive has, or one the export copies.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Key {
    Drive(u32),
    New(i64),
}

/// How one exported playlist differs from the drive's playlist of the same name.
fn playlist_change(
    lib: &Library,
    p: &SourcePlaylist,
    key_of: &HashMap<i64, Key>,
    song: &impl Fn(Key) -> Option<SongRef>,
) -> PlaylistChange {
    let keys: Vec<Key> = p
        .track_ids
        .iter()
        .filter_map(|id| key_of.get(id).copied())
        .collect();
    let existing = lib
        .playlists
        .iter()
        .find(|e| e.parent_id == 0 && !e.is_folder && e.name == p.name);
    let old: Vec<Key> = existing
        .map(|e| e.track_ids.iter().map(|&id| Key::Drive(id)).collect())
        .unwrap_or_default();
    let old_set: HashSet<Key> = old.iter().copied().collect();
    let new_set: HashSet<Key> = keys.iter().copied().collect();
    let added: Vec<SongRef> = keys
        .iter()
        .filter(|k| !old_set.contains(k))
        .filter_map(|&k| song(k))
        .collect();
    let removed: Vec<SongRef> = old
        .iter()
        .filter(|k| !new_set.contains(k))
        .filter_map(|&k| song(k))
        .collect();
    let change = match existing {
        None => Change::Added,
        Some(_) if added.is_empty() && removed.is_empty() => Change::Unchanged,
        Some(_) => Change::Updated,
    };
    PlaylistChange {
        name: p.name.clone(),
        change,
        songs: keys.len(),
        added,
        removed,
        tracks: keys.iter().filter_map(|&k| song(k)).collect(),
    }
}

/// What [`export`] would do with these playlists, without touching the drive.
pub fn preview(
    mount: &Path,
    sources: &[Source],
    playlists: &[SourcePlaylist],
    mode: Mode,
) -> Result<Diff, String> {
    let (lib, _) = read_libraries(mount)?;
    let by_id: HashMap<i64, &Source> = sources.iter().map(|s| (s.id, s)).collect();
    let mut wanted = Vec::new();
    let mut seen = HashSet::new();
    for p in playlists {
        for id in &p.track_ids {
            if let Some(s) = by_id.get(id)
                && seen.insert(*id)
            {
                wanted.push(*s);
            }
        }
    }
    let planned = plan(&lib, mount, &wanted);
    let key_of: HashMap<i64, Key> = planned
        .iter()
        .map(|p| {
            let key = p.existing.map_or(Key::New(p.source.id), Key::Drive);
            (p.source.id, key)
        })
        .collect();
    // A drive song that is also in the library is described from the library, which knows more.
    let source_of: HashMap<u32, &Source> = planned
        .iter()
        .filter_map(|p| Some((p.existing?, p.source)))
        .collect();
    let drive_tracks: HashMap<u32, &pdb::Track> = lib.tracks.iter().map(|t| (t.id, t)).collect();
    let drive_song = |id: u32| {
        source_of.get(&id).map_or_else(
            || drive_tracks.get(&id).map(|t| SongRef::of_drive(mount, t)),
            |s| Some(SongRef::of_source(s)),
        )
    };
    let song = |key: Key| match key {
        Key::Drive(id) => drive_song(id),
        Key::New(id) => by_id.get(&id).map(|s| SongRef::of_source(s)),
    };

    let mut diff = Diff {
        playlists: playlists
            .iter()
            .map(|p| playlist_change(&lib, p, &key_of, &song))
            .collect(),
        ..Diff::default()
    };
    if mode.removes_playlists() {
        let names: HashSet<&str> = playlists.iter().map(|p| p.name.as_str()).collect();
        for e in &lib.playlists {
            if e.is_folder || (e.parent_id == 0 && names.contains(e.name.as_str())) {
                continue;
            }
            diff.playlists.push(PlaylistChange {
                name: e.name.clone(),
                change: Change::Removed,
                songs: e.track_ids.len(),
                added: Vec::new(),
                removed: Vec::new(),
                tracks: e
                    .track_ids
                    .iter()
                    .filter_map(|&id| drive_song(id))
                    .collect(),
            });
        }
    }
    for p in &planned {
        if p.existing.is_none() && !on_drive(mount, &p.dest).exists() {
            diff.copy_bytes += p.source.size;
            diff.copy.push(SongRef::of_source(p.source));
        }
    }
    if mode == Mode::ReplaceAll {
        let kept: HashSet<u32> = key_of
            .values()
            .filter_map(|k| match k {
                Key::Drive(id) => Some(*id),
                Key::New(_) => None,
            })
            .collect();
        for t in lib.tracks.iter().filter(|t| !kept.contains(&t.id)) {
            diff.delete_bytes += u64::from(t.file_size);
            diff.delete.push(SongRef::of_drive(mount, t));
        }
    }
    Ok(diff)
}

/// Keeps only the top-level playlists this export rewrites (so they keep their ids and place)
/// and drops every other playlist and folder. Returns the ones that went.
fn remove_other_playlists(lib: &mut Library, exported: &[SourcePlaylist]) -> Vec<pdb::Playlist> {
    let names: HashSet<&str> = exported.iter().map(|p| p.name.as_str()).collect();
    let (keep, gone) = std::mem::take(&mut lib.playlists)
        .into_iter()
        .partition(|p| p.parent_id == 0 && !p.is_folder && names.contains(p.name.as_str()));
    lib.playlists = keep;
    gone
}

/// The exported playlists as Serato crates, with their songs as the drive's library now has
/// them, and every song they hold.
fn serato_library(
    lib: &Library,
    exported: &[SourcePlaylist],
) -> (Vec<serato::Crate>, Vec<serato::Song>) {
    let tracks: HashMap<u32, &pdb::Track> = lib.tracks.iter().map(|t| (t.id, t)).collect();
    let mut seen_names = HashSet::new();
    let mut seen_songs = HashSet::new();
    let mut songs = Vec::new();
    let crates = exported
        .iter()
        .filter(|p| seen_names.insert(p.name.as_str()))
        .filter_map(|p| {
            let on_drive = lib
                .playlists
                .iter()
                .find(|e| e.parent_id == 0 && !e.is_folder && e.name == p.name)?;
            let held: Vec<&pdb::Track> = on_drive
                .track_ids
                .iter()
                .filter_map(|id| tracks.get(id).copied())
                .collect();
            for t in &held {
                if seen_songs.insert(t.id) {
                    songs.push(serato::Song {
                        path: serato::SeratoPath::from_drive_path(&t.path),
                        title: t.title.clone(),
                        artist: t.artist.clone(),
                        album: t.album.clone(),
                        bpm: (t.tempo > 0).then(|| f64::from(t.tempo) / 100.0),
                    });
                }
            }
            Some(serato::Crate {
                name: p.name.clone(),
                tracks: held
                    .iter()
                    .map(|t| serato::SeratoPath::from_drive_path(&t.path))
                    .collect(),
            })
        })
        .collect();
    (crates, songs)
}

/// What [`write_serato`] changes besides the exported playlists.
struct SeratoRemovals<'a> {
    /// Playlists this export took off the drive.
    playlists: &'a [pdb::Playlist],
    /// Paths of the songs this export deleted from the drive or moved on it.
    songs: &'a [String],
}

/// Writes the exported playlists to the drive as Serato crates with their songs in Serato's
/// `database V2`, and takes away the crates of playlists and the songs this export removed.
fn write_serato(
    mount: &Path,
    lib: &Library,
    exported: &[SourcePlaylist],
    removals: &SeratoRemovals,
    stamp: &str,
    report: &mut Report,
) {
    let remove_crates: Vec<String> = removals
        .playlists
        .iter()
        .filter(|p| !p.is_folder)
        .map(|p| p.name.clone())
        .collect();
    let deleted: Vec<serato::SeratoPath> = removals
        .songs
        .iter()
        .map(|path| serato::SeratoPath::from_drive_path(path))
        .collect();
    let (crates, songs) = serato_library(lib, exported);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u32::try_from(d.as_secs()).unwrap_or(u32::MAX));
    let update = serato::Update {
        crates: &crates,
        songs: &songs,
        remove_crates: &remove_crates,
        deleted: &deleted,
        now: serato::UnixSeconds(now),
    };
    let backup_rel = format!("{BACKUP_DIR}/{stamp}");
    match serato::write(mount, &update, &mount.join(&backup_rel)) {
        Ok(written) => {
            report.serato_crates = Some(written.crates);
            report.serato_crates_removed = written.removed;
            if written.backed_up && report.backup.is_none() {
                report.backup = Some(format!("/{backup_rel}"));
            }
        }
        Err(e) => report.serato_error = Some(e.to_string()),
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("manplay-usb-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).expect("temp dir");
        d
    }

    fn source(dir: &Path, id: i64, artist: &str, album: &str, file: &str, bytes: usize) -> Source {
        let path = dir.join(file);
        fs::write(&path, vec![id as u8; bytes]).expect("song");
        Source {
            id,
            path,
            artist: artist.into(),
            album: album.into(),
            title: format!("Song {id}"),
            size: bytes as u64,
            duration_ms: Some(200_400),
            bitrate: Some(320),
            sample_rate: Some(44_100),
            bpm: Some(140.0),
            key: Some("8A".into()),
            audio_fp: None,
            grid_edited: false,
            cues: None,
        }
    }

    fn test_store() -> Store {
        std::sync::Mutex::new(crate::db::open(Path::new(":memory:")).expect("db"))
    }

    fn opts(free: u64) -> Options<'static> {
        Options {
            today: "2026-11-15",
            stamp: "2026-11-15-1200",
            free_bytes: free,
            store: None,
            camelot: true,
            mode: Mode::Add,
            outputs: Outputs::default(),
        }
    }

    #[test]
    fn names_are_safe_for_fat_drives() {
        assert_eq!(safe_name("AC/DC: Live?", "x"), "AC_DC_ Live_");
        assert_eq!(safe_name("  ...  ", "Unknown"), "Unknown");
        assert_eq!(safe_name("Trailing dot.", "x"), "Trailing dot");
        let long = safe_file_name(&format!("{}.flac", "é".repeat(200)));
        assert!(
            long.len() <= MAX_NAME && long.to_lowercase().ends_with(".flac"),
            "{long}"
        );
    }

    #[test]
    fn dates_are_utc_days() {
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(1_763_208_000), "2025-11-15");
        assert_eq!(date(951_782_400), "2000-02-29");
    }

    #[test]
    #[allow(clippy::too_many_lines)] // one drive taken through every export mode in turn
    fn exports_then_reexports_without_copying_again() {
        let lib_dir = dir("lib");
        let usb = dir("usb");
        let sources = vec![
            source(&lib_dir, 1, "Burial", "Untrue", "01 Archangel.mp3", 1000),
            source(&lib_dir, 2, "", "", "loose.wav", 2000),
            source(&lib_dir, 3, "Burial", "Untrue", "02 Near Dark.mp3", 3000),
        ];
        let playlists = vec![
            SourcePlaylist {
                name: "Warm up".into(),
                track_ids: vec![3, 1],
            },
            SourcePlaylist {
                name: "Odd".into(),
                track_ids: vec![2, 99],
            },
        ];
        let report = export(&usb, &sources, &playlists, &opts(1 << 40), |_| {}).expect("exports");
        assert_eq!(
            (report.copied, report.already_there, report.playlists),
            (3, 0, 2)
        );
        assert_eq!(report.backup, None);
        assert!(report.one_library, "{:?}", report.one_library_error);
        assert!(
            usb.join("Contents/Burial/Untrue/01 Archangel.mp3")
                .is_file()
        );
        assert!(
            usb.join("Contents/UnknownArtist/UnknownAlbum/loose.wav")
                .is_file()
        );

        let lib = crate::usb::library(&usb).expect("reads back");
        assert_eq!(lib.tracks.len(), 3);
        let warm = lib
            .playlists
            .iter()
            .find(|p| p.name == "Warm up")
            .expect("playlist");
        let titles: Vec<&str> = warm
            .track_ids
            .iter()
            .map(|id| {
                lib.tracks
                    .iter()
                    .find(|t| t.id == *id)
                    .expect("track")
                    .title
                    .as_str()
            })
            .collect();
        assert_eq!(titles, ["Song 3", "Song 1"]);
        let t = &lib.tracks[0];
        assert_eq!(
            (t.tempo, t.key.as_str(), t.duration_secs, t.file_type),
            (14000, "8A", 200, 1)
        );

        // Again, with one playlist changed: nothing is copied and the playlist is replaced.
        let again = vec![SourcePlaylist {
            name: "Warm up".into(),
            track_ids: vec![1],
        }];
        let report = export(&usb, &sources, &again, &opts(1 << 40), |_| {}).expect("exports");
        assert_eq!((report.copied, report.already_there), (0, 1));
        assert!(report.backup.is_some());
        let lib = crate::usb::library(&usb).expect("reads back");
        assert_eq!(lib.tracks.len(), 3);
        assert_eq!(lib.playlists.len(), 2);
        let warm = lib
            .playlists
            .iter()
            .find(|p| p.name == "Warm up")
            .expect("playlist");
        assert_eq!(warm.track_ids.len(), 1);
        let one = onelib::read(&usb.join(ONE_LIBRARY_PATH)).expect("OneLibrary");
        assert_eq!(one, lib, "both databases agree");

        // Removing the rest leaves only what this export writes, keeping its playlist's id.
        let only = Options {
            mode: Mode::ReplacePlaylists,
            ..opts(1 << 40)
        };
        let report = export(&usb, &sources, &again, &only, |_| {}).expect("exports");
        assert_eq!((report.playlists, report.playlists_removed), (1, 1));
        let after = crate::usb::library(&usb).expect("reads back");
        assert_eq!(after.tracks.len(), 3, "songs stay");
        assert_eq!(
            after
                .playlists
                .iter()
                .map(|p| (p.id, p.name.as_str()))
                .collect::<Vec<_>>(),
            [(warm.id, "Warm up")]
        );
        let one = onelib::read(&usb.join(ONE_LIBRARY_PATH)).expect("OneLibrary");
        assert_eq!(one, after, "both databases agree");

        // The review sees what replacing everything would do: song 1 stays, two go, and a new
        // playlist with a new song is added.
        let lib_dir2 = dir("lib-extra");
        let mut more = sources.clone();
        more.push(source(&lib_dir2, 4, "Kode9", "Memories", "new.mp3", 4000));
        let last = vec![
            SourcePlaylist {
                name: "Warm up".into(),
                track_ids: vec![1, 4],
            },
            SourcePlaylist {
                name: "Fresh".into(),
                track_ids: vec![4],
            },
        ];
        let diff = preview(&usb, &more, &last, Mode::ReplaceAll).expect("preview");
        let changes: Vec<_> = diff
            .playlists
            .iter()
            .map(|p| {
                (
                    p.name.as_str(),
                    p.change,
                    p.songs,
                    p.added.len(),
                    p.removed.len(),
                )
            })
            .collect();
        assert_eq!(
            changes,
            [
                ("Warm up", Change::Updated, 2, 1, 0),
                ("Fresh", Change::Added, 1, 1, 0)
            ]
        );
        assert_eq!((diff.copy.len(), diff.copy_bytes), (1, 4000));
        assert_eq!((diff.delete.len(), diff.delete_bytes), (2, 5000));
        let untouched = crate::usb::library(&usb).expect("reads back");
        assert_eq!(untouched, after, "a preview writes nothing");

        let all = Options {
            mode: Mode::ReplaceAll,
            ..opts(1 << 40)
        };
        let report = export(&usb, &more, &last, &all, |_| {}).expect("exports");
        assert_eq!((report.songs_deleted, report.bytes_freed), (2, 5000));
        let end = crate::usb::library(&usb).expect("reads back");
        assert_eq!(end.tracks.len(), 2, "song 1 and the new one");
        assert!(!usb.join("Contents/Burial/Untrue/02 Near Dark.mp3").exists());
        assert!(
            !usb.join("Contents/UnknownArtist/UnknownAlbum/loose.wav")
                .exists()
        );
        assert!(
            usb.join("Contents/Burial/Untrue/01 Archangel.mp3")
                .is_file()
        );
    }

    #[test]
    fn keeps_rekordbox_tracks_and_replaces_an_unreadable_one_library() {
        let lib_dir = dir("lib2");
        let usb = dir("usb2");
        // A drive rekordbox wrote, with a shortened file name for our song.
        let existing = Library {
            tracks: vec![pdb::Track {
                id: 7,
                title: "Archangel".into(),
                path: "/Contents/Burial/Untrue/Burial - Untrue - 02 Arch.mp3".into(),
                analyze_path: "/PIONEER/USBANLZ/P001/0001/ANLZ0000.DAT".into(),
                tempo: 13900,
                file_size: 1234,
                ..pdb::Track::default()
            }],
            playlists: vec![pdb::Playlist {
                id: 1,
                name: "Theirs".into(),
                track_ids: vec![7],
                ..pdb::Playlist::default()
            }],
            ..Library::default()
        };
        let rb = usb.join("PIONEER/rekordbox");
        fs::create_dir_all(&rb).expect("dir");
        fs::write(rb.join("export.pdb"), pdb::write(&existing, 40)).expect("pdb");
        fs::write(rb.join("exportLibrary.db"), b"one library").expect("db");
        fs::write(rb.join("exportLibrary.db-wal"), b"stale").expect("wal");

        let sources = vec![source(
            &lib_dir,
            1,
            "Burial",
            "Untrue",
            "Archangel.mp3",
            1234,
        )];
        let playlists = vec![SourcePlaylist {
            name: "Mine".into(),
            track_ids: vec![1],
        }];
        let report = export(&usb, &sources, &playlists, &opts(1 << 40), |_| {}).expect("exports");
        assert_eq!((report.copied, report.already_there), (0, 1));
        let backup = usb.join(report.backup.expect("backup").trim_start_matches('/'));
        assert_eq!(
            fs::read(backup.join("exportLibrary.db")).expect("kept"),
            b"one library"
        );
        assert!(backup.join("export.pdb").is_file());
        assert!(report.one_library);
        assert!(!rb.join("exportLibrary.db-wal").exists());

        let bytes = fs::read(rb.join("export.pdb")).expect("pdb");
        assert_eq!(pdb::sequence(&bytes), Some(41));
        let lib = pdb::read(&bytes).expect("reads");
        assert_eq!(
            lib.tracks, existing.tracks,
            "rekordbox's track is untouched"
        );
        let mine = lib
            .playlists
            .iter()
            .find(|p| p.name == "Mine")
            .expect("playlist");
        assert_eq!(mine.track_ids, [7]);
        assert!(lib.playlists.iter().any(|p| p.name == "Theirs"));
        let one = onelib::read(&rb.join("exportLibrary.db")).expect("OneLibrary");
        assert_eq!(one, lib, "both databases agree");
    }

    #[test]
    fn keeps_what_only_rekordbox_one_library_has() {
        let lib_dir = dir("lib6");
        let usb = dir("usb6");
        let rb = usb.join("PIONEER/rekordbox");
        fs::create_dir_all(&rb).expect("dir");
        // rekordbox's real export: 41 tracks, 5 playlists in OneLibrary; export.pdb with one.
        let one_path = rb.join("exportLibrary.db");
        fs::write(&one_path, include_bytes!("onelib/testdata/rekordbox7.db")).expect("db");
        let theirs = onelib::read(&one_path).expect("reads");
        let pdb_lib = Library {
            tracks: theirs.tracks.clone(),
            playlists: vec![pdb::Playlist {
                id: 1,
                name: "Analyse".into(),
                track_ids: (34..=41).collect(),
                ..pdb::Playlist::default()
            }],
            artwork: theirs.artwork.clone(),
        };
        fs::write(rb.join("export.pdb"), pdb::write(&pdb_lib, 5)).expect("pdb");

        let sources = vec![source(&lib_dir, 1, "Sully", "Swandiving", "new.mp3", 5555)];
        let playlists = vec![SourcePlaylist {
            name: "UKG".into(),
            track_ids: vec![1],
        }];
        let report = export(&usb, &sources, &playlists, &opts(1 << 40), |_| {}).expect("exports");
        assert!(report.one_library, "{:?}", report.one_library_error);
        assert_eq!(report.library_tracks, 42);

        let lib = crate::usb::library(&usb).expect("pdb");
        let one = onelib::read(&one_path).expect("OneLibrary");
        assert_eq!(one, lib, "both databases agree");
        let names: Vec<_> = lib.playlists.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            ["Analyse", "UKG", "Jungle / DnB", "Grime", "Dubstep"]
        );
        let ukg = &lib.playlists[1];
        assert_eq!(
            ukg.track_ids,
            [42],
            "replaced by manplay's playlist of the same name"
        );
        assert_eq!(
            &lib.tracks[..41],
            &theirs.tracks[..],
            "rekordbox's tracks are untouched"
        );
    }

    #[test]
    fn uses_the_analysis_the_library_keeps() {
        let lib_dir = dir("lib5");
        let usb = dir("usb5");
        let store = test_store();
        // The "song" is not real audio, so only the kept analysis can give it a grid.
        let mut song = source(&lib_dir, 1, "A", "B", "a.mp3", 100);
        song.audio_fp = Some("ab12".into());
        song.bpm = Some(128.0);
        let kept = anlz::Stored {
            grid_bpm: Some(128.0),
            first_beat: 0.25,
            bar_offset: 0,
            duration: 30.0,
            detail: vec![0x5f; 4500],
        };
        anlz::save(&store.lock().expect("db"), "ab12", &kept).expect("saves");
        let playlists = [SourcePlaylist {
            name: "P".into(),
            track_ids: vec![1],
        }];
        let mut o = opts(1 << 40);
        o.store = Some(&store);
        let report = export(&usb, &[song], &playlists, &o, |_| {}).expect("exports");
        assert_eq!((report.analyzed, report.failed.len()), (1, 0));
        let lib = crate::usb::library(&usb).expect("reads");
        let t = &lib.tracks[0];
        let written = fs::read(on_drive(&usb, &t.analyze_path)).expect("dat");
        assert_eq!(written, anlz::files(&t.path, &kept, &[], None).0);
    }

    #[test]
    fn an_edited_grid_reaches_songs_already_on_the_drive() {
        let lib_dir = dir("lib7");
        let usb = dir("usb7");
        let store = test_store();
        let mut song = source(&lib_dir, 1, "A", "B", "a.mp3", 100);
        song.audio_fp = Some("cd34".into());
        let mut kept = anlz::Stored {
            grid_bpm: Some(128.0),
            first_beat: 0.25,
            bar_offset: 0,
            duration: 30.0,
            detail: vec![0x5f; 4500],
        };
        anlz::save(&store.lock().expect("db"), "cd34", &kept).expect("saves");
        let playlists = [SourcePlaylist {
            name: "P".into(),
            track_ids: vec![1],
        }];
        let mut o = opts(1 << 40);
        o.store = Some(&store);
        export(&usb, std::slice::from_ref(&song), &playlists, &o, |_| {}).expect("first");

        // Same again: nothing changed, nothing rewritten.
        let again =
            export(&usb, std::slice::from_ref(&song), &playlists, &o, |_| {}).expect("again");
        assert_eq!((again.analyzed, again.regridded), (0, 0));

        kept.set_grid(Some(126.0), 0.3, 1);
        anlz::save(&store.lock().expect("db"), "cd34", &kept).expect("edits");
        let edited = export(&usb, &[song], &playlists, &o, |_| {}).expect("edited");
        assert_eq!(edited.regridded, 1);
        let lib = crate::usb::library(&usb).expect("reads");
        let t = &lib.tracks[0];
        assert_eq!(t.tempo, 12_600);
        let written = fs::read(on_drive(&usb, &t.analyze_path)).expect("dat");
        assert_eq!(written, anlz::files(&t.path, &kept, &[], None).0);
    }

    #[test]
    fn writes_serato_crates_beside_the_rekordbox_library() {
        let lib_dir = dir("serato-lib");
        let usb = dir("serato-usb");
        let sources = vec![
            source(&lib_dir, 1, "Burial", "Untrue", "01 Archangel.mp3", 1000),
            source(&lib_dir, 2, "Burial", "Untrue", "02 Near Dark.mp3", 2000),
        ];
        let warm = SourcePlaylist {
            name: "Warm up".into(),
            track_ids: vec![2, 1],
        };
        let peak = SourcePlaylist {
            name: "Peak".into(),
            track_ids: vec![1],
        };
        let with_serato = Options {
            outputs: Outputs {
                serato: true,
                ..Outputs::default()
            },
            ..opts(1 << 40)
        };
        let report =
            export(&usb, &sources, &[warm.clone(), peak], &with_serato, |_| {}).expect("exports");
        assert_eq!(report.serato_crates, Some(2));
        let crate_of = |name: &str| {
            let bytes = fs::read(usb.join(serato::SUBCRATES_DIR).join(name)).expect("crate");
            serato::decode_crate(&bytes).expect("decodes")
        };
        let paths: Vec<String> = crate_of("Warm up.crate")
            .iter()
            .map(|p| p.as_str().to_owned())
            .collect();
        assert_eq!(
            paths,
            [
                "Contents/Burial/Untrue/02 Near Dark.mp3",
                "Contents/Burial/Untrue/01 Archangel.mp3"
            ]
        );
        assert!(
            usb.join(&paths[0]).is_file(),
            "crate paths are from the drive root"
        );
        let database = fs::read(usb.join(serato::DATABASE_PATH)).expect("database V2");
        assert_eq!(serato::database_songs(&database).expect("reads").len(), 2);

        let replace = Options {
            mode: Mode::ReplacePlaylists,
            stamp: "2026-11-15-1300",
            ..with_serato
        };
        let report = export(&usb, &sources, &[warm], &replace, |_| {}).expect("replaces");
        assert_eq!(
            (report.serato_crates, report.serato_crates_removed),
            (Some(1), 1)
        );
        assert!(!usb.join(serato::SUBCRATES_DIR).join("Peak.crate").exists());
        assert!(
            usb.join("PIONEER/manplay-backup/2026-11-15-1300")
                .join(serato::SUBCRATES_DIR)
                .join("Peak.crate")
                .is_file()
        );

        let without = export(&usb, &sources, &[], &opts(1 << 40), |_| {}).expect("rekordbox only");
        assert_eq!(without.serato_crates, None);
    }

    #[test]
    fn writes_a_gemini_library_only_when_asked() {
        let lib_dir = dir("gemini-lib");
        let usb = dir("gemini-usb");
        let mut cued = source(&lib_dir, 1, "Burial", "Untrue", "01 Archangel.mp3", 1000);
        cued.cues = Some(vec![crate::db::Cue {
            slot: Some(0),
            start: 2.0,
            name: String::new(),
            color: String::new(),
            main: false,
        }]);
        let sources = vec![cued, source(&lib_dir, 2, "", "", "loose.flac", 2000)];
        let playlists = vec![SourcePlaylist {
            name: "Warm up".into(),
            track_ids: vec![2, 1],
        }];
        let report = export(&usb, &sources, &playlists, &opts(1 << 40), |_| {}).expect("exports");
        assert_eq!((report.gemini, report.gemini_error), (None, None));
        assert!(!gemini::present(&usb));

        let with_gemini = Options {
            outputs: Outputs {
                gemini: true,
                ..Outputs::default()
            },
            ..opts(1 << 40)
        };
        let report = export(&usb, &sources, &playlists, &with_gemini, |_| {}).expect("exports");
        assert_eq!(report.gemini_error, None);
        let summary = report.gemini.expect("gemini summary");
        assert_eq!(
            (summary.tracks, summary.playlists, summary.unplayable),
            (2, 1, 1)
        );
        assert_eq!(
            fs::read_to_string(usb.join("GEMINI/Playlists/Warm up.m3u")).expect("playlist"),
            "/Contents/UnknownArtist/UnknownAlbum/loose.flac\n\
             /Contents/Burial/Untrue/01 Archangel.mp3\n"
        );
        let conn = rusqlite::Connection::open(usb.join("GEMINI/gemini_bd.sqlite")).expect("open");
        let hot_cue: String = conn
            .query_row(
                "SELECT hcue1 FROM outer_table WHERE absolute_path LIKE '%Archangel.mp3'",
                [],
                |r| r.get(0),
            )
            .expect("row");
        assert_eq!(hot_cue, "0:0:600");
    }

    #[test]
    fn playlist_folders_hold_each_song_once_for_every_library() {
        let lib_dir = dir("folders-lib");
        let usb = dir("folders-usb");
        let sources = vec![
            source(&lib_dir, 1, "Burial", "Untrue", "01 Archangel.mp3", 1000),
            source(&lib_dir, 2, "Burial", "Untrue", "02 Near Dark.mp3", 2000),
        ];
        let playlists = vec![
            SourcePlaylist {
                name: "Warm up".into(),
                track_ids: vec![2, 1],
            },
            SourcePlaylist {
                name: "Peak".into(),
                track_ids: vec![1],
            },
        ];
        let everything = Options {
            outputs: Outputs {
                rekordbox: true,
                serato: true,
                gemini: true,
                playlist_folders: true,
            },
            ..opts(1 << 40)
        };
        let report = export(&usb, &sources, &playlists, &everything, |_| {}).expect("exports");
        assert_eq!(report.playlist_folders_error, None);
        let folders = report.playlist_folders.expect("folders summary");
        assert_eq!(
            (folders.songs, folders.copies, folders.bytes_copied),
            (3, 1, 1000)
        );
        assert!(usb.join("Playlists/Warm up/01 02 Near Dark.mp3").is_file());
        assert!(usb.join("Playlists/Warm up/02 01 Archangel.mp3").is_file());
        assert!(usb.join("Playlists/Peak/01 01 Archangel.mp3").is_file());
        assert!(!usb.join("Contents").exists(), "each song is stored once");

        // Every library names the files where they now are.
        let lib = crate::usb::library(&usb).expect("reads back");
        let mut paths: Vec<&str> = lib.tracks.iter().map(|t| t.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(
            paths,
            [
                "/Playlists/Warm up/01 02 Near Dark.mp3",
                "/Playlists/Warm up/02 01 Archangel.mp3"
            ]
        );
        let crate_bytes =
            fs::read(usb.join(serato::SUBCRATES_DIR).join("Peak.crate")).expect("crate");
        let in_crate: Vec<String> = serato::decode_crate(&crate_bytes)
            .expect("decodes")
            .iter()
            .map(|p| p.as_str().to_owned())
            .collect();
        assert_eq!(in_crate, ["Playlists/Warm up/02 01 Archangel.mp3"]);
        assert_eq!(report.gemini.expect("gemini").tracks, 2);
        let conn = rusqlite::Connection::open(usb.join("GEMINI/gemini_bd.sqlite")).expect("open");
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM outer_table", [], |r| r.get(0))
            .expect("count");
        assert_eq!(rows, 3, "the copy in the second playlist has a row too");
        drop(conn);

        // The drive lists every format it holds.
        let formats = crate::usb::formats(&usb);
        let size = |s: Option<crate::usb::Summary>| s.map(|s| (s.tracks, s.playlists));
        assert_eq!(size(formats.device_library), Some((2, 2)));
        assert_eq!(size(formats.one_library), Some((2, 2)));
        assert_eq!(size(formats.serato), Some((2, 2)));
        assert_eq!(
            size(formats.gemini),
            Some((2, 2)),
            "a song's copy is not counted twice"
        );
        assert_eq!(size(formats.playlist_folders), Some((3, 2)));
        assert_eq!((formats.serato_error, formats.gemini_error), (None, None));

        // Exporting again finds the songs where they are: nothing is copied or added.
        let again = export(&usb, &sources, &playlists, &everything, |_| {}).expect("exports");
        assert_eq!((again.copied, again.already_there), (0, 2));
        assert_eq!(again.library_tracks, 2);
        let folders = again.playlist_folders.expect("folders summary");
        assert_eq!((folders.moved, folders.bytes_copied), (0, 0));

        // Without the folders the songs go back to Contents.
        let back = export(&usb, &sources, &playlists, &opts(1 << 40), |_| {}).expect("exports");
        assert_eq!((back.copied, back.already_there), (0, 2));
        assert_eq!(back.playlist_folders, None);
        assert!(
            usb.join("Contents/Burial/Untrue/01 Archangel.mp3")
                .is_file()
        );
        assert!(!usb.join("Playlists").exists());
    }

    #[test]
    fn rekordbox_is_one_format_among_the_others() {
        let lib_dir = dir("formats-lib");
        let usb = dir("formats-usb");
        let sources = vec![
            source(&lib_dir, 1, "Burial", "Untrue", "01 Archangel.mp3", 1000),
            source(&lib_dir, 2, "Burial", "Untrue", "02 Near Dark.mp3", 2000),
        ];
        let playlists = vec![SourcePlaylist {
            name: "Warm up".into(),
            track_ids: vec![2, 1],
        }];
        let serato_only = Options {
            outputs: Outputs {
                rekordbox: false,
                serato: true,
                gemini: false,
                playlist_folders: false,
            },
            ..opts(1 << 40)
        };
        let report = export(&usb, &sources, &playlists, &serato_only, |_| {}).expect("exports");
        assert_eq!((report.copied, report.playlists), (2, 1));
        assert!(!report.rekordbox && !report.one_library);
        assert_eq!(report.one_library_error, None);
        assert_eq!(
            report.analyzed, 0,
            "nothing that reads beat grids was asked for"
        );
        assert_eq!(report.serato_crates, Some(1));
        assert!(!usb.join("PIONEER").exists(), "no rekordbox files at all");
        let formats = crate::usb::formats(&usb);
        assert_eq!(
            (formats.device_library, formats.one_library, formats.gemini),
            (None, None, None)
        );
        assert_eq!(
            formats.serato.map(|s| (s.tracks, s.playlists)),
            Some((2, 1))
        );
        assert_eq!(formats.playlist_folders, None);
        assert!(
            usb.join("Contents/Burial/Untrue/01 Archangel.mp3")
                .is_file()
        );

        // The drive still knows its songs and playlists: nothing is copied twice.
        let held = crate::usb::library(&usb).expect("the drive's own list");
        assert_eq!((held.tracks.len(), held.playlists.len()), (2, 1));
        let again = export(&usb, &sources, &playlists, &serato_only, |_| {}).expect("exports");
        assert_eq!((again.copied, again.already_there), (0, 2));

        // Switching rekordbox on writes its libraries from that list, keeping the ids.
        let with_rekordbox = Options {
            outputs: Outputs {
                serato: true,
                ..Outputs::default()
            },
            ..opts(1 << 40)
        };
        let report = export(&usb, &sources, &playlists, &with_rekordbox, |_| {}).expect("exports");
        assert!(report.rekordbox && report.one_library);
        assert_eq!((report.copied, report.already_there), (0, 2));
        assert!(usb.join(PDB_PATH).is_file());
        assert!(!usb.join(OWN_LIBRARY_PATH).exists());
        let now = crate::usb::library(&usb).expect("rekordbox library");
        let ids = |lib: &Library| lib.tracks.iter().map(|t| t.id).collect::<Vec<_>>();
        assert_eq!(ids(&now), ids(&held));

        // Switching it off again removes it, with a copy kept, so no player reads a stale one.
        let off = Options {
            stamp: "2026-11-15-1300",
            ..serato_only
        };
        let report = export(&usb, &sources, &playlists, &off, |_| {}).expect("exports");
        assert_eq!(
            report.backup.as_deref(),
            Some("/PIONEER/manplay-backup/2026-11-15-1300")
        );
        assert!(!has_rekordbox(&usb));
        assert!(
            usb.join("PIONEER/manplay-backup/2026-11-15-1300/export.pdb")
                .is_file()
        );
        assert!(usb.join(OWN_LIBRARY_PATH).is_file());
    }

    #[test]
    fn refuses_when_the_drive_is_too_full() {
        let lib_dir = dir("lib3");
        let usb = dir("usb3");
        let sources = vec![source(&lib_dir, 1, "A", "B", "a.mp3", 10)];
        let playlists = vec![SourcePlaylist {
            name: "P".into(),
            track_ids: vec![1],
        }];
        let err = export(&usb, &sources, &playlists, &opts(1000), |_| {}).expect_err("too full");
        assert!(err.contains("Not enough space"), "{err}");
        assert!(!usb.join("Contents").exists());
    }

    #[test]
    fn leaves_an_unreadable_library_alone() {
        let usb = dir("usb4");
        let rb = usb.join("PIONEER/rekordbox");
        fs::create_dir_all(&rb).expect("dir");
        fs::write(rb.join("export.pdb"), b"garbage").expect("pdb");
        let err = export(&usb, &[], &[], &opts(1 << 40), |_| {}).expect_err("refuses");
        assert!(err.contains("left alone"), "{err}");
        assert_eq!(fs::read(rb.join("export.pdb")).expect("pdb"), b"garbage");
    }

    /// Exports one real song into a copy of a real drive:
    /// `MANPLAY_USB_DIR=/tmp/copy MANPLAY_SONG=/path/song.mp3 cargo test -- --ignored real_drive_copy`.
    #[test]
    #[ignore = "needs a copy of a real drive"]
    fn real_drive_copy() {
        let usb = PathBuf::from(std::env::var("MANPLAY_USB_DIR").expect("MANPLAY_USB_DIR"));
        let song = PathBuf::from(std::env::var("MANPLAY_SONG").expect("MANPLAY_SONG"));
        let before = crate::usb::library(&usb).expect("reads");
        let source = Source {
            id: 1,
            size: fs::metadata(&song).expect("song").len(),
            path: song,
            artist: "manplay test".into(),
            album: "Dry run".into(),
            title: "Dry run song".into(),
            duration_ms: Some(180_000),
            bitrate: Some(320),
            sample_rate: Some(44_100),
            bpm: Some(128.0),
            key: Some("8A".into()),
            audio_fp: None,
            grid_edited: false,
            cues: None,
        };
        let playlists = [SourcePlaylist {
            name: "manplay dry run".into(),
            track_ids: vec![1],
        }];
        let report = export(&usb, &[source], &playlists, &opts(1 << 40), |_| {}).expect("exports");
        println!("{report:?}");
        let after = crate::usb::library(&usb).expect("reads");
        assert_eq!(&after.tracks[..before.tracks.len()], &before.tracks[..]);
        assert!(after.playlists.iter().any(|p| p.name == "manplay dry run"));
        if report.one_library {
            let one = onelib::read(&usb.join(ONE_LIBRARY_PATH)).expect("OneLibrary");
            assert_eq!(one, after, "both databases agree");
        }
    }
}
