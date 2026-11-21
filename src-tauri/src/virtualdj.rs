//! `VirtualDJ`'s library on a USB drive: `VirtualDJ/database.xml`, the drive's songs with their
//! tags and cues, and `VirtualDJ/MyLists/<name>.vdjfolder`, its lists (playlists). `VirtualDJ`
//! keeps one database on each drive it has seen and shows the lists it finds beside it. Songs
//! are analysed by `VirtualDJ` when loaded. The format, and what of it is unconfirmed, is in
//! `docs/virtualdj.md`.
//!
//! Both files name a song by its full path on the computer the drive is plugged into
//! (`E:\Contents\a.mp3`, `/Volumes/STICK/Contents/a.mp3`), so every export writes them again
//! for where the drive is now.

use crate::db::Cue;
use crate::usb_export::safe_name;
use crate::usb_files::{back_up, file_names, remove_apple_double, replace};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::ops::Range;
use std::path::Path;

/// The drive's song list, relative to the drive root.
pub const DATABASE_PATH: &str = "VirtualDJ/database.xml";
/// Where `VirtualDJ` keeps a drive's lists, relative to the drive root.
pub const LISTS_DIR: &str = "VirtualDJ/MyLists";
const LIST_EXTENSION: &str = "vdjfolder";
const ROOT_ELEMENT: &str = "VirtualDJ_Database";
const SONG_ELEMENT: &str = "Song";
const PATH_ATTRIBUTE: &str = "FilePath";
/// The version a new database says it is; `VirtualDJ` brings an older one up to date itself.
const DATABASE_VERSION: &str = "8.4";
/// `VirtualDJ` writes its files with Windows line ends on every platform.
const LINE_END: &str = "\r\n";
/// Where macOS mounts drives; `VirtualDJ` treats each folder in it as a drive.
const MAC_VOLUMES: &str = "/Volumes/";

/// The drive as `VirtualDJ` names it on this computer, ending in a separator: `E:\` or
/// `/Volumes/STICK/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveRoot(String);

impl DriveRoot {
    pub fn of_mount(mount: &Path) -> Self {
        Self::of_mount_text(&mount.to_string_lossy())
    }

    fn of_mount_text(mount: &str) -> Self {
        let separator = if has_drive_letter(mount) || mount.starts_with('\\') {
            '\\'
        } else {
            '/'
        };
        let trimmed = mount.trim_end_matches(['/', '\\']);
        Self(format!("{trimmed}{separator}"))
    }

    fn separator(&self) -> char {
        if self.0.ends_with('\\') { '\\' } else { '/' }
    }
}

fn has_drive_letter(path: &str) -> bool {
    let mut chars = path.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.next() == Some(':')
}

/// A song's path from the drive root, `/` separated, with no leading `/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VirtualDjPath(String);

impl VirtualDjPath {
    /// From a path on the drive as rekordbox's library holds it (`/Contents/A/B/x.mp3`).
    pub fn from_drive_path(path: &str) -> Self {
        Self(path.replace('\\', "/").trim_start_matches('/').to_owned())
    }

    /// From a full path a database holds. Paths under `root` are on this drive, and so are the
    /// ones written while the drive had another letter or was on a Mac or a PC: the database is
    /// the drive's own. `None` for a path that names no drive.
    fn from_file_path(file_path: &str, root: &DriveRoot) -> Option<Self> {
        let path = file_path.replace('\\', "/");
        let root = root.0.replace('\\', "/");
        if let Some(rest) = strip_prefix_ignoring_case(&path, &root) {
            return Some(Self::from_drive_path(rest));
        }
        if has_drive_letter(&path) {
            return path.get(2..).map(Self::from_drive_path);
        }
        let (_volume, rest) = path.strip_prefix(MAC_VOLUMES)?.split_once('/')?;
        Some(Self::from_drive_path(rest))
    }

    /// The full path `VirtualDJ` knows the song by while the drive is at `root`.
    pub fn absolute(&self, root: &DriveRoot) -> String {
        let separator = root.separator();
        let rest: String = self
            .0
            .chars()
            .map(|c| if c == '/' { separator } else { c })
            .collect();
        format!("{}{rest}", root.0)
    }

    /// FAT and exFAT ignore case, so two paths differing only in case are one file.
    fn same_file_key(&self) -> String {
        self.0.to_lowercase()
    }
}

/// `text` without `prefix` at its start, where letters match whatever their case.
fn strip_prefix_ignoring_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let mut rest = text.chars();
    for expected in prefix.chars() {
        let found = rest.next()?;
        if !found.to_lowercase().eq(expected.to_lowercase()) {
            return None;
        }
    }
    Some(rest.as_str())
}

/// Seconds since 1970, UTC, as `VirtualDJ` stores when it first saw a song.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnixSeconds(pub u32);

/// A position in a song, or its length.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Seconds(pub f64);

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BeatsPerMinute(pub f64);

