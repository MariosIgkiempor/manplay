//! The `GEMINI/` library Gemini's V-CASE wrote for its MDJ players (MDJ-500, 600, 900, 1000):
//! a track database, one M3U per playlist, and per-track waveform and cover files.
//!
//! It is written from the drive's rekordbox library after an export, so both hold the same songs
//! and playlists and the same drive plays on CDJs and on a Gemini player. Layout and units are in
//! `docs/gemini-vcase.md`; they come from reading a third-party converter, tested by its author
//! on an MDJ-900 only.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss
)]

use crate::analysis::WAVEFORM_RATE;
use crate::anlz::{self, Milliseconds};
use crate::db::Cue;
use crate::pdb::{self, Library};
use crate::playlist_folders;
use crate::usb::BACKUP_DIR;
use crate::usb_export::{copy_file, write_atomic};
use crate::usb_files::{
    file_names, flattened, playlist_file_names, remove_if_there, remove_mac_files, write_if_changed,
};
use lofty::file::TaggedFileExt;
use rusqlite::{Connection, params};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const DIR: &str = "GEMINI";
const DATABASE: &str = "gemini_bd.sqlite";
const PLAYLISTS: &str = "Playlists";
const WAVEFORMS: &str = "wf";
const OVERVIEWS: &str = "fwf";
const COVERS: &str = "covers";
/// The file that tells a player which models the database is for.
const MODELS_FILE: &str = "ext_db_type";
const MODELS: &[u8] = b"MDJ-1000/MDJ-900/MDJ-600/MDJ-500";

/// The player counts a track's length in frames of 588 samples at 44.1 kHz (1/75 s).
const FRAMES_PER_SECOND: f64 = 75.0;
/// Cue positions are stored in 1/300 s.
const CUE_UNITS_PER_SECOND: f64 = 300.0;
/// The beat grid's first beat is stored in samples at 44.1 kHz.
const OFFSET_UNITS_PER_MILLISECOND: f64 = 44.1;
const HOT_CUES: usize = 8;
/// The most playlists a player lists.
const MAX_PLAYLISTS: usize = 100;
/// The longest playlist line, in bytes, a player reads.
const MAX_LINE: usize = 255;
/// What one unit of rekordbox waveform height is worth in the player's 16-bit amplitudes.
const AMPLITUDE_PER_HEIGHT: u16 = 528;
/// The overview is a marker byte and 479 columns, each 0 to `OVERVIEW_MAX`.
const OVERVIEW_COLUMNS: usize = 479;
const OVERVIEW_MAX: u8 = 20;
/// Covers are square, this many pixels a side, two bytes a pixel.
const COVER_SIDE: u32 = 85;
/// The only formats a player loads from a playlist.
const PLAYABLE: [&str; 2] = ["mp3", "wav"];

const SCHEMA: &str = "CREATE TABLE outer_table('id' integer PRIMARY KEY,'title' text,\
'artist' text,'album' text,'genre' text,'bpm' float,'absolute_path' text NOT NULL UNIQUE,\
'bitrate' integer,'cue' text,'duration_in_frames' integer,'have_cover' text,'have_cue' text,\
'have_loop' text,'hcue1' text,'hcue2' text,'hcue3' text,'hcue4' text,'hcue5' text,'hcue6' text,\
'hcue7' text,'hcue8' text,'is_unsupported' text,'loop_in' integer,'loop_out' integer,\
'offset' integer,'samplerate' integer,'sync_path' text,'bitdepth' integer,'channel' integer,\
'unsupported_reason' text)";

/// A drive track's id, which also names its waveform and cover files.
type TrackId = u32;

/// What the library knows about a drive track that the drive's own files do not hold.
#[derive(Debug, Clone, Default)]
pub struct FromLibrary {
    /// Cues set in manplay, which replace the ones in the drive's analysis files; `None` when
    /// never set here.
    pub cues: Option<Vec<Cue>>,
    /// The library's copy of the song, whose embedded artwork becomes the cover when the drive
    /// has none for it.
    pub art_from: Option<PathBuf>,
}

/// What was written.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub tracks: usize,
    pub playlists: usize,
    /// Playlists past the 100 a player lists, which were not written.
    pub playlists_left_out: usize,
    pub waveforms: usize,
    pub covers: usize,
    /// Songs in the written playlists that a player will not load (not MP3 or WAV).
    pub unplayable: usize,
    /// Playlist entries left out because their path is longer than a player reads.
    pub long_paths: usize,
    /// Folder on the drive holding a copy of the previous database and playlists.
    pub backup: Option<String>,
}

/// Whether the drive at `mount` has a Gemini library.
pub fn present(mount: &Path) -> bool {
    mount.join(DIR).join(DATABASE).is_file()
}

