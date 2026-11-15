//! Copies playlists onto a CDJ USB drive and rewrites its rekordbox Device Library.
//!
//! The drive's existing library is kept: its tracks keep their ids (so rekordbox's beat grids and
//! `exportExt.pdb` tags still line up) and its playlists stay, except ones with the same name as
//! an exported playlist, which are replaced. Songs already on the drive, matched by path or by
//! exact file size, are not copied again.

#![allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]

use crate::analysis::{self, Detail};
use crate::anlz;
use crate::pdb::{self, Library};
use crate::usb::PDB_PATH;
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
    /// Audio fingerprint, under which manplay keeps the song's analysis.
    pub fingerprint: Option<String>,
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
    /// Tracks in the drive's library afterwards.
    pub library_tracks: usize,
    /// Folder on the drive holding the previous database and the `OneLibrary` files moved aside.
    pub backup: Option<String>,
    pub failed: Vec<Failure>,
}

/// Rekordbox's names for a song with no artist or album.
const UNKNOWN_ARTIST: &str = "UnknownArtist";
const UNKNOWN_ALBUM: &str = "UnknownAlbum";
/// Longest file or folder name written; rekordbox stays well inside FAT32's 255.
const MAX_NAME: usize = 120;
/// rekordbox's newer database and its SQLite side files, which would show players that read it
/// a library without manplay's playlists.
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
    format!(
        "/Contents/{}/{}/{}",
        safe_name(&s.artist, UNKNOWN_ARTIST),
        safe_name(&s.album, UNKNOWN_ALBUM),
        safe_file_name(&file)
    )
}

/// `/Contents/A/B/x.mp3` → `/Contents/A/B/x (2).mp3`.
fn numbered(path: &str, n: usize) -> String {
    match path.rsplit_once('.') {
        Some((stem, ext)) if !ext.contains('/') => format!("{stem} ({n}).{ext}"),
        _ => format!("{path} ({n})"),
    }
}

fn on_drive(mount: &Path, rel: &str) -> PathBuf {
    mount.join(rel.trim_start_matches('/'))
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
fn copy_file(from: &Path, to: &Path) -> io::Result<u64> {
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
    for t in &lib.tracks {
        by_size.entry(t.file_size).or_default().push(t.id);
    }
    let mut taken: HashSet<String> = by_path.keys().cloned().collect();
    let mut out = Vec::new();
    for &s in sources {
        let dest = content_path(s);
        let size = u32::try_from(s.size).unwrap_or(u32::MAX);
        let existing = by_path.get(&dest.to_lowercase()).copied().or_else(|| {
            // rekordbox shortens long names, so fall back to an exact size match.
            match by_size.get(&size).map(Vec::as_slice) {
                Some([only]) if size > 0 => Some(*only),
                _ => None,
            }
        });
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

/// Moves rekordbox's `OneLibrary` files aside and keeps a copy of the current database in
/// `PIONEER/manplay-backup/<stamp>`.
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
            fs::rename(&p, dir.join(name))?;
        }
    }
    Ok(Some(format!("/{rel}")))
}

/// A song's analysis for the drive, and a key detected along the way.
struct Analyzed {
    stored: anlz::Stored,
    key: Option<String>,
}

/// The analysis manplay already keeps for the song, or a fresh one (then kept too). A kept
/// analysis without a beat grid is redone when the library has a tempo to lay one out with.
fn analyzed(source: &Source, store: Option<&Path>) -> Result<Analyzed, String> {
    let kept = store
        .zip(source.fingerprint.as_deref())
        .and_then(|(dir, fp)| anlz::load(dir, fp))
        .filter(|s| s.grid_bpm.is_some() || source.bpm.is_none());
    if let Some(stored) = kept {
        return Ok(Analyzed { stored, key: None });
    }
    let d: Detail = analysis::analyze_detail(&source.path, source.bpm)?;
    let stored = anlz::Stored::from_detail(&d);
    if let (Some(dir), Some(fp)) = (store, source.fingerprint.as_deref()) {
        // Keeping it only saves time next export; failing to is not worth stopping for.
        let _ = anlz::save(dir, fp, &stored);
    }
    Ok(Analyzed {
        stored,
        key: d.analysis.key,
    })
}