/// A cue's number as `VirtualDJ` shows it, from 1. The first eight are the hot cue pads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CueNumber(pub u8);

/// A colour as `0xRRGGBB`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb(u32);

impl Rgb {
    /// From `#rrggbb`; `None` for anything else, such as a cue with no colour of its own.
    fn from_hex(text: &str) -> Option<Self> {
        let digits = text.strip_prefix('#')?;
        if digits.len() != 6 {
            return None;
        }
        u32::from_str_radix(digits, 16).ok().map(Self)
    }

    /// As `VirtualDJ` stores a colour: opaque `0xAARRGGBB`, written in decimal.
    fn opaque(self) -> u32 {
        0xFF00_0000 | self.0
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CuePoint {
    pub number: CueNumber,
    /// Empty for a cue `VirtualDJ` names itself (`Cue 1`).
    pub name: String,
    pub at: Seconds,
    pub color: Option<Rgb>,
}

/// Cues set in manplay as `VirtualDJ` numbers them: a hot cue keeps its pad (A is 1), and the
/// memory cues take the numbers left free, in the order they come in the song.
pub fn cue_points(cues: &[Cue]) -> Vec<CuePoint> {
    let point = |number: u8, cue: &Cue| CuePoint {
        number: CueNumber(number),
        name: cue.name.clone(),
        at: Seconds(cue.start.max(0.0)),
        color: Rgb::from_hex(&cue.color),
    };
    let mut taken = HashSet::new();
    let mut out = Vec::new();
    for cue in cues {
        if let Some(number) = cue.slot.and_then(|slot| slot.checked_add(1))
            && taken.insert(number)
        {
            out.push(point(number, cue));
        }
    }
    let mut memory: Vec<&Cue> = cues.iter().filter(|c| c.slot.is_none()).collect();
    memory.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut free = (1..=u8::MAX).filter(|number| !taken.contains(number));
    for (cue, number) in memory.into_iter().zip(&mut free) {
        out.push(point(number, cue));
    }
    out.sort_by_key(|p| p.number);
    out
}

/// A song for the drive's `database.xml`. `VirtualDJ` works out the rest when it loads the file.
#[derive(Debug, Clone, PartialEq)]
pub struct Song {
    pub path: VirtualDjPath,
    pub size_bytes: u64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    pub bpm: Option<BeatsPerMinute>,
    /// As the drive's library shows it (`Am` or `8A`); empty when unknown.
    pub key: String,
    pub length: Option<Seconds>,
    pub cues: Vec<CuePoint>,
}

/// One list to put on the drive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct List {
    /// As the playlist is named in manplay.
    pub name: String,
    pub tracks: Vec<VirtualDjPath>,
}

/// Everything one export changes in the drive's `VirtualDJ` library.
pub struct Update<'a> {
    pub lists: &'a [List],
    /// Every song the lists hold; ones `database.xml` lacks are added to it.
    pub songs: &'a [Song],
    /// Lists of playlists the export took off the drive, by playlist name.
    pub remove_lists: &'a [String],
    /// Songs deleted from the drive or moved on it, which leave `database.xml`.
    pub deleted: &'a [VirtualDjPath],
    pub root: &'a DriveRoot,
    pub now: UnixSeconds,
}

/// The list's file name, safe on FAT and exFAT.
pub fn file_name(playlist_name: &str) -> String {
    format!("{}.{LIST_EXTENSION}", safe_name(playlist_name, "Playlist"))
}

/// `text` as an attribute's value. Characters XML cannot hold are left out.
fn escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' => out.push_str("&#9;"),
            '\n' => out.push_str("&#10;"),
            '\r' => out.push_str("&#13;"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// One element with its attributes on a line, skipping attributes with nothing to say.
fn element_line(indent: &str, name: &str, attributes: &[(&str, String)], line_end: &str) -> String {
    let mut line = format!("{indent}<{name}");
    for (attribute, value) in attributes {
        if !value.is_empty() {
            let _ = write!(line, " {attribute}=\"{}\"", escaped(value));
        }
    }
    line.push_str(" />");
    line.push_str(line_end);
    line
}

/// A tempo as the database stores it: the seconds between two beats.
fn beat_seconds(bpm: BeatsPerMinute) -> Option<String> {
    (bpm.0 > 0.0).then(|| format!("{:.6}", 60.0 / bpm.0))
}

/// The `<Song>` record `database.xml` holds for a song new to it, indented as `VirtualDJ`
/// expects: one space before a song, two before what it holds.
fn song_record(song: &Song, root: &DriveRoot, added: UnixSeconds, line_end: &str) -> String {
    let mut record = format!(
        " <{SONG_ELEMENT} {PATH_ATTRIBUTE}=\"{}\" FileSize=\"{}\">{line_end}",
        escaped(&song.path.absolute(root)),
        song.size_bytes
    );
    let tags = [
        ("Author", song.artist.clone()),
        ("Title", song.title.clone()),
        ("Genre", song.genre.clone()),
        ("Album", song.album.clone()),
        ("Bpm", song.bpm.and_then(beat_seconds).unwrap_or_default()),
        ("Key", song.key.clone()),
    ];
    record.push_str(&element_line("  ", "Tags", &tags, line_end));
    let infos = [
        (
            "SongLength",
            song.length
                .filter(|length| length.0 > 0.0)
                .map(|length| format!("{:.6}", length.0))
                .unwrap_or_default(),
        ),
        ("FirstSeen", added.0.to_string()),
    ];
    record.push_str(&element_line("  ", "Infos", &infos, line_end));
    for cue in &song.cues {
        let poi = [
            ("Name", cue.name.clone()),
            ("Pos", format!("{:.6}", cue.at.0)),
            ("Num", cue.number.0.to_string()),
            ("Type", "cue".to_owned()),
            (
                "Color",
                cue.color
                    .map(|color| color.opaque().to_string())
                    .unwrap_or_default(),
            ),
        ];
        record.push_str(&element_line("  ", "Poi", &poi, line_end));
    }
    let _ = write!(record, " </{SONG_ELEMENT}>{line_end}");
    record
}

fn new_database(records: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>{LINE_END}\
         <{ROOT_ELEMENT} Version=\"{DATABASE_VERSION}\">{LINE_END}\
         {records}</{ROOT_ELEMENT}>{LINE_END}"
    )
}