/// The drive's Gemini library as paths from the drive root: its songs (a song's further copies in
/// the playlist folders included), and each playlist with its songs in order. The database is
/// read from a temporary copy, so nothing is written to the drive. `None` when it has none.
pub fn contents(mount: &Path) -> Option<Result<crate::usb_browse::Contents, String>> {
    let gemini = mount.join(DIR);
    let bytes = match fs::read(gemini.join(DATABASE)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return None,
        Err(e) => return Some(Err(e.to_string())),
    };
    let dir = std::env::temp_dir().join(format!(
        "manplay-gemini-browse-{}-{}",
        std::process::id(),
        uuid::Uuid::now_v7()
    ));
    let read = || -> Result<crate::usb_browse::Contents, String> {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let copy = dir.join(DATABASE);
        fs::write(&copy, &bytes).map_err(|e| e.to_string())?;
        let conn = Connection::open(&copy).map_err(|e| e.to_string())?;
        let mut rows = conn
            .prepare("SELECT absolute_path FROM outer_table ORDER BY id")
            .map_err(|e| e.to_string())?;
        let songs = rows
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut names: Vec<String> = file_names(&gemini.join(PLAYLISTS))
            .into_iter()
            .filter(|n| is_playlist_file(n) && !n.starts_with("._"))
            .collect();
        names.sort();
        let mut playlists = Vec::new();
        for name in names {
            let text = fs::read_to_string(gemini.join(PLAYLISTS).join(&name))
                .map_err(|e| format!("{name}: {e}"))?;
            let stem = Path::new(&name)
                .file_stem()
                .map_or_else(|| name.clone(), |s| s.to_string_lossy().into_owned());
            let paths = text
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(str::to_owned)
                .collect();
            playlists.push((stem, paths));
        }
        Ok(crate::usb_browse::Contents { songs, playlists })
    };
    let out = read();
    let _ = fs::remove_dir_all(&dir);
    Some(out)
}

/// How many songs and playlists the drive's Gemini library holds; `None` when it has none. The
/// database is read from a temporary copy, so nothing is written to the drive.
pub fn held(mount: &Path) -> Option<Result<(usize, usize), String>> {
    let gemini = mount.join(DIR);
    let bytes = match fs::read(gemini.join(DATABASE)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return None,
        Err(e) => return Some(Err(e.to_string())),
    };
    let playlists = file_names(&gemini.join(PLAYLISTS))
        .iter()
        .filter(|name| is_playlist_file(name) && !name.starts_with("._"))
        .count();
    let dir = std::env::temp_dir().join(format!(
        "manplay-gemini-read-{}-{}",
        std::process::id(),
        uuid::Uuid::now_v7()
    ));
    let songs = (|| -> Result<usize, String> {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let copy = dir.join(DATABASE);
        fs::write(&copy, &bytes).map_err(|e| e.to_string())?;
        let conn = Connection::open(&copy).map_err(|e| e.to_string())?;
        // A song's further copies in the playlist folders have rows too; a song is counted once.
        let copies = playlist_folders::copy_paths(mount);
        let mut rows = conn
            .prepare("SELECT absolute_path FROM outer_table")
            .map_err(|e| e.to_string())?;
        let paths = rows
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut songs = 0;
        for path in paths {
            if !copies.contains(&path.map_err(|e| e.to_string())?.to_lowercase()) {
                songs += 1;
            }
        }
        Ok(songs)
    })();
    let _ = fs::remove_dir_all(&dir);
    Some(songs.map(|songs| (songs, playlists)))
}

/// A position as the database stores it: `0:0:<1/300 s>`.
fn cue_value(at: Milliseconds) -> String {
    let units = (f64::from(at) * CUE_UNITS_PER_SECOND / 1000.0).round_ties_even() as u64;
    format!("0:0:{units}")
}

/// The cues a row is built from, whichever of manplay or the drive's files they come from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RowCues {
    main: Option<Milliseconds>,
    hot: [Option<Milliseconds>; HOT_CUES],
    /// Start and end of the one loop a row holds.
    looped: Option<(Milliseconds, Milliseconds)>,
}

fn milliseconds(seconds: f64) -> Milliseconds {
    (seconds.max(0.0) * 1000.0).round() as Milliseconds
}

impl RowCues {
    /// From cues set in manplay: the start cue (else the earliest memory cue) and the hot cues.
    fn of_library(cues: &[Cue]) -> Self {
        let mut out = Self::default();
        let mut memory: Vec<&Cue> = cues.iter().filter(|c| c.slot.is_none()).collect();
        memory.sort_by(|a, b| a.start.total_cmp(&b.start));
        out.main = memory
            .iter()
            .find(|c| c.main)
            .or(memory.first())
            .map(|c| milliseconds(c.start));
        for c in cues {
            if let Some(slot) = c.slot.and_then(|s| out.hot.get_mut(usize::from(s)))
                && slot.is_none()
            {
                *slot = Some(milliseconds(c.start));
            }
        }
        out
    }

    /// From the drive's analysis files: the first memory cue, the hot cues, and the first loop
    /// (a memory loop before a hot one).
    fn of_drive(cues: &[anlz::DriveCue]) -> Self {
        let mut out = Self::default();
        let span = |c: &anlz::DriveCue| c.loop_end.map(|end| (c.start, end));
        let memory = || cues.iter().filter(|c| c.slot.is_none());
        out.main = memory()
            .find(|c| c.loop_end.is_none())
            .or_else(|| memory().next())
            .map(|c| c.start);
        for c in cues {
            if let Some(slot) = c.slot.and_then(|s| out.hot.get_mut(usize::from(s)))
                && slot.is_none()
            {
                *slot = Some(c.start);
            }
        }
        out.looped = memory()
            .find_map(span)
            .or_else(|| cues.iter().filter(|c| c.slot.is_some()).find_map(span));
        out
    }
}

/// A track's analysis as the drive's rekordbox files hold it.
#[derive(Debug, Default)]
struct Analysis {
    first_beat: Option<Milliseconds>,
    /// rekordbox detail waveform heights, `WAVEFORM_RATE` a second.
    detail: Vec<u8>,
    cues: Vec<anlz::DriveCue>,
}

