//! Import from a messy folder (e.g. Downloads): find music that is not in the library yet,
//! group it into albums, guess artist/album, and copy it into `library/Artist/Album/`.
//!
//! Zip files are treated as folders: they are read in place and only the chosen tracks are
//! extracted. Nothing in the source folder is ever changed or deleted.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Cursor, Read};
use std::path::{Path, PathBuf};

use lofty::file::{FileType, TaggedFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;
use zip::ZipArchive;

use crate::error::Error;
use crate::fsops;
use crate::itunes::sanitize;
use crate::scan::{fingerprint, fingerprint_reader, is_audio};

/// File size → fingerprints of every present library track of that size.
pub type ContentIndex = HashMap<u64, HashSet<String>>;

/// One file: on disk (`entry` is `None`) or inside the zip at `path`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub path: String,
    pub entry: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    New,
    InLibrary,
    /// Same content as another file found earlier in this scan.
    Duplicate,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GroupKind {
    Album,
    Single,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportTrack {
    pub src: SourceRef,
    pub file: String,
    pub title: String,
    pub artist: String,
    pub size: u64,
    pub status: Status,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportGroup {
    pub id: usize,
    pub kind: GroupKind,
    /// Where it was found, relative to the scanned folder.
    pub origin: String,
    pub from_zip: bool,
    /// Unix seconds of the newest file in the group; the list is sorted by this, newest first.
    pub modified: i64,
    pub artist: String,
    pub album: String,
    pub tracks: Vec<ImportTrack>,
    pub images: Vec<SourceRef>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportScan {
    /// Only groups with at least one track that is not in the library.
    pub groups: Vec<ImportGroup>,
    /// Music files that are already in the library.
    pub already_in_library: usize,
    /// Files or archives that could not be read.
    pub errors: usize,
}

// ---- finding files -----------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Audio,
    Image,
    /// Harmless extras that do not stop a folder being an album (cue sheets, logs, …).
    Ignorable,
    Other,
}

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic",
];
const IGNORED_EXTS: &[&str] = &[
    "cue", "log", "nfo", "txt", "m3u", "m3u8", "sfv", "md5", "url", "pdf", "db", "ini", "accurip",
    "rtf", "htm", "html",
];

fn kind_of(name: &str) -> Kind {
    if name.starts_with('.') {
        return Kind::Ignorable;
    }
    if is_audio(Path::new(name)) {
        return Kind::Audio;
    }
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if IMAGE_EXTS.contains(&ext.as_str()) {
        Kind::Image
    } else if IGNORED_EXTS.contains(&ext.as_str()) {
        Kind::Ignorable
    } else {
        Kind::Other
    }
}

struct Entry {
    /// Folder path below the scanned folder; a zip counts as a folder named after the file.
    dir: Vec<String>,
    name: String,
    kind: Kind,
    size: u64,
    /// Unix seconds (a zip's entries use the zip file's own time).
    modified: i64,
    src: SourceRef,
}

fn unix_secs(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_secs()).ok())
        .unwrap_or(0)
}

fn comps(path: &Path) -> Vec<String> {
    path.iter()
        .filter_map(|c| c.to_str().map(str::to_owned))
        .collect()
}

fn hidden_dir(parts: &[String]) -> bool {
    parts.iter().any(|p| p.starts_with('.') || p == "__MACOSX")
}

// ---- cache -------------------------------------------------------------------

/// What a previous scan learned about one file. Valid while size and modified time match.
#[derive(Serialize, Deserialize, Clone)]
struct CachedFile {
    path: String,
    entry: Option<String>,
    size: u64,
    modified: i64,
    fingerprint: Option<String>,
    meta: Option<Meta>,
}

/// One file inside a zip, as listed in its central directory.
#[derive(Serialize, Deserialize, Clone)]
struct ZipItem {
    /// Folder inside the zip.
    dir: Vec<String>,
    name: String,
    /// Exact entry name, used to open it.
    raw: String,
    size: u64,
}

#[derive(Serialize, Deserialize, Clone)]
struct CachedZip {
    path: String,
    size: u64,
    modified: i64,
    items: Vec<ZipItem>,
    errors: usize,
}

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    files: Vec<CachedFile>,
    zips: Vec<CachedZip>,
}

/// Results of earlier scans of one folder, so unchanged files and zips are not read again.
#[derive(Default)]
pub struct Cache {
    files: HashMap<(String, String), CachedFile>,
    zips: HashMap<String, CachedZip>,
}

impl Cache {
    pub fn from_json(json: &str) -> Self {
        let stored: Stored = serde_json::from_str(json).unwrap_or_default();
        Self {
            files: stored
                .files
                .into_iter()
                .map(|f| (Self::file_key(&f.path, f.entry.as_deref()), f))
                .collect(),
            zips: stored
                .zips
                .into_iter()
                .map(|z| (z.path.clone(), z))
                .collect(),
        }
    }

    pub fn to_json(&self) -> String {
        let stored = Stored {
            files: self.files.values().cloned().collect(),
            zips: self.zips.values().cloned().collect(),
        };
        serde_json::to_string(&stored).unwrap_or_default()
    }

    fn file_key(path: &str, entry: Option<&str>) -> (String, String) {
        (path.to_owned(), entry.unwrap_or_default().to_owned())
    }

    /// The cached record for `e`, only if the file has not changed since.
    fn file_for(&self, e: &Entry) -> Option<&CachedFile> {
        self.files
            .get(&Self::file_key(&e.src.path, e.src.entry.as_deref()))
            .filter(|c| c.size == e.size && c.modified == e.modified)
    }
}