/// A drive's `database.xml` after an export.
pub struct Merged {
    pub text: String,
    /// Songs it did not list before.
    pub added: usize,
}

/// A change to the database's text: what `range` held becomes `text`.
struct Replacement {
    range: Range<usize>,
    text: String,
}

/// The whole lines a record takes up, so removing it leaves no blank line.
fn whole_lines(text: &str, record: Range<usize>) -> Range<usize> {
    let indent = text[..record.start].trim_end_matches([' ', '\t']).len();
    let start = if indent == 0 || text[..indent].ends_with('\n') {
        indent
    } else {
        record.start
    };
    let after = &text[record.end..];
    let blank = after.len() - after.trim_start_matches([' ', '\t']).len();
    let rest = &after[blank..];
    let end = if let Some(stripped) = rest.strip_prefix("\r\n") {
        text.len() - stripped.len()
    } else if let Some(stripped) = rest.strip_prefix('\n') {
        text.len() - stripped.len()
    } else {
        record.end
    };
    start..end
}

/// `database.xml` with `songs` added to what `existing` holds and `deleted` taken out. Records
/// `VirtualDJ` wrote are kept as they are, so its analysis, cues and play counts stay; only the
/// path of a song is rewritten, to where the drive is now.
pub fn merge_database(
    existing: Option<&str>,
    songs: &[Song],
    deleted: &[VirtualDjPath],
    root: &DriveRoot,
    now: UnixSeconds,
) -> Result<Merged, String> {
    let deleted: HashSet<String> = deleted.iter().map(VirtualDjPath::same_file_key).collect();
    let mut held = HashSet::new();
    let mut replacements = Vec::new();
    // Where new songs go: just before the database's closing tag.
    let mut insert_at = None;
    let existing = existing.map(|text| text.trim_start_matches('\u{feff}'));
    if let Some(text) = existing {
        let document = roxmltree::Document::parse(text).map_err(|e| e.to_string())?;
        let database = document.root_element();
        if database.tag_name().name() != ROOT_ELEMENT {
            return Err(format!("it holds no <{ROOT_ELEMENT}>"));
        }
        for song in database
            .children()
            .filter(|node| node.is_element() && node.tag_name().name() == SONG_ELEMENT)
        {
            let Some(attribute) = song
                .attributes()
                .find(|attribute| attribute.name() == PATH_ATTRIBUTE)
            else {
                continue;
            };
            let Some(path) = VirtualDjPath::from_file_path(attribute.value(), root) else {
                continue;
            };
            let key = path.same_file_key();
            if deleted.contains(&key) {
                replacements.push(Replacement {
                    range: whole_lines(text, song.range()),
                    text: String::new(),
                });
                continue;
            }
            held.insert(key);
            let here = path.absolute(root);
            if here != attribute.value() {
                replacements.push(Replacement {
                    range: attribute.range_value(),
                    text: escaped(&here),
                });
            }
        }
        let range = database.range();
        // A database written as one empty tag has no closing tag to add songs before, and
        // nothing to keep.
        insert_at = text[range.clone()]
            .rfind("</")
            .filter(|_| !text[range.clone()].ends_with("/>"))
            .map(|at| range.start + at);
    }

    let line_end = match existing {
        // A database with Unix line ends keeps them; one with no line ends gets VirtualDJ's.
        Some(text) if insert_at.is_some() && text.contains('\n') && !text.contains(LINE_END) => {
            "\n"
        }
        _ => LINE_END,
    };
    let mut added = 0;
    let mut records = String::new();
    for song in songs {
        if held.insert(song.path.same_file_key()) {
            records.push_str(&song_record(song, root, now, line_end));
            added += 1;
        }
    }
    let (Some(text), Some(insert_at)) = (existing, insert_at) else {
        return Ok(Merged {
            text: new_database(&records),
            added,
        });
    };
    if !records.is_empty() {
        let starts_a_line = text[..insert_at].ends_with('\n');
        replacements.push(Replacement {
            range: insert_at..insert_at,
            text: if starts_a_line {
                records
            } else {
                format!("{line_end}{records}")
            },
        });
    }
    replacements.sort_by_key(|replacement| replacement.range.start);
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    for replacement in replacements {
        out.push_str(&text[copied..replacement.range.start]);
        out.push_str(&replacement.text);
        copied = replacement.range.end;
    }
    out.push_str(&text[copied..]);
    Ok(Merged { text: out, added })
}