/// Reads a track's `.DAT` and `.EXT`. The `.EXT`'s newer cue lists win: they also hold hot cues
/// past C.
fn read_analysis(mount: &Path, analyze_path: &str) -> Analysis {
    let mut out = Analysis::default();
    if analyze_path.is_empty() {
        return out;
    }
    let dat = mount.join(analyze_path.trim_start_matches('/'));
    let mut original = Vec::new();
    let mut extended = Vec::new();
    for path in [dat.with_extension("EXT"), dat] {
        let Some(parsed) = fs::read(&path).ok().and_then(|b| anlz::parse(&b)) else {
            continue;
        };
        out.first_beat = out.first_beat.or(parsed.first_beat);
        if out.detail.is_empty() {
            out.detail = parsed.detail;
        }
        if original.is_empty() {
            original = parsed.cues;
        }
        if extended.is_empty() {
            extended = parsed.extended_cues;
        }
    }
    out.cues = if extended.is_empty() {
        original
    } else {
        extended
    };
    out
}

/// The detail waveform (`wf/<id>`) and the overview (`fwf/<id>`) from rekordbox waveform heights.
/// `None` for a track too short to fill the overview, or silent: the player then analyses the
/// song itself.
fn waveforms(detail: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    let entries: Vec<u16> = detail
        .as_chunks::<2>()
        .0
        .iter()
        .map(|[a, b]| (u16::from(a & 0x1f) + u16::from(b & 0x1f)) * AMPLITUDE_PER_HEIGHT)
        .collect();
    let n = entries.len();
    let peak = entries.iter().copied().max().filter(|p| *p > 0)?;
    if n <= OVERVIEW_COLUMNS {
        return None;
    }
    let means: Vec<f64> = (0..OVERVIEW_COLUMNS)
        .map(|i| {
            let slice = &entries[i * n / OVERVIEW_COLUMNS..(i + 1) * n / OVERVIEW_COLUMNS];
            slice.iter().map(|v| f64::from(*v)).sum::<f64>() / slice.len().max(1) as f64
        })
        .collect();
    let top = means.iter().copied().fold(0.0, f64::max);
    let top = if top > 0.0 { top } else { 1.0 };
    let mut overview = vec![OVERVIEW_MAX];
    overview.extend(
        means.iter().map(|m| {
            ((m / top * f64::from(OVERVIEW_MAX)).round_ties_even() as u8).min(OVERVIEW_MAX)
        }),
    );

    // V-CASE pads the file to four bytes an entry.
    let mut detail_file = Vec::with_capacity(4 + 4 * n);
    detail_file.extend_from_slice(&u32::from(peak).to_le_bytes());
    for v in &entries {
        detail_file.extend_from_slice(&v.to_le_bytes());
    }
    detail_file.resize(4 + 4 * n, 0);
    Some((detail_file, overview))
}

/// A cover file from an image: centre-cropped square, 85 pixels a side, RGB565 little-endian.
fn cover(image_bytes: &[u8]) -> Option<Vec<u8>> {
    let image = image::load_from_memory(image_bytes).ok()?.to_rgb8();
    let (width, height) = image.dimensions();
    let side = width.min(height);
    if side == 0 {
        return None;
    }
    let square =
        image::imageops::crop_imm(&image, (width - side) / 2, (height - side) / 2, side, side)
            .to_image();
    let small = image::imageops::thumbnail(&square, COVER_SIDE, COVER_SIDE);
    let mut out = Vec::with_capacity((COVER_SIDE * COVER_SIDE * 2) as usize);
    for pixel in small.pixels() {
        let [r, g, b] = pixel.0;
        let packed = (u16::from(r >> 3) << 11) | (u16::from(g >> 2) << 5) | u16::from(b >> 3);
        out.extend_from_slice(&packed.to_le_bytes());
    }
    Some(out)
}

/// The image a track's cover is made from: the drive's rekordbox artwork (the larger `_m` copy
/// when there is one), else the artwork embedded in the library's copy of the song.
fn cover_image(
    mount: &Path,
    artwork: &HashMap<u32, &str>,
    track: &pdb::Track,
    extra: Option<&FromLibrary>,
) -> Option<Vec<u8>> {
    let from_drive = artwork.get(&track.artwork_id).and_then(|rel| {
        let small = mount.join(rel.trim_start_matches('/'));
        let large = small.file_stem().map(|stem| {
            let mut name = stem.to_os_string();
            name.push("_m");
            if let Some(ext) = small.extension() {
                name.push(".");
                name.push(ext);
            }
            small.with_file_name(name)
        });
        large
            .and_then(|p| fs::read(p).ok())
            .or_else(|| fs::read(&small).ok())
    });
    from_drive.or_else(|| {
        let tagged = lofty::read_from_path(extra?.art_from.as_deref()?).ok()?;
        tagged
            .tags()
            .iter()
            .find_map(|t| t.pictures().first())
            .map(|p| p.data().to_vec())
    })
}

/// One row of the track database.
#[derive(Debug, Clone, PartialEq)]
struct Row {
    id: TrackId,
    title: String,
    artist: String,
    album: String,
    genre: String,
    bpm: f64,
    absolute_path: String,
    bits_per_second: u32,
    duration_in_frames: u64,
    sample_rate: u32,
    /// First beat of the grid, in samples at 44.1 kHz.
    offset: u64,
    cues: RowCues,
    has_cover: bool,
}