/// Lists the files inside the zip at `path`. The count is the number of problems.
fn list_zip(path: &Path) -> Option<(Vec<ZipItem>, usize)> {
    let file = File::open(path).ok()?;
    let mut zip = ZipArchive::new(BufReader::new(file)).ok()?;
    let mut items = Vec::new();
    let mut errors = 0;
    for i in 0..zip.len() {
        let Ok(f) = zip.by_index_raw(i) else {
            errors += 1;
            continue;
        };
        if f.is_dir() {
            continue;
        }
        // `enclosed_name` rejects `../` and absolute names.
        let Some(enclosed) = f.enclosed_name() else {
            errors += 1;
            continue;
        };
        let mut dir = comps(&enclosed);
        let Some(name) = dir.pop() else {
            continue;
        };
        if hidden_dir(&dir) {
            continue;
        }
        let Ok(raw) = f.name() else {
            errors += 1;
            continue;
        };
        items.push(ZipItem {
            dir,
            name,
            raw: raw.into_owned(),
            size: f.size(),
        });
    }
    Some((items, errors))
}

/// Adds the files inside the zip at `path` (below `dir`), reusing the cached listing when the
/// zip is unchanged. Returns the number of problems.
fn read_zip(
    path: &Path,
    dir: &[String],
    meta: &fs::Metadata,
    cache: &mut CacheCtx<'_>,
    out: &mut Vec<Entry>,
) -> usize {
    let Some(shown) = path.to_str() else {
        return 1;
    };
    let (size, modified) = (meta.len(), unix_secs(meta));
    let cached = cache
        .old
        .zips
        .get(shown)
        .filter(|z| z.size == size && z.modified == modified)
        .cloned();
    let zip = if let Some(z) = cached {
        z
    } else {
        if cache.cached_only {
            return 0;
        }
        let Some((items, errors)) = list_zip(path) else {
            return 1;
        };
        CachedZip {
            path: shown.to_owned(),
            size,
            modified,
            items,
            errors,
        }
    };
    for item in &zip.items {
        let mut full = dir.to_vec();
        full.extend(item.dir.iter().cloned());
        out.push(Entry {
            dir: full,
            kind: kind_of(&item.name),
            name: item.name.clone(),
            size: item.size,
            modified,
            src: SourceRef {
                path: shown.to_owned(),
                entry: Some(item.raw.clone()),
            },
        });
    }
    let errors = zip.errors;
    cache.next.zips.insert(shown.to_owned(), zip);
    errors
}

/// The previous cache (read) and the one being built by this scan (written).
struct CacheCtx<'a> {
    old: &'a Cache,
    next: Cache,
    /// Do not open zips or read anything that is not already cached.
    cached_only: bool,
}

fn collect(root: &Path, cache: &mut CacheCtx<'_>) -> (Vec<Entry>, usize) {
    let mut out = Vec::new();
    let mut errors = 0;
    for e in WalkDir::new(root) {
        let Ok(e) = e else {
            errors += 1;
            continue;
        };
        if !e.file_type().is_file() {
            continue;
        }
        let Ok(rel) = e.path().strip_prefix(root) else {
            continue;
        };
        let mut parts = comps(rel);
        let Some(name) = parts.pop() else {
            continue;
        };
        if hidden_dir(&parts) {
            continue;
        }
        let (Some(shown), Ok(meta)) = (e.path().to_str(), e.metadata()) else {
            errors += 1;
            continue;
        };
        let modified = unix_secs(&meta);
        if !name.starts_with('.') && is_zip(&name) {
            let mut dir = parts;
            dir.push(name);
            errors += read_zip(e.path(), &dir, &meta, cache, &mut out);
            continue;
        }
        out.push(Entry {
            dir: parts,
            kind: kind_of(&name),
            name,
            size: meta.len(),
            modified,
            src: SourceRef {
                path: shown.to_owned(),
                entry: None,
            },
        });
    }
    out.sort_by(|a, b| (&a.dir, a.name.to_lowercase()).cmp(&(&b.dir, b.name.to_lowercase())));
    (out, errors)
}

// ---- reading files (disk or zip) ---------------------------------------------

#[derive(Default)]
struct Opener {
    zips: HashMap<String, ZipArchive<BufReader<File>>>,
}

impl Opener {
    fn archive(&mut self, path: &str) -> Option<&mut ZipArchive<BufReader<File>>> {
        if !self.zips.contains_key(path) {
            let file = File::open(path).ok()?;
            let zip = ZipArchive::new(BufReader::new(file)).ok()?;
            self.zips.insert(path.to_owned(), zip);
        }
        self.zips.get_mut(path)
    }

    fn bytes(&mut self, src: &SourceRef) -> Option<Vec<u8>> {
        match &src.entry {
            None => fs::read(&src.path).ok(),
            Some(name) => {
                let mut f = self.archive(&src.path)?.by_name(name).ok()?;
                let mut v = Vec::new();
                f.read_to_end(&mut v).ok()?;
                Some(v)
            }
        }
    }

    fn fingerprint(&mut self, src: &SourceRef, size: u64) -> Option<String> {
        if src.entry.is_none() {
            return fingerprint(Path::new(&src.path), size);
        }
        let bytes = self.bytes(src)?;
        let len = u64::try_from(bytes.len()).ok()?;
        fingerprint_reader(&mut Cursor::new(bytes), len)
    }

    fn copy_to(&mut self, src: &SourceRef, out: &mut File) -> io::Result<()> {
        match &src.entry {
            None => io::copy(&mut File::open(&src.path)?, out).map(drop),
            Some(name) => {
                let zip = self
                    .archive(&src.path)
                    .ok_or_else(|| io::Error::other("zip not readable"))?;
                let mut f = zip.by_name(name).map_err(io::Error::other)?;
                io::copy(&mut f, out).map(drop)
            }
        }
    }
}