/// The full paths of the songs `database.xml` lists, in order.
pub fn database_songs(text: &str) -> Result<Vec<String>, String> {
    let text = text.trim_start_matches('\u{feff}');
    let document = roxmltree::Document::parse(text).map_err(|e| e.to_string())?;
    let database = document.root_element();
    if database.tag_name().name() != ROOT_ELEMENT {
        return Err(format!("it holds no <{ROOT_ELEMENT}>"));
    }
    Ok(database
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == SONG_ELEMENT)
        .filter_map(|song| song.attribute(PATH_ATTRIBUTE).map(str::to_owned))
        .collect())
}

/// The text of a list holding `tracks`, in order. `songs` gives what the list shows of a song
/// before `VirtualDJ` has looked it up, by [`VirtualDjPath::same_file_key`].
pub fn encode_list(
    tracks: &[VirtualDjPath],
    songs: &HashMap<String, &Song>,
    root: &DriveRoot,
) -> String {
    let mut out = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>{LINE_END}\
         <VirtualFolder noDuplicates=\"no\" ordered=\"yes\">{LINE_END}"
    );
    for (index, track) in tracks.iter().enumerate() {
        let song = songs.get(&track.same_file_key());
        let of_song = |text: fn(&Song) -> String| song.map(|s| text(s)).unwrap_or_default();
        let attributes = [
            ("path", track.absolute(root)),
            ("size", of_song(|s| s.size_bytes.to_string())),
            (
                "songlength",
                of_song(|s| {
                    s.length
                        .filter(|length| length.0 > 0.0)
                        .map(|length| format!("{:.1}", length.0))
                        .unwrap_or_default()
                }),
            ),
            ("artist", of_song(|s| s.artist.clone())),
            ("title", of_song(|s| s.title.clone())),
            ("idx", index.to_string()),
        ];
        out.push_str(&element_line("\t", "song", &attributes, LINE_END));
    }
    out.push_str("</VirtualFolder>");
    out.push_str(LINE_END);
    out
}

/// The full paths of the songs a list holds, in order. Only tests read them back.
#[cfg(test)]
pub fn decode_list(text: &str) -> Result<Vec<String>, String> {
    let document = roxmltree::Document::parse(text).map_err(|e| e.to_string())?;
    Ok(document
        .root_element()
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "song")
        .filter_map(|song| song.attribute("path").map(str::to_owned))
        .collect())
}

fn read_database(mount: &Path) -> io::Result<Option<String>> {
    match fs::read(mount.join(DATABASE_PATH)) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// How many songs and lists the drive's `VirtualDJ` library holds; `None` when it has none.
pub fn held(mount: &Path) -> Option<Result<(usize, usize), String>> {
    let text = match read_database(mount) {
        Ok(Some(text)) => text,
        Ok(None) => return None,
        Err(e) => return Some(Err(e.to_string())),
    };
    let lists = file_names(&mount.join(LISTS_DIR))
        .iter()
        .filter(|name| {
            !name.starts_with("._")
                && Path::new(name)
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case(LIST_EXTENSION))
        })
        .count();
    Some(database_songs(&text).map(|songs| (songs.len(), lists)))
}

/// What [`write`] did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Written {
    pub lists: usize,
    pub removed: usize,
    /// Songs added to `database.xml`.
    pub songs_added: usize,
    /// Whether a file that was replaced or removed was copied into the backup folder first.
    pub backed_up: bool,
}