fn row(track: &pdb::Track, analysis: &Analysis, cues: RowCues) -> Row {
    let seconds = if analysis.detail.is_empty() {
        f64::from(track.duration_secs)
    } else {
        analysis.detail.len() as f64 / WAVEFORM_RATE
    };
    // A track with no cue of its own starts from the first beat, as the player's own does.
    let cues = RowCues {
        main: cues.main.or(analysis.first_beat),
        ..cues
    };
    Row {
        id: track.id,
        title: track.title.clone(),
        artist: track.artist.clone(),
        album: track.album.clone(),
        genre: track.genre.clone(),
        bpm: f64::from(track.tempo) / 100.0,
        absolute_path: track.path.clone(),
        bits_per_second: track.bitrate.saturating_mul(1000),
        duration_in_frames: (seconds * FRAMES_PER_SECOND).round() as u64,
        sample_rate: if track.sample_rate == 0 {
            44_100
        } else {
            track.sample_rate
        },
        offset: analysis.first_beat.map_or(0, |ms| {
            (f64::from(ms) * OFFSET_UNITS_PER_MILLISECOND).round_ties_even() as u64
        }),
        cues,
        has_cover: false,
    }
}

fn yes_no(yes: bool) -> &'static str {
    if yes { "yes" } else { "no" }
}

/// The database file's bytes. It is built in a temporary folder, not on the drive, so the drive
/// only ever holds a whole one.
fn database(rows: &[Row]) -> Result<Vec<u8>, String> {
    let dir = std::env::temp_dir().join(format!(
        "manplay-gemini-{}-{}",
        std::process::id(),
        uuid::Uuid::now_v7()
    ));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(DATABASE);
    let built = (|| -> Result<Vec<u8>, String> {
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        fill(&conn, rows).map_err(|e| e.to_string())?;
        conn.close().map_err(|(_, e)| e.to_string())?;
        fs::read(&path).map_err(|e| e.to_string())
    })();
    let _ = fs::remove_dir_all(&dir);
    built
}

fn fill(conn: &Connection, rows: &[Row]) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA page_size = 1024; PRAGMA journal_mode = DELETE;")?;
    conn.execute_batch(SCHEMA)?;
    let mut insert = conn.prepare(
        "INSERT INTO outer_table (id, title, artist, album, genre, bpm, absolute_path, bitrate,
             cue, duration_in_frames, have_cover, have_cue, have_loop, hcue1, hcue2, hcue3, hcue4,
             hcue5, hcue6, hcue7, hcue8, is_unsupported, loop_in, loop_out, offset, samplerate,
             sync_path, bitdepth, channel, unsupported_reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
             ?19, ?20, ?21, 'no', ?22, ?23, ?24, ?25, ?26, 16, 2, NULL)",
    )?;
    let text = |at: Option<Milliseconds>| at.map(cue_value).unwrap_or_default();
    for r in rows {
        let file_name = r.absolute_path.rsplit('/').next().unwrap_or_default();
        insert.execute(params![
            r.id,
            r.title,
            r.artist,
            r.album,
            r.genre,
            r.bpm,
            r.absolute_path,
            r.bits_per_second,
            text(r.cues.main),
            i64::try_from(r.duration_in_frames).unwrap_or(i64::MAX),
            yes_no(r.has_cover),
            yes_no(r.cues.main.is_some()),
            yes_no(r.cues.looped.is_some()),
            text(r.cues.hot[0]),
            text(r.cues.hot[1]),
            text(r.cues.hot[2]),
            text(r.cues.hot[3]),
            text(r.cues.hot[4]),
            text(r.cues.hot[5]),
            text(r.cues.hot[6]),
            text(r.cues.hot[7]),
            text(r.cues.looped.map(|l| l.0)),
            text(r.cues.looped.map(|l| l.1)),
            i64::try_from(r.offset).unwrap_or(i64::MAX),
            r.sample_rate,
            file_name,
        ])?;
    }
    Ok(())
}

fn is_playable(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, ext)| PLAYABLE.iter().any(|p| ext.eq_ignore_ascii_case(p)))
}

fn is_playlist_file(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("m3u") || ext.eq_ignore_ascii_case("m3u8"))
}

/// Keeps a copy of the current database and playlists beside the rekordbox backups, in
/// `PIONEER/manplay-backup/<stamp>/GEMINI`. A folder already holding a copy keeps it.
fn back_up(mount: &Path, stamp: &str) -> io::Result<Option<String>> {
    let gemini = mount.join(DIR);
    let database = gemini.join(DATABASE);
    let playlists: Vec<String> = file_names(&gemini.join(PLAYLISTS))
        .into_iter()
        .filter(|n| is_playlist_file(n))
        .collect();
    if !database.is_file() && playlists.is_empty() {
        return Ok(None);
    }
    let rel = format!("{BACKUP_DIR}/{stamp}/{DIR}");
    let dir = mount.join(&rel);
    if !dir.exists() {
        if database.is_file() {
            copy_file(&database, &dir.join(DATABASE))?;
        }
        for name in playlists {
            copy_file(
                &gemini.join(PLAYLISTS).join(&name),
                &dir.join(PLAYLISTS).join(&name),
            )?;
        }
    }
    Ok(Some(format!("/{rel}")))
}