#[derive(Default, Clone, Serialize, Deserialize)]
struct Meta {
    title: Option<String>,
    artist: Option<String>,
    album_artist: Option<String>,
    album: Option<String>,
}

fn text(s: Option<impl AsRef<str>>) -> Option<String> {
    s.map(|s| s.as_ref().trim().to_owned())
        .filter(|s| !s.is_empty())
}

fn meta_from(tagged: &TaggedFile) -> Meta {
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Meta::default();
    };
    Meta {
        title: text(tag.title()),
        artist: text(tag.artist()),
        album_artist: text(tag.get_string(ItemKey::AlbumArtist)),
        album: text(tag.album()),
    }
}

fn read_meta(opener: &mut Opener, e: &Entry) -> Meta {
    let tagged = if e.src.entry.is_none() {
        lofty::read_from_path(&e.src.path).ok()
    } else {
        opener.bytes(&e.src).and_then(|b| {
            let ft = Path::new(&e.name)
                .extension()
                .and_then(|x| x.to_str())
                .and_then(FileType::from_ext);
            let mut probe = Probe::new(Cursor::new(b));
            if let Some(ft) = ft {
                probe = probe.set_file_type(ft);
            }
            probe.read().ok()
        })
    };
    tagged.as_ref().map(meta_from).unwrap_or_default()
}

// ---- grouping ----------------------------------------------------------------

/// `CD1`, `Disc 2`, `disk_3 - bonus` …
fn is_disc_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["disc", "disk", "cd"]
        .iter()
        .find_map(|p| lower.strip_prefix(p))
        .is_some_and(|rest| {
            rest.trim_start_matches([' ', '_', '-', '.'])
                .starts_with(|c: char| c.is_ascii_digit())
        })
}

fn is_zip(name: &str) -> bool {
    Path::new(name)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
}

fn strip_zip(name: &str) -> &str {
    if is_zip(name) {
        &name[..name.len() - 4]
    } else {
        name
    }
}

/// Drops release tags like `[FLAC]` / `[WEB]` from the end of a folder name.
fn clean_folder_name(name: &str) -> String {
    let mut s = strip_zip(name).trim();
    while s.ends_with(']') {
        match s.rfind('[') {
            Some(i) if i > 0 => s = s[..i].trim_end(),
            _ => break,
        }
    }
    s.to_owned()
}

fn split_artist_album(folder: &str) -> Option<(String, String)> {
    let (a, b) = folder.split_once(" - ")?;
    let (a, b) = (a.trim(), b.trim());
    (!a.is_empty() && !b.is_empty()).then(|| (a.to_owned(), b.to_owned()))
}

/// The most common value and how many times it occurs (ties: alphabetically first).
fn most_common<'a>(items: impl Iterator<Item = &'a str>) -> Option<(String, usize)> {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for i in items {
        *counts.entry(i).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(a.0)))
        .map(|(k, n)| (k.to_owned(), n))
}

/// Artist and album for a whole folder. Tags win over the folder name; mixed track artists
/// without an album artist become "Various Artists".
fn guess_album(folder: &str, metas: &[&Meta]) -> (String, String) {
    let folder = clean_folder_name(folder);
    let split = split_artist_album(&folder);
    let album = most_common(metas.iter().filter_map(|m| m.album.as_deref()))
        .map(|(a, _)| a)
        .or_else(|| split.as_ref().map(|(_, b)| b.clone()))
        .unwrap_or_else(|| {
            if folder.is_empty() {
                "Unknown".to_owned()
            } else {
                folder.clone()
            }
        });
    let artist = most_common(metas.iter().filter_map(|m| m.album_artist.as_deref()))
        .map(|(a, _)| a)
        .or_else(|| {
            let tagged = metas.iter().filter(|m| m.artist.is_some()).count();
            let (top, n) = most_common(metas.iter().filter_map(|m| m.artist.as_deref()))?;
            Some(if n * 2 > tagged {
                top
            } else {
                "Various Artists".to_owned()
            })
        })
        .or_else(|| split.map(|(a, _)| a))
        .unwrap_or_else(|| "Unknown".to_owned());
    (artist, album)
}

fn guess_single(file_stem: &str, m: &Meta) -> (String, String) {
    let artist = m
        .album_artist
        .clone()
        .or_else(|| m.artist.clone())
        .or_else(|| split_artist_album(file_stem).map(|(a, _)| a))
        .unwrap_or_else(|| "Unknown".to_owned());
    (
        artist,
        m.album.clone().unwrap_or_else(|| "Unknown".to_owned()),
    )
}

struct Draft {
    kind: GroupKind,
    /// Folder (or zip) name for albums; the file name for singles.
    name: String,
    origin: String,
    from_zip: bool,
    tracks: Vec<usize>,
    images: Vec<usize>,
}