/// Beat grid and waveform for each job's source file, on all but one core.
fn analyze_all(
    jobs: &[(usize, &Source)],
    store: Option<&Path>,
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
    camelot: bool,
) -> Result<(), String> {
    let d = &a.stored;
    let rel = anlz::dat_path(track.id, &track.path);
    let (dat, ext) = anlz::files(&track.path, d);
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

/// Songs already on the drive whose analysis files manplay wrote get them rewritten from the
/// kept analysis when it changed since, so grid edits reach the drive. Files rekordbox wrote
/// stay as they are: they hold its cue points.
fn refresh_grids(
    mount: &Path,
    lib: &mut Library,
    planned: &[Planned],
    store: Option<&Path>,
    report: &mut Report,
) {
    let Some(dir) = store else { return };
    for p in planned {
        let Some(id) = p.existing else { continue };
        let Some(track) = lib.tracks.iter_mut().find(|t| t.id == id) else {
            continue;
        };
        if track.analyze_path != anlz::dat_path(track.id, &track.path) {
            continue;
        }
        let Some(stored) = p
            .source
            .fingerprint
            .as_deref()
            .and_then(|fp| anlz::load(dir, fp))
        else {
            continue;
        };
        let (dat, ext) = anlz::files(&track.path, &stored);
        let dat_path = on_drive(mount, &track.analyze_path);
        let ext_path = dat_path.with_extension("EXT");
        if fs::read(&dat_path).ok().as_deref() == Some(dat.as_slice())
            && fs::read(&ext_path).ok().as_deref() == Some(ext.as_slice())
        {
            continue;
        }
        match write_atomic(&dat_path, &dat).and_then(|()| write_atomic(&ext_path, &ext)) {
            Ok(()) => {
                if let Some(bpm) = stored.grid_bpm {
                    track.tempo = (bpm * 100.0).round() as u32;
                }
                report.regridded += 1;
            }
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
    /// Where manplay keeps analyses (its data folder), to reuse and add to; `None` to always
    /// analyse afresh.
    pub store: Option<&'a Path>,
    /// Show detected keys as Camelot codes (`8A`) rather than `Am`.
    pub camelot: bool,
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
    let pdb_path = mount.join(PDB_PATH);
    let (mut lib, sequence) = match fs::read(&pdb_path) {
        Ok(bytes) => (
            pdb::read(&bytes).map_err(|e| {
                format!(
                    "The drive's rekordbox library could not be read, so it was left alone: {e}"
                )
            })?,
            pdb::sequence(&bytes).unwrap_or(1),
        ),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (Library::default(), 1),
        Err(e) => return Err(format!("{}: {e}", pdb_path.display())),
    };

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
        .filter(|(_, t)| t.analyze_path.is_empty())
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
        match result.and_then(|d| write_analysis(mount, track, &d, opts.camelot).map(|()| d)) {
            Ok(_) => report.analyzed += 1,
            Err(e) => report.failed.push(Failure {
                path: source.path.display().to_string(),
                error: format!("analysis: {e}"),
            }),
        }
    }

    refresh_grids(mount, &mut lib, &planned, opts.store, &mut report);

    progress(Progress {
        phase: Phase::Writing,
        done: total,
        total,
        current: String::new(),
    });
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

    report.backup =
        back_up(mount, opts.stamp).map_err(|e| format!("backing up the old library: {e}"))?;
    let bytes = pdb::write(&lib, sequence + 1);
    write_atomic(&pdb_path, &bytes).map_err(|e| format!("writing {}: {e}", pdb_path.display()))?;
    report.library_tracks = lib.tracks.len();
    Ok(report)
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
            fingerprint: None,
        }
    }

    fn opts(free: u64) -> Options<'static> {
        Options {
            today: "2026-11-15",
            stamp: "2026-11-15-1200",
            free_bytes: free,
            store: None,
            camelot: true,
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
    }

    #[test]
    fn keeps_rekordbox_tracks_and_moves_one_library_aside() {
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
        assert!(backup.join("exportLibrary.db").is_file());
        assert!(backup.join("export.pdb").is_file());
        assert!(!rb.join("exportLibrary.db").exists());

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
    }

    #[test]
    fn uses_the_analysis_the_library_keeps() {
        let lib_dir = dir("lib5");
        let usb = dir("usb5");
        let store = dir("store5");
        // The "song" is not real audio, so only the kept analysis can give it a grid.
        let mut song = source(&lib_dir, 1, "A", "B", "a.mp3", 100);
        song.fingerprint = Some("ab12".into());
        song.bpm = Some(128.0);
        let kept = anlz::Stored {
            grid_bpm: Some(128.0),
            first_beat: 0.25,
            bar_offset: 0,
            duration: 30.0,
            detail: vec![0x5f; 4500],
        };
        anlz::save(&store, "ab12", &kept).expect("saves");
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
        assert_eq!(written, anlz::files(&t.path, &kept).0);
    }

    #[test]
    fn an_edited_grid_reaches_songs_already_on_the_drive() {
        let lib_dir = dir("lib6");
        let usb = dir("usb6");
        let store = dir("store6");
        let mut song = source(&lib_dir, 1, "A", "B", "a.mp3", 100);
        song.fingerprint = Some("cd34".into());
        let mut kept = anlz::Stored {
            grid_bpm: Some(128.0),
            first_beat: 0.25,
            bar_offset: 0,
            duration: 30.0,
            detail: vec![0x5f; 4500],
        };
        anlz::save(&store, "cd34", &kept).expect("saves");
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
        anlz::save(&store, "cd34", &kept).expect("edits");
        let edited = export(&usb, &[song], &playlists, &o, |_| {}).expect("edited");
        assert_eq!(edited.regridded, 1);
        let lib = crate::usb::library(&usb).expect("reads");
        let t = &lib.tracks[0];
        assert_eq!(t.tempo, 12_600);
        let written = fs::read(on_drive(&usb, &t.analyze_path)).expect("dat");
        assert_eq!(written, anlz::files(&t.path, &kept).0);
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
            fingerprint: None,
        };
        let playlists = [SourcePlaylist {
            name: "manplay dry run".into(),
            track_ids: vec![1],
        }];
        let report = export(&usb, &[source], &playlists, &opts(1 << 40), |_| {}).expect("exports");
        println!("{report:?}");
        let after = crate::usb::library(&usb).expect("reads");
        assert_eq!(&after.tracks[..before.tracks.len()], &before.tracks[..]);
        assert_eq!(after.playlists.len(), before.playlists.len() + 1);
    }
}