/// Brings the drive's `VirtualDJ` library up to date with `update`. Every file replaced or
/// removed is first copied into `backup`. An unreadable `database.xml` is left alone, with
/// nothing written.
pub fn write(mount: &Path, update: &Update, backup: &Path) -> io::Result<Written> {
    let unreadable = |e: String| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "VirtualDJ's database.xml on the drive could not be read, so it was left alone: {e}"
            ),
        )
    };
    let mut written = Written::default();
    let existing = read_database(mount).map_err(|e| match e.kind() {
        io::ErrorKind::InvalidData => unreadable(e.to_string()),
        _ => e,
    })?;
    let merged = merge_database(
        existing.as_deref(),
        update.songs,
        update.deleted,
        update.root,
        update.now,
    )
    .map_err(unreadable)?;
    written.songs_added = merged.added;
    let database = mount.join(DATABASE_PATH);
    written.backed_up |= replace(mount, &database, merged.text.as_bytes(), backup)?;

    let songs: HashMap<String, &Song> = update
        .songs
        .iter()
        .map(|song| (song.path.same_file_key(), song))
        .collect();
    let dir = mount.join(LISTS_DIR);
    for list in update.lists {
        let path = dir.join(file_name(&list.name));
        let text = encode_list(&list.tracks, &songs, update.root);
        written.backed_up |= replace(mount, &path, text.as_bytes(), backup)?;
        written.lists += 1;
    }
    let kept: HashSet<String> = update.lists.iter().map(|l| file_name(&l.name)).collect();
    for name in update.remove_lists {
        let file = file_name(name);
        let path = dir.join(&file);
        if kept.contains(&file) || !path.is_file() {
            continue;
        }
        written.backed_up |= back_up(mount, &path, backup)?;
        fs::remove_file(&path)?;
        remove_apple_double(&path);
        written.removed += 1;
    }
    Ok(written)
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;
    use std::path::PathBuf;

    const NOW: UnixSeconds = UnixSeconds(1_795_000_000);

    fn windows() -> DriveRoot {
        DriveRoot::of_mount_text("E:\\")
    }

    fn mac() -> DriveRoot {
        DriveRoot::of_mount_text("/Volumes/STICK")
    }

    fn dir(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("manplay-virtualdj-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).expect("temp dir");
        d
    }

    fn paths(list: &[&str]) -> Vec<VirtualDjPath> {
        list.iter()
            .map(|p| VirtualDjPath::from_drive_path(p))
            .collect()
    }

    fn song(path: &str) -> Song {
        Song {
            path: VirtualDjPath::from_drive_path(path),
            size_bytes: 1234,
            title: "Title".into(),
            artist: "Artist".into(),
            album: String::new(),
            genre: String::new(),
            bpm: Some(BeatsPerMinute(128.0)),
            key: "Am".into(),
            length: Some(Seconds(191.295)),
            cues: Vec::new(),
        }
    }

    fn cue(slot: Option<u8>, start: f64, name: &str, color: &str) -> Cue {
        Cue {
            slot,
            start,
            name: name.into(),
            color: color.into(),
            main: false,
        }
    }

    #[test]
    fn a_drive_is_named_as_its_computer_names_it() {
        let cases = [
            ("E:\\", "E:\\"),
            ("E:", "E:\\"),
            ("e:/", "e:\\"),
            ("/Volumes/STICK", "/Volumes/STICK/"),
            ("/Volumes/My Stick/", "/Volumes/My Stick/"),
        ];
        for (mount, expected) in cases {
            assert_eq!(DriveRoot::of_mount_text(mount).0, expected, "{mount}");
        }
    }

    #[test]
    fn full_paths_use_the_drives_separator() {
        let path = VirtualDjPath::from_drive_path("/Contents/Burial/Untrue/01 Archangel.mp3");
        assert_eq!(
            path.absolute(&windows()),
            "E:\\Contents\\Burial\\Untrue\\01 Archangel.mp3"
        );
        assert_eq!(
            path.absolute(&mac()),
            "/Volumes/STICK/Contents/Burial/Untrue/01 Archangel.mp3"
        );
    }

    #[test]
    fn a_databases_paths_are_read_wherever_the_drive_was() {
        let cases = [
            ("E:\\Contents\\a.mp3", Some("Contents/a.mp3")),
            ("e:\\Contents\\a.mp3", Some("Contents/a.mp3")),
            ("F:\\Contents\\a.mp3", Some("Contents/a.mp3")),
            ("D:/Contents/a.mp3", Some("Contents/a.mp3")),
            ("/Volumes/OTHER/Contents/a.mp3", Some("Contents/a.mp3")),
            ("netsearch://dz15194531", None),
            ("a.mp3", None),
            ("/Volumes/STICK", None),
        ];
        for (file_path, expected) in cases {
            assert_eq!(
                VirtualDjPath::from_file_path(file_path, &windows()).map(|p| p.0),
                expected.map(str::to_owned),
                "{file_path}"
            );
        }
        assert_eq!(
            VirtualDjPath::from_file_path(
                "/tmp/usb/Contents/a.mp3",
                &DriveRoot::of_mount_text("/tmp/usb")
            )
            .map(|p| p.0),
            Some("Contents/a.mp3".to_owned())
        );
    }

    #[test]
    fn file_names_are_safe() {
        let cases = [
            ("Warm up", "Warm up.vdjfolder"),
            ("AC/DC: Live?", "AC_DC_ Live_.vdjfolder"),
            ("  ", "Playlist.vdjfolder"),
        ];
        for (name, expected) in cases {
            assert_eq!(file_name(name), expected, "{name}");
        }
    }

    #[test]
    fn attribute_values_are_escaped() {
        let cases = [
            ("R&B/Soul", "R&amp;B/Soul"),
            ("\"Heroes\" <live>", "&quot;Heroes&quot; &lt;live&gt;"),
            ("a\tb\nc", "a&#9;b&#10;c"),
            ("bell\u{7}", "bell"),
            ("Ä – ö", "Ä – ö"),
        ];
        for (text, expected) in cases {
            assert_eq!(escaped(text), expected, "{text}");
        }
    }

    #[test]
    fn colours_are_stored_opaque() {
        let cases = [
            ("#ff0000", Some(4_294_901_760)),
            ("#00FF00", Some(0xFF00_FF00)),
            ("", None),
            ("ff0000", None),
            ("#ff00", None),
            ("#gg0000", None),
        ];
        for (text, expected) in cases {
            assert_eq!(Rgb::from_hex(text).map(Rgb::opaque), expected, "{text}");
        }
    }

    #[test]
    fn hot_cues_keep_their_pad_and_memory_cues_take_the_free_numbers() {
        let cues = [
            cue(Some(2), 30.0, "Drop", "#ff0000"),
            cue(None, 60.0, "", ""),
            cue(Some(0), 10.0, "", ""),
            cue(None, 5.0, "Intro", ""),
            cue(Some(2), 99.0, "Second on the same pad", ""),
        ];
        let numbered: Vec<(u8, f64)> = cue_points(&cues)
            .iter()
            .map(|p| (p.number.0, p.at.0))
            .collect();
        assert_eq!(numbered, [(1, 10.0), (2, 5.0), (3, 30.0), (4, 60.0)]);
        let points = cue_points(&cues);
        assert_eq!(points[2].name, "Drop");
        assert_eq!(points[2].color.map(Rgb::opaque), Some(4_294_901_760));
        assert_eq!(points[1].name, "Intro");
        assert_eq!(cue_points(&[]), Vec::new());
    }

    #[test]
    fn a_new_database_is_laid_out_as_virtualdj_writes_one() {
        let mut with_cues = song("/Contents/R&B/a.mp3");
        with_cues.cues = cue_points(&[
            cue(Some(0), 12.5, "Drop", "#ff0000"),
            cue(None, 1.0, "", ""),
        ]);
        let text = merge_database(None, &[with_cues], &[], &windows(), NOW)
            .expect("builds")
            .text;
        let expected = [
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
            "<VirtualDJ_Database Version=\"8.4\">",
            " <Song FilePath=\"E:\\Contents\\R&amp;B\\a.mp3\" FileSize=\"1234\">",
            "  <Tags Author=\"Artist\" Title=\"Title\" Bpm=\"0.468750\" Key=\"Am\" />",
            "  <Infos SongLength=\"191.295000\" FirstSeen=\"1795000000\" />",
            "  <Poi Name=\"Drop\" Pos=\"12.500000\" Num=\"1\" Type=\"cue\" Color=\"4294901760\" />",
            "  <Poi Pos=\"1.000000\" Num=\"2\" Type=\"cue\" />",
            " </Song>",
            "</VirtualDJ_Database>",
            "",
        ]
        .join("\r\n");
        assert_eq!(text, expected);
    }

    #[test]
    fn a_new_database_lists_each_song_once() {
        let songs = [
            song("/Contents/a.mp3"),
            song("/Contents/B.MP3"),
            song("/contents/A.mp3"),
        ];
        let merged = merge_database(None, &songs, &[], &mac(), NOW).expect("builds");
        assert_eq!(merged.added, 2);
        assert_eq!(
            database_songs(&merged.text).expect("reads"),
            [
                "/Volumes/STICK/Contents/a.mp3",
                "/Volumes/STICK/Contents/B.MP3"
            ]
        );
    }

    #[test]
    fn unknown_tempo_and_length_are_left_out() {
        let bare = Song {
            bpm: Some(BeatsPerMinute(0.0)),
            key: String::new(),
            length: None,
            ..song("/Contents/a.mp3")
        };
        let text = merge_database(None, &[bare], &[], &windows(), NOW)
            .expect("builds")
            .text;
        assert!(text.contains("  <Tags Author=\"Artist\" Title=\"Title\" />\r\n"));
        assert!(text.contains("  <Infos FirstSeen=\"1795000000\" />\r\n"));
    }

    const VIRTUALDJ_WROTE: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n\
<VirtualDJ_Database Version=\"2024\">\r\n \
<Song FilePath=\"F:\\Contents\\kept.mp3\" FileSize=\"10\" Flag=\"2\">\r\n  \
<Tags Author=\"A\" Title=\"Kept &amp; loved\" Flag=\"1\" />\r\n  \
<Scan Version=\"801\" Bpm=\"0.500000\" Volume=\"1.059292\" Key=\"A#\" Flag=\"32768\" />\r\n  \
<Poi Name=\"Cue 1\" Pos=\"179.661179\" Num=\"1\" />\r\n \
</Song>\r\n \
<Song FilePath=\"F:\\Contents\\gone.mp3\" FileSize=\"20\">\r\n  \
<Tags Author=\"B\" />\r\n \
</Song>\r\n \
<Song FilePath=\"netsearch://dz1\" Flag=\"257\" />\r\n\
</VirtualDJ_Database>\r\n";

    #[test]
    fn merging_keeps_virtualdjs_records_and_drops_deleted_songs() {
        let merged = merge_database(
            Some(VIRTUALDJ_WROTE),
            &[song("/Contents/KEPT.mp3"), song("/Contents/new.mp3")],
            &paths(&["/Contents/Gone.mp3"]),
            &windows(),
            NOW,
        )
        .expect("merges");
        assert_eq!(merged.added, 1);
        assert_eq!(
            database_songs(&merged.text).expect("reads"),
            [
                "E:\\Contents\\kept.mp3",
                "netsearch://dz1",
                "E:\\Contents\\new.mp3"
            ]
        );
        // Only the drive letter of the record VirtualDJ wrote changed.
        let kept = VIRTUALDJ_WROTE
            .split(" <Song FilePath=\"F:\\Contents\\gone.mp3\"")
            .next()
            .expect("start")
            .replace("F:\\Contents\\kept.mp3", "E:\\Contents\\kept.mp3");
        assert!(merged.text.starts_with(&kept), "{}", merged.text);
        assert!(
            merged
                .text
                .ends_with(" </Song>\r\n</VirtualDJ_Database>\r\n")
        );
        assert!(!merged.text.contains("\r\n\r\n"));
        assert!(!merged.text.contains("gone.mp3"));
    }

    #[test]
    fn merging_the_same_songs_again_changes_nothing() {
        let songs = [song("/Contents/a.mp3"), song("/Contents/b.mp3")];
        let first = merge_database(None, &songs, &[], &mac(), NOW)
            .expect("builds")
            .text;
        let again = merge_database(Some(&first), &songs, &[], &mac(), UnixSeconds(NOW.0 + 60))
            .expect("merges");
        assert_eq!((again.added, again.text.as_str()), (0, first.as_str()));
        // Moved to a PC, every path follows the drive.
        let moved = merge_database(Some(&first), &songs, &[], &windows(), NOW)
            .expect("merges")
            .text;
        assert_eq!(
            database_songs(&moved).expect("reads"),
            ["E:\\Contents\\a.mp3", "E:\\Contents\\b.mp3"]
        );
    }

    #[test]
    fn databases_in_other_shapes_still_take_songs() {
        let cases = [
            ("\u{feff}<VirtualDJ_Database Version=\"8.4\"/>", "\r\n"),
            (
                "<VirtualDJ_Database Version=\"8.4\"></VirtualDJ_Database>",
                "\r\n",
            ),
            (
                "<VirtualDJ_Database Version=\"8.4\">\n</VirtualDJ_Database>\n",
                "\n",
            ),
        ];
        for (existing, line_end) in cases {
            let merged = merge_database(
                Some(existing),
                &[song("/Contents/a.mp3")],
                &[],
                &windows(),
                NOW,
            )
            .expect("merges");
            assert_eq!(merged.added, 1, "{existing}");
            assert_eq!(
                database_songs(&merged.text).expect("reads"),
                ["E:\\Contents\\a.mp3"],
                "{existing}"
            );
            assert!(
                merged
                    .text
                    .contains(&format!(" </Song>{line_end}</VirtualDJ_Database>")),
                "{existing}: {}",
                merged.text
            );
        }
    }

    #[test]
    fn broken_databases_are_errors() {
        let cases = [
            "",
            "not xml",
            "<VirtualDJ_Database Version=\"8.4\"><Song FilePath=\"E:\\a.mp3\"></VirtualDJ_Database>",
            "<DJ_PLAYLISTS Version=\"1.0.0\"></DJ_PLAYLISTS>",
        ];
        for text in cases {
            assert!(
                merge_database(Some(text), &[], &[], &windows(), NOW).is_err(),
                "{text}"
            );
            assert!(database_songs(text).is_err(), "{text}");
        }
    }

    #[test]
    fn a_list_holds_its_songs_in_order() {
        let known = song("/Contents/B/b.mp3");
        let songs = HashMap::from([(known.path.same_file_key(), &known)]);
        let tracks = paths(&["/Contents/B/B.mp3", "/Contents/Ä/ö & 1.flac"]);
        let text = encode_list(&tracks, &songs, &windows());
        let expected = [
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
            "<VirtualFolder noDuplicates=\"no\" ordered=\"yes\">",
            "\t<song path=\"E:\\Contents\\B\\B.mp3\" size=\"1234\" songlength=\"191.3\" artist=\"Artist\" title=\"Title\" idx=\"0\" />",
            "\t<song path=\"E:\\Contents\\Ä\\ö &amp; 1.flac\" idx=\"1\" />",
            "</VirtualFolder>",
            "",
        ]
        .join("\r\n");
        assert_eq!(text, expected);
        assert_eq!(
            decode_list(&text).expect("decodes"),
            ["E:\\Contents\\B\\B.mp3", "E:\\Contents\\Ä\\ö & 1.flac"]
        );
        let empty = encode_list(&[], &songs, &windows());
        assert_eq!(decode_list(&empty).expect("empty"), Vec::<String>::new());
    }

    fn update<'a>(
        lists: &'a [List],
        songs: &'a [Song],
        remove: &'a [String],
        root: &'a DriveRoot,
    ) -> Update<'a> {
        Update {
            lists,
            songs,
            remove_lists: remove,
            deleted: &[],
            root,
            now: NOW,
        }
    }

    #[test]
    fn writes_the_library_and_removes_lists_keeping_copies() {
        let usb = dir("usb");
        let root = DriveRoot::of_mount(&usb);
        let backup = usb.join("PIONEER/manplay-backup/2026-11-21-120000");
        let songs = [song("/Contents/a.mp3"), song("/Contents/b.mp3")];
        let warm = List {
            name: "Warm up".into(),
            tracks: paths(&["/Contents/a.mp3"]),
        };
        let old = List {
            name: "Old".into(),
            tracks: paths(&["/Contents/b.mp3"]),
        };
        let lists_dir = usb.join(LISTS_DIR);
        fs::create_dir_all(&lists_dir).expect("dir");
        fs::write(lists_dir.join("._Warm up.vdjfolder"), b"xattrs").expect("sidecar");
        assert!(held(&usb).is_none());

        let both = [warm.clone(), old];
        let first = write(&usb, &update(&both, &songs, &[], &root), &backup).expect("writes");
        assert_eq!(
            first,
            Written {
                lists: 2,
                removed: 0,
                songs_added: 2,
                backed_up: false
            }
        );
        assert!(!lists_dir.join("._Warm up.vdjfolder").exists());
        assert_eq!(held(&usb), Some(Ok((2, 2))));

        let one = [warm.clone()];
        let same = write(&usb, &update(&one, &songs, &[], &root), &backup).expect("again");
        assert_eq!((same.songs_added, same.backed_up), (0, false));

        let changed = [List {
            tracks: paths(&["/Contents/a.mp3", "/Contents/c.mp3"]),
            ..warm
        }];
        let more = [song("/Contents/a.mp3"), song("/Contents/c.mp3")];
        let names = [
            "Old".to_owned(),
            "Never there".to_owned(),
            "Warm up".to_owned(),
        ];
        let second =
            write(&usb, &update(&changed, &more, &names, &root), &backup).expect("rewrites");
        assert_eq!(
            second,
            Written {
                lists: 1,
                removed: 1,
                songs_added: 1,
                backed_up: true
            }
        );

        let read = |path: PathBuf| fs::read_to_string(path).expect("list");
        let on_drive = decode_list(&read(lists_dir.join("Warm up.vdjfolder"))).expect("decodes");
        let expected: Vec<String> = changed[0]
            .tracks
            .iter()
            .map(|t| t.absolute(&root))
            .collect();
        assert_eq!(on_drive, expected);
        assert!(!lists_dir.join("Old.vdjfolder").exists());
        let kept = backup.join(LISTS_DIR);
        assert_eq!(
            decode_list(&read(kept.join("Warm up.vdjfolder"))).expect("decodes"),
            [VirtualDjPath::from_drive_path("/Contents/a.mp3").absolute(&root)]
        );
        assert!(kept.join("Old.vdjfolder").is_file());
        assert!(backup.join(DATABASE_PATH).is_file());
        assert_eq!(held(&usb), Some(Ok((3, 1))));
    }

    #[test]
    fn leaves_an_unreadable_database_alone() {
        let usb = dir("broken");
        let root = DriveRoot::of_mount(&usb);
        let database = usb.join(DATABASE_PATH);
        fs::create_dir_all(database.parent().expect("parent")).expect("dir");
        let lists = [List {
            name: "Warm up".into(),
            tracks: Vec::new(),
        }];
        let broken: [&[u8]; 2] = [b"<VirtualDJ_Database", &[0xff, 0xfe, 0x00]];
        for bytes in broken {
            fs::write(&database, bytes).expect("broken");
            let error = write(&usb, &update(&lists, &[], &[], &root), &usb.join("backup"));
            assert_eq!(
                error.expect_err("refuses").kind(),
                io::ErrorKind::InvalidData
            );
            assert_eq!(fs::read(&database).expect("still there"), bytes);
            assert!(!usb.join(LISTS_DIR).join("Warm up.vdjfolder").exists());
            assert!(matches!(held(&usb), Some(Err(_))));
        }
    }
}