fn drafts(entries: &[Entry]) -> Vec<Draft> {
    let mut by_dir: BTreeMap<&[String], Vec<usize>> = BTreeMap::new();
    for (i, e) in entries.iter().enumerate() {
        by_dir.entry(&e.dir).or_default().push(i);
    }
    let of_kind = |d: &[String], k: Kind| -> Vec<usize> {
        by_dir
            .get(d)
            .map(|v| {
                v.iter()
                    .copied()
                    .filter(|&i| entries[i].kind == k)
                    .collect()
            })
            .unwrap_or_default()
    };
    let audio_dirs: Vec<&[String]> = by_dir
        .keys()
        .copied()
        .filter(|d| !of_kind(d, Kind::Audio).is_empty())
        .collect();
    // Only music, pictures and harmless extras, and no deeper folder with music.
    let album_dir = |d: &[String]| {
        !d.is_empty()
            && audio_dirs.contains(&d)
            && by_dir[d].iter().all(|&i| entries[i].kind != Kind::Other)
            && !audio_dirs
                .iter()
                .any(|o| o.len() > d.len() && o.starts_with(d))
    };
    let from_zip = |i: usize| entries[i].src.entry.is_some();
    let origin = |d: &[String]| d.join("/");

    // `Album/CD1`, `Album/CD2` belong together as `Album`.
    let mut merged: BTreeMap<&[String], &[String]> = BTreeMap::new();
    for &d in &audio_dirs {
        let Some((last, parent)) = d.split_last() else {
            continue;
        };
        if parent.is_empty() || !is_disc_name(last) || !album_dir(d) {
            continue;
        }
        let siblings_ok = !audio_dirs.contains(&parent)
            && audio_dirs
                .iter()
                .filter(|o| o.starts_with(parent) && o.len() > parent.len())
                .all(|o| {
                    o.len() == parent.len() + 1
                        && o.last().is_some_and(|n| is_disc_name(n))
                        && album_dir(o)
                });
        if siblings_ok {
            merged.insert(d, parent);
        }
    }

    let mut out: Vec<Draft> = Vec::new();
    let mut by_parent: BTreeMap<&[String], usize> = BTreeMap::new();
    for &d in &audio_dirs {
        let tracks = of_kind(d, Kind::Audio);
        let images = of_kind(d, Kind::Image);
        if let Some(&parent) = merged.get(d) {
            let idx = *by_parent.entry(parent).or_insert_with(|| {
                out.push(Draft {
                    kind: GroupKind::Album,
                    name: parent.last().cloned().unwrap_or_default(),
                    origin: origin(parent),
                    from_zip: false,
                    tracks: Vec::new(),
                    images: of_kind(parent, Kind::Image),
                });
                out.len() - 1
            });
            out[idx].from_zip |= tracks.first().is_some_and(|&i| from_zip(i));
            out[idx].tracks.extend(tracks);
            out[idx].images.extend(images);
        } else if album_dir(d) {
            out.push(Draft {
                kind: GroupKind::Album,
                name: d.last().cloned().unwrap_or_default(),
                origin: origin(d),
                from_zip: tracks.first().is_some_and(|&i| from_zip(i)),
                tracks,
                images,
            });
        } else {
            for i in tracks {
                out.push(Draft {
                    kind: GroupKind::Single,
                    name: entries[i].name.clone(),
                    origin: origin(d),
                    from_zip: from_zip(i),
                    tracks: vec![i],
                    images: Vec::new(),
                });
            }
        }
    }
    out
}

// ---- scanning ----------------------------------------------------------------

/// Turns a draft into the group shown to the user, with the guessed artist and album.
fn group_of(
    d: Draft,
    new: &[usize],
    metas: &HashMap<usize, Meta>,
    entries: &[Entry],
    status: &HashMap<usize, Status>,
) -> ImportGroup {
    let (artist, album) = match d.kind {
        GroupKind::Album => {
            let refs: Vec<&Meta> = metas.values().collect();
            guess_album(&d.name, &refs)
        }
        GroupKind::Single => {
            let stem = Path::new(&d.name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            guess_single(stem, &metas[&new[0]])
        }
    };
    let tracks = d
        .tracks
        .iter()
        .map(|&i| {
            let e = &entries[i];
            let m = metas.get(&i);
            let stem = Path::new(&e.name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&e.name);
            ImportTrack {
                src: e.src.clone(),
                file: e.name.clone(),
                title: m
                    .and_then(|m| m.title.clone())
                    .unwrap_or_else(|| stem.to_owned()),
                artist: m.and_then(|m| m.artist.clone()).unwrap_or_default(),
                size: e.size,
                status: status[&i],
            }
        })
        .collect();
    ImportGroup {
        id: 0,
        kind: d.kind,
        origin: d.origin,
        from_zip: d.from_zip,
        modified: d
            .tracks
            .iter()
            .map(|&i| entries[i].modified)
            .max()
            .unwrap_or(0),
        artist,
        album,
        tracks,
        images: d.images.iter().map(|&i| entries[i].src.clone()).collect(),
    }
}

/// What a running scan reports to the UI.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// `listing`, `checking` or `tags`.
    pub phase: &'static str,
    pub done: usize,
    pub total: usize,
}

pub struct Options<'a> {
    /// Build the result only from the cache, reading no files. Instant, but may be incomplete.
    pub cached_only: bool,
    pub report: &'a dyn Fn(&Progress),
}