/// Gives a song's copy the original's waveform and cover files under its own id.
fn copy_track_files(gemini: &Path, from: TrackId, to: TrackId) -> io::Result<()> {
    for sub in [WAVEFORMS, OVERVIEWS, COVERS] {
        let target = gemini.join(sub).join(to.to_string());
        match fs::read(gemini.join(sub).join(from.to_string())) {
            Ok(bytes) => write_if_changed(&target, &bytes)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => remove_if_there(&target)?,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Writes the Gemini library for the drive at `mount` from its rekordbox library `lib`, replacing
/// the one there (a copy of its database and playlists is kept first, see [`back_up`]).
/// `extras` holds what the library knows about the tracks it exported, by drive track id.
/// `copies` are the further copies of songs in the drive's playlist folders (see
/// [`playlist_folders`]); each gets a row of its own, so its cues and waveform load too.
#[allow(clippy::too_many_lines)] // one pass: back up, rows with waveforms and covers, playlists, database
pub fn write(
    mount: &Path,
    lib: &Library,
    extras: &HashMap<TrackId, FromLibrary>,
    stamp: &str,
    copies: &[playlist_folders::Copy],
) -> Result<Summary, String> {
    let gemini = mount.join(DIR);
    let failed = |what: &str, e: io::Error| format!("{what}: {e}");
    let mut summary = Summary {
        backup: back_up(mount, stamp).map_err(|e| failed("backing up the Gemini library", e))?,
        ..Summary::default()
    };
    for sub in [PLAYLISTS, WAVEFORMS, OVERVIEWS, COVERS] {
        fs::create_dir_all(gemini.join(sub))
            .map_err(|e| failed("creating the Gemini folder", e))?;
    }

    let artwork: HashMap<u32, &str> = lib
        .artwork
        .iter()
        .map(|(id, p)| (*id, p.as_str()))
        .collect();
    let mut rows = Vec::with_capacity(lib.tracks.len());
    for track in &lib.tracks {
        let extra = extras.get(&track.id);
        let analysis = read_analysis(mount, &track.analyze_path);
        let cues = match extra.and_then(|e| e.cues.as_deref()) {
            Some(cues) => RowCues::of_library(cues),
            None => RowCues::of_drive(&analysis.cues),
        };
        let mut row = row(track, &analysis, cues);
        let name = track.id.to_string();

        let wave = gemini.join(WAVEFORMS).join(&name);
        let overview = gemini.join(OVERVIEWS).join(&name);
        match waveforms(&analysis.detail) {
            Some((detail_file, overview_file)) => {
                write_if_changed(&wave, &detail_file)
                    .and_then(|()| write_if_changed(&overview, &overview_file))
                    .map_err(|e| failed("writing a Gemini waveform", e))?;
                summary.waveforms += 1;
            }
            // A waveform left under this id is not this track's.
            None => remove_if_there(&wave)
                .and_then(|()| remove_if_there(&overview))
                .map_err(|e| failed("removing an old Gemini waveform", e))?,
        }

        let cover_path = gemini.join(COVERS).join(&name);
        if let Some(bytes) = cover_image(mount, &artwork, track, extra).and_then(|i| cover(&i)) {
            write_if_changed(&cover_path, &bytes)
                .map_err(|e| failed("writing a Gemini cover", e))?;
            row.has_cover = true;
        } else if extra.is_some() {
            // The library's copy has no artwork, so neither does the track.
            remove_if_there(&cover_path).map_err(|e| failed("removing an old Gemini cover", e))?;
        } else {
            row.has_cover = cover_path.is_file();
        }
        summary.covers += usize::from(row.has_cover);
        rows.push(row);
    }
    summary.tracks = rows.len();

    let paths: HashMap<TrackId, &str> =
        lib.tracks.iter().map(|t| (t.id, t.path.as_str())).collect();
    let all = flattened(lib);
    let all_names = playlist_file_names(all.iter().map(|(name, _)| name.as_str()));

    let row_of: HashMap<TrackId, usize> = rows.iter().enumerate().map(|(i, r)| (r.id, i)).collect();
    let mut next_id = lib.tracks.iter().map(|t| t.id).max().unwrap_or(0) + 1;
    for copy in copies {
        let Some(original) = row_of.get(&copy.track).map(|i| rows[*i].clone()) else {
            continue;
        };
        copy_track_files(&gemini, original.id, next_id)
            .map_err(|e| failed("writing a playlist folder song's waveform", e))?;
        rows.push(Row {
            id: next_id,
            absolute_path: copy.path.clone(),
            ..original
        });
        next_id += 1;
    }

    let ids: HashSet<String> = rows.iter().map(|r| r.id.to_string()).collect();
    for sub in [WAVEFORMS, OVERVIEWS, COVERS] {
        for name in file_names(&gemini.join(sub)) {
            if !ids.contains(&name) {
                let _ = fs::remove_file(gemini.join(sub).join(name));
            }
        }
    }

    summary.playlists_left_out = all.len().saturating_sub(MAX_PLAYLISTS);
    let listed = &all[..all.len().min(MAX_PLAYLISTS)];
    let names: Vec<String> = all_names
        .iter()
        .take(listed.len())
        .map(|name| format!("{name}.m3u"))
        .collect();
    let mut unplayable = HashSet::new();
    let mut files = Vec::with_capacity(listed.len());
    for ((_, playlist), file_name) in listed.iter().zip(&names) {
        let mut body = String::new();
        for path in playlist.track_ids.iter().filter_map(|id| paths.get(id)) {
            if path.len() > MAX_LINE {
                summary.long_paths += 1;
                continue;
            }
            if !is_playable(path) {
                unplayable.insert(*path);
            }
            body.push_str(path);
            body.push('\n');
        }
        files.push((file_name, body));
    }
    summary.unplayable = unplayable.len();
    summary.playlists = files.len();

    let playlist_dir = gemini.join(PLAYLISTS);
    let keep: HashSet<String> = names.iter().map(|n| n.to_lowercase()).collect();
    for old in file_names(&playlist_dir) {
        if is_playlist_file(&old) && !keep.contains(&old.to_lowercase()) {
            remove_if_there(&playlist_dir.join(&old))
                .map_err(|e| failed("removing an old Gemini playlist", e))?;
        }
    }
    for (file_name, body) in files {
        write_if_changed(&playlist_dir.join(file_name), body.as_bytes())
            .map_err(|e| failed("writing a Gemini playlist", e))?;
    }

    let bytes = database(&rows).map_err(|e| format!("building the Gemini database: {e}"))?;
    // SQLite would replay an old journal into the new database.
    remove_if_there(&gemini.join(format!("{DATABASE}-journal")))
        .and_then(|()| write_atomic(&gemini.join(DATABASE), &bytes))
        .and_then(|()| write_if_changed(&gemini.join(MODELS_FILE), MODELS))
        .map_err(|e| failed("writing the Gemini database", e))?;
    remove_mac_files(&gemini);
    Ok(summary)
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    fn temp_mount(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "manplay-gemini-test-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        fs::create_dir_all(&dir).expect("temp mount");
        dir
    }

    fn track(id: u32, path: &str) -> pdb::Track {
        pdb::Track {
            id,
            title: format!("Song {id}"),
            artist: "Artist".into(),
            album: "Album".into(),
            genre: "House".into(),
            path: path.into(),
            duration_secs: 200,
            tempo: 12_800,
            bitrate: 320,
            sample_rate: 44_100,
            ..pdb::Track::default()
        }
    }

    fn playlist(
        id: u32,
        parent_id: u32,
        name: &str,
        is_folder: bool,
        ids: &[u32],
    ) -> pdb::Playlist {
        pdb::Playlist {
            id,
            parent_id,
            name: name.into(),
            is_folder,
            sort_order: id,
            track_ids: ids.to_vec(),
        }
    }

    fn hot(slot: u8, start: f64) -> Cue {
        Cue {
            slot: Some(slot),
            start,
            name: String::new(),
            color: String::new(),
            main: false,
        }
    }

    fn memory(start: f64, main: bool) -> Cue {
        Cue {
            slot: None,
            start,
            name: String::new(),
            color: String::new(),
            main,
        }
    }

    #[test]
    fn cue_positions_are_three_hundredths_of_a_second() {
        for (at, expected) in [
            (0, "0:0:0"),
            (1000, "0:0:300"),
            (1500, "0:0:450"),
            (10, "0:0:3"),
            (5, "0:0:2"),
            (61_234, "0:0:18370"),
        ] {
            assert_eq!(cue_value(at), expected, "{at} ms");
        }
    }

    #[test]
    fn library_cues_give_the_start_cue_and_hot_cues() {
        let cues = RowCues::of_library(&[
            hot(0, 1.0),
            hot(7, 8.5),
            hot(9, 3.0),
            memory(4.0, false),
            memory(6.0, true),
        ]);
        assert_eq!(cues.main, Some(6000));
        assert_eq!(cues.hot[0], Some(1000));
        assert_eq!(cues.hot[7], Some(8500));
        assert_eq!(cues.hot[1..7], [None; 6]);
        assert_eq!(cues.looped, None);
        let earliest = RowCues::of_library(&[memory(9.0, false), memory(2.0, false)]);
        assert_eq!(earliest.main, Some(2000));
    }

    #[test]
    fn drive_cues_give_the_first_memory_cue_and_a_loop() {
        let cue = |slot, start, loop_end| anlz::DriveCue {
            slot,
            start,
            loop_end,
        };
        let cues = RowCues::of_drive(&[
            cue(Some(2), 500, None),
            cue(Some(3), 9000, Some(11_000)),
            cue(None, 4000, Some(8000)),
            cue(None, 7000, None),
        ]);
        assert_eq!(cues.main, Some(7000));
        assert_eq!(cues.hot[2], Some(500));
        assert_eq!(cues.hot[3], Some(9000));
        assert_eq!(cues.looped, Some((4000, 8000)));
        let hot_loop_only = RowCues::of_drive(&[cue(Some(0), 100, Some(200))]);
        assert_eq!(hot_loop_only.looped, Some((100, 200)));
        assert_eq!(hot_loop_only.main, None);
    }

    #[test]
    fn waveform_files_have_the_sizes_a_player_expects() {
        // 10 seconds: 1500 rekordbox columns, so 750 entries.
        let detail: Vec<u8> = (0..1500u32).map(|i| (i % 32) as u8 | 0xe0).collect();
        let (wave, overview) = waveforms(&detail).expect("waveforms");
        assert_eq!(wave.len(), 4 + 4 * 750);
        let peak = u32::from_le_bytes(wave[..4].try_into().expect("peak"));
        let first = u16::from_le_bytes(wave[4..6].try_into().expect("entry"));
        assert_eq!(first, 528, "heights 0 and 1, whiteness bits ignored");
        assert_eq!(peak, 61 * 528);
        assert!(wave[4 + 2 * 750..].iter().all(|b| *b == 0), "zero padded");
        assert_eq!(overview.len(), 480);
        assert_eq!(overview[0], 20);
        assert!(overview.iter().all(|b| *b <= 20));
        assert!(overview.contains(&20));
    }

    #[test]
    fn short_or_silent_tracks_get_no_waveform() {
        assert_eq!(waveforms(&[5; 2 * 479]), None, "too short for the overview");
        assert_eq!(waveforms(&[0xe0; 4000]), None, "silent");
        assert_eq!(waveforms(&[]), None);
    }

    #[test]
    fn covers_are_85_pixel_rgb565() {
        let mut image = image::RgbImage::new(200, 100);
        for pixel in image.pixels_mut() {
            *pixel = image::Rgb([255, 0, 0]);
        }
        let mut png = io::Cursor::new(Vec::new());
        image
            .write_to(&mut png, image::ImageFormat::Png)
            .expect("png");
        let bytes = cover(&png.into_inner()).expect("cover");
        assert_eq!(bytes.len(), 85 * 85 * 2);
        assert_eq!(bytes[..2], 0xf800u16.to_le_bytes());
        assert_eq!(cover(b"not an image"), None);
    }

    #[test]
    fn playlist_file_names_are_safe_and_unique_ignoring_case() {
        let names = playlist_file_names(["Friday", "friday", "A/B: C?", "", "FRIDAY"].into_iter());
        assert_eq!(
            names,
            ["Friday", "friday (2)", "A_B_ C_", "playlist", "FRIDAY (3)"]
        );
    }

    #[test]
    fn only_mp3_and_wav_are_playable() {
        for (path, playable) in [
            ("/Contents/a/b/x.mp3", true),
            ("/Contents/a/b/x.MP3", true),
            ("/Contents/a/b/x.wav", true),
            ("/Contents/a/b/x.flac", false),
            ("/Contents/a/b/x.aiff", false),
            ("/Contents/a/b/x.m4a", false),
            ("/Contents/a/b/x", false),
        ] {
            assert_eq!(is_playable(path), playable, "{path}");
        }
    }

    #[test]
    fn folders_flatten_into_playlist_names_in_tree_order() {
        let lib = Library {
            playlists: vec![
                playlist(5, 0, "Loose", false, &[]),
                playlist(1, 0, "Sets", true, &[]),
                playlist(4, 3, "Deep", false, &[]),
                playlist(2, 1, "Friday", false, &[]),
                playlist(3, 1, "Warmup", true, &[]),
            ],
            ..Library::default()
        };
        let names: Vec<String> = flattened(&lib).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, ["Sets - Friday", "Sets - Warmup - Deep", "Loose"]);
    }

    fn column<T: rusqlite::types::FromSql>(conn: &Connection, column: &str, id: u32) -> T {
        conn.query_row(
            &format!("SELECT {column} FROM outer_table WHERE id = ?1"),
            params![id],
            |r| r.get(0),
        )
        .expect("column")
    }

    #[test]
    fn writes_a_library_a_player_can_read() {
        let mount = temp_mount("write");
        let mut first = track(1, "/Contents/Artist/Album/One.mp3");
        first.analyze_path = anlz::dat_path(1, &first.path);
        let stored = anlz::Stored {
            grid_bpm: Some(128.0),
            first_beat: 0.25,
            bar_offset: 0,
            duration: 20.0,
            detail: (0..3000u32).map(|i| (i % 30 + 1) as u8).collect(),
        };
        let (dat, ext) = anlz::files(&first.path, &stored, &[hot(1, 2.0)], None);
        let dat_path = mount.join(first.analyze_path.trim_start_matches('/'));
        write_atomic(&dat_path, &dat).expect("dat");
        write_atomic(&dat_path.with_extension("EXT"), &ext).expect("ext");
        let second = track(2, "/Contents/Artist/Album/Two.flac");
        let lib = Library {
            tracks: vec![first, second],
            playlists: vec![playlist(1, 0, "Friday", false, &[1, 2, 99])],
            artwork: Vec::new(),
        };

        // What an earlier export or V-CASE left behind.
        let gemini = mount.join(DIR);
        fs::create_dir_all(gemini.join(PLAYLISTS)).expect("dirs");
        fs::create_dir_all(gemini.join(WAVEFORMS)).expect("dirs");
        fs::write(gemini.join(PLAYLISTS).join("Old.m3u"), "/x.mp3\n").expect("old playlist");
        fs::write(gemini.join(PLAYLISTS).join("._Friday.m3u"), "junk").expect("mac file");
        fs::write(gemini.join(WAVEFORMS).join("77"), "stale").expect("stale waveform");
        fs::write(gemini.join(DATABASE), "old database").expect("old database");

        let summary =
            write(&mount, &lib, &HashMap::new(), "2026-11-21-120000", &[]).expect("write");
        assert_eq!(
            summary,
            Summary {
                tracks: 2,
                playlists: 1,
                playlists_left_out: 0,
                waveforms: 1,
                covers: 0,
                unplayable: 1,
                long_paths: 0,
                backup: Some("/PIONEER/manplay-backup/2026-11-21-120000/GEMINI".into()),
            }
        );
        assert!(present(&mount));
        assert_eq!(
            fs::read(gemini.join(MODELS_FILE)).expect("models"),
            b"MDJ-1000/MDJ-900/MDJ-600/MDJ-500"
        );
        assert_eq!(
            fs::read_to_string(gemini.join(PLAYLISTS).join("Friday.m3u")).expect("playlist"),
            "/Contents/Artist/Album/One.mp3\n/Contents/Artist/Album/Two.flac\n"
        );
        assert_eq!(file_names(&gemini.join(PLAYLISTS)), ["Friday.m3u"]);
        assert_eq!(file_names(&gemini.join(WAVEFORMS)), ["1"]);
        assert_eq!(file_names(&gemini.join(OVERVIEWS)), ["1"]);
        let backup = mount.join("PIONEER/manplay-backup/2026-11-21-120000/GEMINI");
        assert_eq!(
            fs::read_to_string(backup.join(DATABASE)).expect("backup"),
            "old database"
        );
        assert!(backup.join(PLAYLISTS).join("Old.m3u").is_file());

        let conn = Connection::open(gemini.join(DATABASE)).expect("open");
        let page_size: i64 = conn
            .query_row("PRAGMA page_size", [], |r| r.get(0))
            .expect("page size");
        assert_eq!(page_size, 1024);
        assert_eq!(column::<String>(&conn, "title", 1), "Song 1");
        assert_eq!(
            column::<String>(&conn, "absolute_path", 1),
            "/Contents/Artist/Album/One.mp3"
        );
        assert_eq!(column::<String>(&conn, "sync_path", 1), "One.mp3");
        assert!((column::<f64>(&conn, "bpm", 1) - 128.0).abs() < 1e-9);
        assert_eq!(column::<i64>(&conn, "bitrate", 1), 320_000);
        assert_eq!(column::<i64>(&conn, "duration_in_frames", 1), 1500);
        assert_eq!(column::<i64>(&conn, "offset", 1), 11_025);
        assert_eq!(column::<String>(&conn, "cue", 1), "0:0:75");
        assert_eq!(column::<String>(&conn, "have_cue", 1), "yes");
        assert_eq!(column::<String>(&conn, "hcue1", 1), "");
        assert_eq!(column::<String>(&conn, "hcue2", 1), "0:0:600");
        assert_eq!(column::<String>(&conn, "have_loop", 1), "no");
        assert_eq!(column::<String>(&conn, "loop_in", 1), "");
        assert_eq!(column::<String>(&conn, "have_cover", 1), "no");
        assert_eq!(column::<i64>(&conn, "samplerate", 1), 44_100);
        assert_eq!(column::<i64>(&conn, "bitdepth", 1), 16);
        assert_eq!(column::<i64>(&conn, "channel", 1), 2);
        // No analysis: length from the library, no cue, no grid.
        assert_eq!(column::<i64>(&conn, "duration_in_frames", 2), 15_000);
        assert_eq!(column::<String>(&conn, "cue", 2), "");
        assert_eq!(column::<String>(&conn, "have_cue", 2), "no");
        assert_eq!(column::<i64>(&conn, "offset", 2), 0);
        drop(conn);
        let _ = fs::remove_dir_all(&mount);
    }

    #[test]
    fn cues_set_in_the_library_replace_the_drives() {
        let mount = temp_mount("extras");
        let lib = Library {
            tracks: vec![track(1, "/Contents/Artist/Album/One.mp3")],
            ..Library::default()
        };
        let extras = HashMap::from([(
            1,
            FromLibrary {
                cues: Some(vec![hot(0, 1.0), memory(3.0, true)]),
                art_from: None,
            },
        )]);
        let summary = write(&mount, &lib, &extras, "stamp", &[]).expect("write");
        assert_eq!(summary.backup, None, "nothing to keep a copy of");
        let conn = Connection::open(mount.join(DIR).join(DATABASE)).expect("open");
        assert_eq!(column::<String>(&conn, "cue", 1), "0:0:900");
        assert_eq!(column::<String>(&conn, "hcue1", 1), "0:0:300");
        drop(conn);
        let _ = fs::remove_dir_all(&mount);
    }

    #[test]
    fn a_playlist_folders_copy_of_a_song_gets_its_own_row_and_files() {
        let mount = temp_mount("copies");
        let lib = Library {
            tracks: vec![track(1, "/Playlists/Friday/01 One.mp3")],
            ..Library::default()
        };
        let extras = HashMap::from([(
            1,
            FromLibrary {
                cues: Some(vec![hot(0, 1.0)]),
                art_from: None,
            },
        )]);
        let gemini = mount.join(DIR);
        fs::create_dir_all(gemini.join(COVERS)).expect("dirs");
        fs::write(gemini.join(COVERS).join("1"), "cover").expect("cover");
        let copies = [playlist_folders::Copy {
            track: 1,
            path: "/Playlists/Late/01 One.mp3".into(),
        }];
        let summary = write(&mount, &lib, &HashMap::new(), "s", &copies).expect("write");
        assert_eq!(summary.tracks, 1, "copies are not counted as songs");
        assert_eq!(
            fs::read_to_string(gemini.join(COVERS).join("2")).expect("copy's cover"),
            "cover"
        );
        write(&mount, &lib, &extras, "s", &copies).expect("write");
        let conn = Connection::open(gemini.join(DATABASE)).expect("open");
        let rows: Vec<(u32, String, String, String)> = conn
            .prepare("SELECT id, absolute_path, sync_path, hcue1 FROM outer_table ORDER BY id")
            .expect("prepare")
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows");
        assert_eq!(
            rows,
            [
                (
                    1,
                    "/Playlists/Friday/01 One.mp3".into(),
                    "01 One.mp3".into(),
                    "0:0:300".into()
                ),
                (
                    2,
                    "/Playlists/Late/01 One.mp3".into(),
                    "01 One.mp3".into(),
                    "0:0:300".into()
                ),
            ]
        );
        drop(conn);
        assert!(
            !gemini.join(COVERS).join("2").exists(),
            "the song lost its cover, so its copy did too"
        );
        let _ = fs::remove_dir_all(&mount);
    }

    #[test]
    fn only_the_first_hundred_playlists_are_written_and_long_paths_left_out() {
        let mount = temp_mount("limits");
        let long = format!("/Contents/{}/x.mp3", "a".repeat(250));
        let lib = Library {
            tracks: vec![track(1, &long), track(2, "/Contents/a/b/y.mp3")],
            playlists: (1..=103)
                .map(|id| playlist(id, 0, &format!("List {id}"), false, &[1, 2]))
                .collect(),
            artwork: Vec::new(),
        };
        let summary = write(&mount, &lib, &HashMap::new(), "stamp", &[]).expect("write");
        assert_eq!(summary.playlists, 100);
        assert_eq!(summary.playlists_left_out, 3);
        assert_eq!(summary.long_paths, 100);
        let dir = mount.join(DIR).join(PLAYLISTS);
        assert_eq!(file_names(&dir).len(), 100);
        assert_eq!(
            fs::read_to_string(dir.join("List 1.m3u")).expect("playlist"),
            "/Contents/a/b/y.mp3\n"
        );
        assert!(!dir.join("List 101.m3u").exists());
        let _ = fs::remove_dir_all(&mount);
    }
}