/// Whether each music file is new, already in the library, or a repeat within this scan.
/// Fills `cached` with what was learned about every file.
fn statuses(
    entries: &[Entry],
    known: &ContentIndex,
    old: &Cache,
    opener: &mut Opener,
    cached: &mut HashMap<usize, CachedFile>,
    opts: &Options<'_>,
) -> (HashMap<usize, Status>, usize) {
    // Same size as something in the library or elsewhere in this scan is the only case where
    // content has to be compared, so most files are never read.
    let mut sizes: HashMap<u64, usize> = HashMap::new();
    for e in entries.iter().filter(|e| e.kind == Kind::Audio) {
        *sizes.entry(e.size).or_default() += 1;
    }
    let mut seen: HashSet<(u64, String)> = HashSet::new();
    let mut status: HashMap<usize, Status> = HashMap::new();
    let mut already = 0;
    let total = sizes.values().sum();
    let mut checked = 0;
    for (i, e) in entries.iter().enumerate() {
        if e.kind != Kind::Audio {
            continue;
        }
        if checked % 8 == 0 || checked + 1 == total {
            (opts.report)(&Progress {
                phase: "checking",
                done: checked,
                total,
            });
        }
        checked += 1;
        let contested = known.contains_key(&e.size) || sizes.get(&e.size).is_some_and(|n| *n > 1);
        let mut record = old.file_for(e).cloned().unwrap_or_else(|| CachedFile {
            path: e.src.path.clone(),
            entry: e.src.entry.clone(),
            size: e.size,
            modified: e.modified,
            fingerprint: None,
            meta: None,
        });
        if contested && !opts.cached_only && record.fingerprint.is_none() {
            record.fingerprint = opener.fingerprint(&e.src, e.size);
        }
        let fp = contested.then(|| record.fingerprint.clone()).flatten();
        cached.insert(i, record);
        let s = match fp {
            None => Status::New,
            Some(f) if known.get(&e.size).is_some_and(|set| set.contains(&f)) => {
                already += 1;
                Status::InLibrary
            }
            Some(f) => {
                if seen.insert((e.size, f)) {
                    Status::New
                } else {
                    Status::Duplicate
                }
            }
        };
        status.insert(i, s);
    }
    (status, already)
}

/// Counts how many files still needing their tags read have been handled.
struct TagProgress<'a> {
    opts: &'a Options<'a>,
    done: usize,
    total: usize,
}

/// Tags of entry `i`, from the cache when the file is unchanged, otherwise read (and cached).
fn meta_of(
    i: usize,
    entries: &[Entry],
    opener: &mut Opener,
    cached: &mut HashMap<usize, CachedFile>,
    tags: &mut TagProgress<'_>,
) -> Meta {
    if let Some(m) = cached.get(&i).and_then(|c| c.meta.clone()) {
        return m;
    }
    if tags.opts.cached_only {
        return Meta::default();
    }
    (tags.opts.report)(&Progress {
        phase: "tags",
        done: tags.done,
        total: tags.total,
    });
    tags.done += 1;
    let m = read_meta(opener, &entries[i]);
    if let Some(c) = cached.get_mut(&i) {
        c.meta = Some(m.clone());
    }
    m
}

/// Finds music under `folder` that is not in the library (`known`), grouped into albums.
/// Files and zips unchanged since `old` was built are not read again; the returned cache
/// holds everything seen this time (files that disappeared drop out).
pub fn scan(
    folder: &Path,
    known: &ContentIndex,
    old: &Cache,
    opts: &Options<'_>,
) -> (ImportScan, Cache) {
    (opts.report)(&Progress {
        phase: "listing",
        done: 0,
        total: 0,
    });
    let mut ctx = CacheCtx {
        old,
        next: Cache::default(),
        cached_only: opts.cached_only,
    };
    let (mut entries, errors) = collect(folder, &mut ctx);
    if opts.cached_only {
        entries.retain(|e| e.kind != Kind::Audio || old.file_for(e).is_some());
    }
    let mut opener = Opener::default();
    let mut cached: HashMap<usize, CachedFile> = HashMap::new();

    let (status, already) = statuses(&entries, known, old, &mut opener, &mut cached, opts);

    let missing_tags = status
        .iter()
        .filter(|&(i, s)| *s == Status::New && cached[i].meta.is_none())
        .count();
    let mut tags = TagProgress {
        opts,
        done: 0,
        total: missing_tags,
    };
    let mut groups = Vec::new();
    for d in drafts(&entries) {
        let new: Vec<usize> = d
            .tracks
            .iter()
            .copied()
            .filter(|i| status[i] == Status::New)
            .collect();
        if new.is_empty() {
            continue;
        }
        let metas: HashMap<usize, Meta> = new
            .iter()
            .map(|&i| (i, meta_of(i, &entries, &mut opener, &mut cached, &mut tags)))
            .collect();
        groups.push(group_of(d, &new, &metas, &entries, &status));
    }
    groups.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.origin.cmp(&b.origin))
    });
    for (i, g) in groups.iter_mut().enumerate() {
        g.id = i;
    }
    for c in cached.into_values() {
        let key = Cache::file_key(&c.path, c.entry.as_deref());
        ctx.next.files.insert(key, c);
    }
    (
        ImportScan {
            groups,
            already_in_library: already,
            errors,
        },
        ctx.next,
    )
}

// ---- importing ---------------------------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub artist: String,
    pub album: String,
    pub tracks: Vec<SourceRef>,
    pub images: Vec<SourceRef>,
}

#[derive(Serialize, Debug)]
pub struct Failure {
    pub file: String,
    pub error: String,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: usize,
    pub images: usize,
    pub failed: Vec<Failure>,
}

/// Last path segment of a file name or zip entry name, split into stem and extension.
fn split_name(src: &SourceRef) -> (String, String) {
    let full = src.entry.as_deref().unwrap_or(&src.path);
    let file = full.rsplit(['/', '\\']).next().unwrap_or(full);
    let p = Path::new(file);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
    (sanitize(stem, "track"), ext.to_ascii_lowercase())
}

fn dest_name(stem: &str, ext: &str, n: u32) -> String {
    let suffix = if n == 0 {
        String::new()
    } else {
        format!(" ({})", n + 1)
    };
    if ext.is_empty() {
        format!("{stem}{suffix}")
    } else {
        format!("{stem}{suffix}.{ext}")
    }
}

/// Creates a new file in `dir`, adding ` (2)`, ` (3)`… if the name is taken. Never overwrites.
fn create_unique(dir: &Path, stem: &str, ext: &str) -> io::Result<(File, PathBuf)> {
    for n in 0..1000 {
        let path = dir.join(dest_name(stem, ext, n));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(f) => return Ok((f, path)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::other("too many files with this name"))
}

/// Checks the file lies inside the scanned folder (a zip counts by its own path).
fn confine(folder: &Path, src: &SourceRef) -> Result<SourceRef, Error> {
    let resolved = fsops::inside(folder, Path::new(&src.path))?;
    Ok(SourceRef {
        path: resolved
            .to_str()
            .ok_or_else(|| Error::Msg("path is not valid text".to_owned()))?
            .to_owned(),
        entry: src.entry.clone(),
    })
}

fn import_track(
    opener: &mut Opener,
    folder: &Path,
    dir: &Path,
    src: &SourceRef,
) -> Result<(), Error> {
    let src = confine(folder, src)?;
    let (stem, ext) = split_name(&src);
    if !is_audio(Path::new(&format!("x.{ext}"))) {
        return Err(Error::Msg("not a supported audio file".to_owned()));
    }
    let (mut file, path) = create_unique(dir, &stem, &ext)?;
    if let Err(e) = opener.copy_to(&src, &mut file) {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(e.into());
    }
    Ok(())
}

/// Copies an image next to the tracks unless that name is already there.
fn import_image(
    opener: &mut Opener,
    folder: &Path,
    dir: &Path,
    src: &SourceRef,
) -> Result<bool, Error> {
    let src = confine(folder, src)?;
    let (stem, ext) = split_name(&src);
    if kind_of(&format!("x.{ext}")) != Kind::Image {
        return Err(Error::Msg("not a supported image".to_owned()));
    }
    let path = dir.join(dest_name(&stem, &ext, 0));
    let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    if let Err(e) = opener.copy_to(&src, &mut file) {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(e.into());
    }
    Ok(true)
}

/// Copies the chosen files into `library/Artist/Album/`, extracting from zips as needed.
pub fn run(folder: &Path, library: &Path, groups: &[ImportRequest]) -> ImportReport {
    let mut report = ImportReport::default();
    let mut opener = Opener::default();
    for g in groups {
        let dir = library
            .join(sanitize(&g.artist, "Unknown"))
            .join(sanitize(&g.album, "Unknown"));
        if let Err(e) = fs::create_dir_all(&dir) {
            report.failed.push(Failure {
                file: dir.display().to_string(),
                error: e.to_string(),
            });
            continue;
        }
        let mut copied = 0;
        for t in &g.tracks {
            match import_track(&mut opener, folder, &dir, t) {
                Ok(()) => copied += 1,
                Err(e) => report.failed.push(Failure {
                    file: t.entry.clone().unwrap_or_else(|| t.path.clone()),
                    error: e.to_string(),
                }),
            }
        }
        report.imported += copied;
        if copied == 0 {
            // Nothing arrived: do not leave an empty album folder or stray cover art behind.
            let _ = fs::remove_dir(&dir);
            if let Some(artist_dir) = dir.parent() {
                let _ = fs::remove_dir(artist_dir); // only succeeds when empty
            }
            continue;
        }
        for img in &g.images {
            match import_image(&mut opener, folder, &dir, img) {
                Ok(true) => report.images += 1,
                Ok(false) => {}
                Err(e) => report.failed.push(Failure {
                    file: img.entry.clone().unwrap_or_else(|| img.path.clone()),
                    error: e.to_string(),
                }),
            }
        }
    }
    report
}

/// A playable file for `src`: the file itself, or a zip entry extracted into `cache_dir`.
/// Extracted files are reused, and ones untouched for a day are removed.
pub fn preview(folder: &Path, src: &SourceRef, cache_dir: &Path) -> Result<PathBuf, Error> {
    let src = confine(folder, src)?;
    let Some(entry) = &src.entry else {
        return Ok(PathBuf::from(src.path));
    };
    let (_, ext) = split_name(&src);
    if !is_audio(Path::new(&format!("x.{ext}"))) {
        return Err(Error::Msg("not a supported audio file".to_owned()));
    }
    fs::create_dir_all(cache_dir)?;
    prune_old(cache_dir);
    let id = blake3::hash(format!("{}\0{entry}", src.path).as_bytes()).to_hex();
    let dest = cache_dir.join(format!("{}.{ext}", &id.as_str()[..24]));
    if !dest.is_file() {
        let part = dest.with_extension("part");
        let mut file = File::create(&part)?;
        if let Err(e) = Opener::default().copy_to(&src, &mut file) {
            drop(file);
            let _ = fs::remove_file(&part);
            return Err(e.into());
        }
        fs::rename(&part, &dest)?;
    }
    Ok(dest)
}

fn prune_old(dir: &Path) {
    let day = std::time::Duration::from_secs(24 * 60 * 60);
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    for e in read.filter_map(Result::ok) {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > day);
        if old {
            let _ = fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use std::io::Write;

    use super::*;

    fn quiet() -> Options<'static> {
        Options {
            cached_only: false,
            report: &|_| {},
        }
    }

    fn scan(root: &Path, known: &ContentIndex) -> ImportScan {
        super::scan(root, known, &Cache::default(), &quiet()).0
    }

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("manplay-import-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn put(root: &Path, rel: &str, data: &[u8]) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().expect("parent")).expect("dirs");
        fs::write(p, data).expect("write");
    }

    fn zip_of(path: &Path, files: &[(&str, &[u8])]) {
        let mut w = zip::ZipWriter::new(File::create(path).expect("zip file"));
        for (name, data) in files {
            w.start_file(*name, zip::write::SimpleFileOptions::default())
                .expect("start");
            w.write_all(data).expect("data");
        }
        w.finish().expect("finish");
    }

    fn names(scan: &ImportScan) -> Vec<(GroupKind, String, usize)> {
        scan.groups
            .iter()
            .map(|g| (g.kind, g.origin.clone(), g.tracks.len()))
            .collect()
    }

    #[test]
    fn folders_with_only_music_and_pictures_are_albums() {
        let root = temp("albums");
        put(&root, "Some Album/01 a.mp3", b"aaaa1");
        put(&root, "Some Album/02 b.mp3", b"bbbb22");
        put(&root, "Some Album/cover.jpg", b"img");
        put(&root, "Some Album/rip.log", b"log");
        put(&root, "One Song/solo.flac", b"solo-data");
        put(&root, "One Song/art.png", b"img");
        put(&root, "Mixed/x.mp3", b"mixed-1");
        put(&root, "Mixed/movie.mkv", b"video");
        put(&root, "loose.mp3", b"loose-data");
        let scan = scan(&root, &ContentIndex::new());
        let mut got = names(&scan);
        got.sort_by(|a, b| a.1.cmp(&b.1));
        assert_eq!(
            got,
            vec![
                (GroupKind::Single, String::new(), 1),
                (GroupKind::Single, "Mixed".to_owned(), 1),
                (GroupKind::Album, "One Song".to_owned(), 1),
                (GroupKind::Album, "Some Album".to_owned(), 2),
            ]
        );
        let album = scan
            .groups
            .iter()
            .find(|g| g.origin == "Some Album")
            .expect("album");
        assert_eq!(album.images.len(), 1);
        assert_eq!(album.album, "Some Album");
    }

    #[test]
    fn disc_folders_merge_into_one_album() {
        let root = temp("discs");
        put(&root, "Big Album/CD1/01.mp3", b"d1-1");
        put(&root, "Big Album/CD2/01.mp3", b"d2-1");
        put(&root, "Big Album/cover.jpg", b"img");
        let scan = scan(&root, &ContentIndex::new());
        assert_eq!(
            names(&scan),
            vec![(GroupKind::Album, "Big Album".to_owned(), 2)]
        );
        assert_eq!(scan.groups[0].images.len(), 1);
    }

    #[test]
    fn tracks_already_in_the_library_are_flagged_and_hidden_when_all_exist() {
        let root = temp("known");
        put(&root, "Old/01.mp3", b"already-here");
        put(&root, "Mix/01.mp3", b"already-here-too");
        put(&root, "Mix/02.mp3", b"brand-new-one");
        let mut known = ContentIndex::new();
        for data in [&b"already-here"[..], b"already-here-too"] {
            let p = root.join("probe");
            fs::write(&p, data).expect("probe");
            let size = u64::try_from(data.len()).expect("len");
            known
                .entry(size)
                .or_default()
                .insert(fingerprint(&p, size).expect("fp"));
        }
        let scan = scan(&root, &known);
        assert_eq!(scan.already_in_library, 2);
        assert_eq!(names(&scan), vec![(GroupKind::Album, "Mix".to_owned(), 2)]);
        let statuses: Vec<Status> = scan.groups[0].tracks.iter().map(|t| t.status).collect();
        assert_eq!(statuses, vec![Status::InLibrary, Status::New]);
    }

    #[test]
    fn zips_are_scanned_and_extracted() {
        let root = temp("zip");
        zip_of(
            &root.join("Artist - Album [FLAC].zip"),
            &[
                ("01 one.mp3", b"zip-one"),
                ("02 two.mp3", b"zip-two!"),
                ("cover.jpg", b"img"),
                ("__MACOSX/._01 one.mp3", b"junk"),
            ],
        );
        let found = scan(&root, &ContentIndex::new());
        assert_eq!(found.errors, 0);
        assert_eq!(found.groups.len(), 1);
        let g = &found.groups[0];
        assert!(g.from_zip);
        assert_eq!((g.artist.as_str(), g.album.as_str()), ("Artist", "Album"));

        let lib = temp("zip-lib");
        let req = ImportRequest {
            artist: g.artist.clone(),
            album: g.album.clone(),
            tracks: g.tracks.iter().map(|t| t.src.clone()).collect(),
            images: g.images.clone(),
        };
        let report = run(&root, &lib, &[req]);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!((report.imported, report.images), (2, 1));
        assert_eq!(
            fs::read(lib.join("Artist/Album/01 one.mp3")).expect("one"),
            b"zip-one"
        );
        assert!(lib.join("Artist/Album/cover.jpg").is_file());
    }

    #[test]
    fn same_content_twice_is_flagged_duplicate_and_names_never_clash() {
        let root = temp("dupe");
        put(&root, "A/01.mp3", b"same-bytes");
        put(&root, "A/02.mp3", b"same-bytes");
        put(&root, "B/01.mp3", b"other-bytes");
        let found = scan(&root, &ContentIndex::new());
        let all: Vec<Status> = found
            .groups
            .iter()
            .flat_map(|g| g.tracks.iter().map(|t| t.status))
            .collect();
        assert_eq!(all, vec![Status::New, Status::Duplicate, Status::New]);

        let lib = temp("dupe-lib");
        let t = |p: &str| SourceRef {
            path: root.join(p).to_str().expect("utf8").to_owned(),
            entry: None,
        };
        let req = ImportRequest {
            artist: "X/Y".into(),
            album: "..".into(),
            tracks: vec![t("A/01.mp3"), t("B/01.mp3")],
            images: vec![],
        };
        let report = run(&root, &lib, &[req]);
        assert_eq!(report.imported, 2);
        assert!(lib.join("X_Y/Unknown/01.mp3").is_file());
        assert!(lib.join("X_Y/Unknown/01 (2).mp3").is_file());
    }

    #[test]
    fn sources_outside_the_scanned_folder_are_refused() {
        let root = temp("escape");
        let outside = temp("escape-out");
        put(&outside, "secret.mp3", b"nope");
        let lib = temp("escape-lib");
        let req = ImportRequest {
            artist: "A".into(),
            album: "B".into(),
            tracks: vec![SourceRef {
                path: outside
                    .join("secret.mp3")
                    .to_str()
                    .expect("utf8")
                    .to_owned(),
                entry: None,
            }],
            images: vec![],
        };
        let report = run(&root, &lib, &[req]);
        assert_eq!(report.imported, 0);
        assert_eq!(report.failed.len(), 1);
        assert!(!lib.join("A").exists());
    }

    #[test]
    fn mixed_artists_become_various_and_majority_wins() {
        let m = |artist: &str| Meta {
            artist: Some(artist.to_owned()),
            ..Meta::default()
        };
        let (x1, y, z, x2) = (m("X"), m("Y"), m("Z"), m("X"));
        assert_eq!(guess_album("f", &[&x1, &y, &z]).0, "Various Artists");
        assert_eq!(guess_album("f", &[&x1, &x2, &y]).0, "X");
        assert_eq!(
            guess_album("Band - Record [WEB]", &[]),
            ("Band".into(), "Record".into())
        );
    }

    #[test]
    fn unchanged_files_and_zips_come_from_the_cache() {
        let root = temp("cache");
        put(&root, "Album/01 song.mp3", b"song-bytes");
        zip_of(&root.join("Z.zip"), &[("02 zipped.mp3", b"zipped-bytes")]);
        let known = ContentIndex::new();
        let (first, cache) = super::scan(&root, &known, &Cache::default(), &quiet());
        assert_eq!(first.groups.len(), 2);

        // Plant a marker in the cache; a second scan must serve it for unchanged files.
        let mut cache = Cache::from_json(&cache.to_json());
        for f in cache.files.values_mut() {
            f.meta = Some(Meta {
                title: Some("FROM CACHE".to_owned()),
                ..Meta::default()
            });
        }
        let (second, cache) = super::scan(&root, &known, &cache, &quiet());
        let titles: Vec<&str> = second
            .groups
            .iter()
            .flat_map(|g| g.tracks.iter().map(|t| t.title.as_str()))
            .collect();
        assert_eq!(titles, vec!["FROM CACHE", "FROM CACHE"]);

        // A changed file is read again; the untouched one stays cached.
        put(&root, "Album/01 song.mp3", b"song-bytes-edited");
        let (third, _) = super::scan(&root, &known, &cache, &quiet());
        let mut titles: Vec<&str> = third
            .groups
            .iter()
            .flat_map(|g| g.tracks.iter().map(|t| t.title.as_str()))
            .collect();
        titles.sort_unstable();
        assert_eq!(titles, vec!["01 song", "FROM CACHE"]);
    }

    #[test]
    fn cached_only_scan_shows_known_files_and_skips_the_rest() {
        let root = temp("cached-only");
        put(&root, "Old/01.mp3", b"seen-before");
        let known = ContentIndex::new();
        let (_, cache) = super::scan(&root, &known, &Cache::default(), &quiet());
        put(&root, "Fresh/01.mp3", b"brand-new-file");
        zip_of(&root.join("New.zip"), &[("a.mp3", b"in-a-new-zip")]);

        let opts = Options {
            cached_only: true,
            report: &|_| {},
        };
        let (quick, _) = super::scan(&root, &known, &cache, &opts);
        assert_eq!(names(&quick), vec![(GroupKind::Album, "Old".to_owned(), 1)]);
        let (full, _) = super::scan(&root, &known, &cache, &quiet());
        assert_eq!(full.groups.len(), 3);
    }

    #[test]
    fn progress_is_reported_while_scanning() {
        let root = temp("progress");
        put(&root, "A/01.mp3", b"one-one");
        put(&root, "A/02.mp3", b"two-two-two");
        let seen = std::cell::RefCell::new(Vec::new());
        let report = |p: &Progress| seen.borrow_mut().push((p.phase, p.done, p.total));
        let opts = Options {
            cached_only: false,
            report: &report,
        };
        super::scan(&root, &ContentIndex::new(), &Cache::default(), &opts);
        let seen = seen.into_inner();
        assert_eq!(seen.first(), Some(&("listing", 0, 0)));
        assert!(seen.contains(&("checking", 0, 2)));
        assert!(seen.contains(&("tags", 1, 2)));
    }

    #[test]
    fn zip_entries_get_a_playable_preview_file() {
        let root = temp("preview");
        zip_of(&root.join("Z.zip"), &[("dir/song.mp3", b"zip-song")]);
        let cache = temp("preview-cache");
        let src = SourceRef {
            path: root.join("Z.zip").to_str().expect("utf8").to_owned(),
            entry: Some("dir/song.mp3".to_owned()),
        };
        let out = preview(&root, &src, &cache).expect("preview");
        assert_eq!(fs::read(&out).expect("read"), b"zip-song");
        assert_eq!(preview(&root, &src, &cache).expect("again"), out);
        let loose = SourceRef {
            path: "/etc/hosts".to_owned(),
            entry: None,
        };
        assert!(preview(&root, &loose, &cache).is_err());
    }
}
