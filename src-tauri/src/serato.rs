//! Serato DJ's library on a USB drive: `_Serato_/database V2`, the drive's songs, and
//! `_Serato_/Subcrates/<name>.crate`, its crates. Serato only reads a drive that has a
//! `database V2`, and (from Serato DJ 4) imports it and the crates into its own library the
//! first time it sees them. Songs are analysed by Serato when loaded.
//!
//! Both files are a run of fields, each a 4-byte ASCII tag, a big-endian `u32` length and the
//! payload. Tags starting `t` or `p` hold UTF-16BE text, `u` a big-endian `u32`, `b` one byte;
//! `o` fields (`otrk`, `ovct`) hold more fields.

use crate::usb_export::safe_name;
use crate::usb_files::{back_up, remove_apple_double, replace};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::Path;

/// Where Serato keeps a drive's crates, relative to the drive root.
pub const SUBCRATES_DIR: &str = "_Serato_/Subcrates";
/// The drive's song list, relative to the drive root.
pub const DATABASE_PATH: &str = "_Serato_/database V2";
const CRATE_EXTENSION: &str = "crate";
const CRATE_VERSION: &str = "1.0/Serato ScratchLive Crate";
const DATABASE_VERSION: &str = "2.0/Serato Scratch LIVE Database";
/// Columns a new crate opens with in Serato, with their widths, as Serato writes them.
const COLUMNS: [(&str, &str); 7] = [
    ("song", "250"),
    ("artist", "250"),
    ("bpm", "30"),
    ("key", "30"),
    ("album", "250"),
    ("length", "250"),
    ("comment", "250"),
];
/// Separates a subcrate's name from its parent's in a crate's file name.
const SUBCRATE_SEPARATOR: &str = "%%";

/// A song's path as Serato holds it on a drive: from the drive root, `/` separated, with no
/// leading `/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeratoPath(String);

impl SeratoPath {
    /// From a path on the drive as rekordbox's library holds it (`/Contents/A/B/x.mp3`).
    pub fn from_drive_path(path: &str) -> Self {
        Self(path.replace('\\', "/").trim_start_matches('/').to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// FAT and exFAT ignore case, so two paths differing only in case are one file.
    fn same_file_key(&self) -> String {
        self.0.to_lowercase()
    }
}

/// Seconds since 1970, UTC, as Serato stores when a song was added.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnixSeconds(pub u32);

/// A song for the drive's `database V2`. Serato reads the rest from the file when it loads it.
#[derive(Debug, Clone, PartialEq)]
pub struct Song {
    pub path: SeratoPath,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub bpm: Option<f64>,
}

/// One crate to put on the drive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Crate {
    /// As the playlist is named in manplay.
    pub name: String,
    pub tracks: Vec<SeratoPath>,
}

/// Everything one export changes in the drive's Serato library.
pub struct Update<'a> {
    pub crates: &'a [Crate],
    /// Every song the crates hold; ones `database V2` lacks are added to it.
    pub songs: &'a [Song],
    /// Crates of playlists the export took off the drive, by playlist name.
    pub remove_crates: &'a [String],
    /// Songs deleted from the drive, which leave `database V2`.
    pub deleted: &'a [SeratoPath],
    pub now: UnixSeconds,
}

/// The crate's file name: safe on FAT and exFAT, and never read by Serato as a subcrate.
pub fn file_name(playlist_name: &str) -> String {
    let mut name = safe_name(playlist_name, "Playlist");
    while name.contains(SUBCRATE_SEPARATOR) {
        name = name.replace(SUBCRATE_SEPARATOR, "%");
    }
    format!("{name}.{CRATE_EXTENSION}")
}

fn utf16(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_be_bytes).collect()
}

fn field(tag: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let length = u32::try_from(payload.len()).unwrap_or(u32::MAX);
    let mut out = Vec::with_capacity(8 + payload.len());
    out.extend_from_slice(&tag);
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn text_field(tag: [u8; 4], text: &str) -> Vec<u8> {
    field(tag, &utf16(text))
}

/// One field: its tag and payload.
type Field<'a> = ([u8; 4], &'a [u8]);

/// Splits a run of fields into `(tag, payload)` pairs.
fn fields(mut bytes: &[u8]) -> Result<Vec<Field<'_>>, String> {
    let mut out = Vec::new();
    while !bytes.is_empty() {
        let (Some(tag), Some(length)) = (bytes.get(..4), bytes.get(4..8)) else {
            return Err("a field is cut short".to_owned());
        };
        let mut tag_bytes = [0; 4];
        tag_bytes.copy_from_slice(tag);
        let mut length_bytes = [0; 4];
        length_bytes.copy_from_slice(length);
        let length = usize::try_from(u32::from_be_bytes(length_bytes))
            .map_err(|_| "a field is too long".to_owned())?;
        let end = 8 + length;
        let payload = bytes
            .get(8..end)
            .ok_or_else(|| "a field runs past the end of the file".to_owned())?;
        out.push((tag_bytes, payload));
        bytes = &bytes[end..];
    }
    Ok(out)
}

fn from_utf16(bytes: &[u8]) -> Result<String, String> {
    if !bytes.len().is_multiple_of(2) {
        return Err("text has an odd number of bytes".to_owned());
    }
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_be_bytes(*pair))
        .collect();
    String::from_utf16(&units).map_err(|e| e.to_string())
}

/// The bytes of a crate holding `tracks`, in order.
pub fn encode_crate(tracks: &[SeratoPath]) -> Vec<u8> {
    let mut out = text_field(*b"vrsn", CRATE_VERSION);
    for (column, width) in COLUMNS {
        let payload = [text_field(*b"tvcn", column), text_field(*b"tvcw", width)].concat();
        out.extend(field(*b"ovct", &payload));
    }
    for track in tracks {
        out.extend(field(*b"otrk", &text_field(*b"ptrk", track.as_str())));
    }
    out
}

/// The path in one `otrk` of a crate (`ptrk`) or of `database V2` (`pfil`).
fn track_path(record: &[u8], tag: [u8; 4]) -> Result<Option<SeratoPath>, String> {
    for (inner, payload) in fields(record)? {
        if inner == tag {
            return Ok(Some(SeratoPath(from_utf16(payload)?)));
        }
    }
    Ok(None)
}

/// The songs a crate holds, in order.
pub fn decode_crate(bytes: &[u8]) -> Result<Vec<SeratoPath>, String> {
    let mut tracks = Vec::new();
    for (tag, payload) in fields(bytes)? {
        if &tag == b"otrk"
            && let Some(path) = track_path(payload, *b"ptrk")?
        {
            tracks.push(path);
        }
    }
    Ok(tracks)
}

/// The `otrk` record `database V2` holds for a song new to it.
fn song_record(song: &Song, added: UnixSeconds) -> Vec<u8> {
    let path = song.path.as_str();
    let file_type = path
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_lowercase())
        .unwrap_or_default();
    let mut record = text_field(*b"ttyp", &file_type);
    record.extend(text_field(*b"pfil", path));
    for (tag, text) in [
        (*b"tsng", song.title.as_str()),
        (*b"tart", song.artist.as_str()),
        (*b"talb", song.album.as_str()),
    ] {
        if !text.is_empty() {
            record.extend(text_field(tag, text));
        }
    }
    if let Some(bpm) = song.bpm.filter(|b| *b > 0.0) {
        record.extend(text_field(*b"tbpm", &format!("{bpm:.2}")));
    }
    record.extend(text_field(*b"tadd", &added.0.to_string()));
    record.extend(field(*b"uadd", &added.0.to_be_bytes()));
    field(*b"otrk", &record)
}

/// A drive's `database V2` after an export.
pub struct Merged {
    pub bytes: Vec<u8>,
    /// Songs it did not list before.
    pub added: usize,
}

/// `database V2` with `songs` added to what `existing` holds and `deleted` taken out. Records
/// Serato wrote are kept byte for byte, so its analysis and play counts stay.
pub fn merge_database(
    existing: Option<&[u8]>,
    songs: &[Song],
    deleted: &[SeratoPath],
    now: UnixSeconds,
) -> Result<Merged, String> {
    let deleted: HashSet<String> = deleted.iter().map(SeratoPath::same_file_key).collect();
    let mut held = HashSet::new();
    let mut out = Vec::new();
    match existing {
        Some(bytes) => {
            for (tag, payload) in fields(bytes)? {
                if &tag == b"otrk"
                    && let Some(path) = track_path(payload, *b"pfil")?
                {
                    let key = path.same_file_key();
                    if deleted.contains(&key) {
                        continue;
                    }
                    held.insert(key);
                }
                out.extend(field(tag, payload));
            }
        }
        None => out.extend(text_field(*b"vrsn", DATABASE_VERSION)),
    }
    let mut added = 0;
    for song in songs {
        if held.insert(song.path.same_file_key()) {
            out.extend(song_record(song, now));
            added += 1;
        }
    }
    Ok(Merged { bytes: out, added })
}

/// The songs `database V2` lists, in order.
pub fn database_songs(bytes: &[u8]) -> Result<Vec<SeratoPath>, String> {
    let mut paths = Vec::new();
    for (tag, payload) in fields(bytes)? {
        if &tag == b"otrk"
            && let Some(path) = track_path(payload, *b"pfil")?
        {
            paths.push(path);
        }
    }
    Ok(paths)
}

/// The drive's Serato library as paths from the drive root (`/Contents/…`): its songs, and each
/// crate with its songs in order (a subcrate named with ` › ` between levels). `None` when the
/// drive has none.
pub fn contents(mount: &Path) -> Option<Result<crate::usb_browse::Contents, String>> {
    let bytes = match fs::read(mount.join(DATABASE_PATH)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return None,
        Err(e) => return Some(Err(e.to_string())),
    };
    let drive_path = |p: &SeratoPath| format!("/{}", p.as_str());
    let read = || -> Result<crate::usb_browse::Contents, String> {
        let songs = database_songs(&bytes)?.iter().map(drive_path).collect();
        let mut names = crate::usb_files::file_names(&mount.join(SUBCRATES_DIR));
        names.retain(|n| {
            !n.starts_with("._")
                && Path::new(n)
                    .extension()
                    .is_some_and(|x| x == CRATE_EXTENSION)
        });
        names.sort();
        let mut playlists = Vec::new();
        for name in names {
            let crate_bytes = fs::read(mount.join(SUBCRATES_DIR).join(&name))
                .map_err(|e| format!("{name}: {e}"))?;
            let stem = name.trim_end_matches(&format!(".{CRATE_EXTENSION}"));
            playlists.push((
                stem.replace(SUBCRATE_SEPARATOR, " › "),
                decode_crate(&crate_bytes)?.iter().map(drive_path).collect(),
            ));
        }
        Ok(crate::usb_browse::Contents { songs, playlists })
    };
    Some(read())
}

/// How many songs and crates the drive's Serato library holds; `None` when it has none.
pub fn held(mount: &Path) -> Option<Result<(usize, usize), String>> {
    let bytes = match fs::read(mount.join(DATABASE_PATH)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return None,
        Err(e) => return Some(Err(e.to_string())),
    };
    let crates = fs::read_dir(mount.join(SUBCRATES_DIR)).map_or(0, |entries| {
        entries
            .filter_map(Result::ok)
            .filter(|e| {
                let name = e.file_name();
                let name = Path::new(&name);
                name.extension().is_some_and(|x| x == CRATE_EXTENSION)
                    && !name.to_string_lossy().starts_with("._")
            })
            .count()
    });
    Some(database_songs(&bytes).map(|songs| (songs.len(), crates)))
}

/// What [`write`] did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Written {
    pub crates: usize,
    pub removed: usize,
    /// Songs added to `database V2`.
    pub songs_added: usize,
    /// Whether a file that was replaced or removed was copied into the backup folder first.
    pub backed_up: bool,
}

/// Brings the drive's Serato library up to date with `update`. Every file replaced or removed is
/// first copied into `backup`. An unreadable `database V2` is left alone, with nothing written.
pub fn write(mount: &Path, update: &Update, backup: &Path) -> io::Result<Written> {
    let mut written = Written::default();
    let database = mount.join(DATABASE_PATH);
    let existing = match fs::read(&database) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let merged = merge_database(
        existing.as_deref(),
        update.songs,
        update.deleted,
        update.now,
    )
    .map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "Serato's database V2 on the drive could not be read, so it was left alone: {e}"
            ),
        )
    })?;
    written.songs_added = merged.added;
    written.backed_up |= replace(mount, &database, &merged.bytes, backup)?;

    let dir = mount.join(SUBCRATES_DIR);
    for c in update.crates {
        let path = dir.join(file_name(&c.name));
        written.backed_up |= replace(mount, &path, &encode_crate(&c.tracks), backup)?;
        written.crates += 1;
    }
    let kept: HashSet<String> = update.crates.iter().map(|c| file_name(&c.name)).collect();
    for name in update.remove_crates {
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

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("manplay-serato-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).expect("temp dir");
        d
    }

    fn paths(list: &[&str]) -> Vec<SeratoPath> {
        list.iter()
            .map(|p| SeratoPath::from_drive_path(p))
            .collect()
    }

    fn song(path: &str) -> Song {
        Song {
            path: SeratoPath::from_drive_path(path),
            title: "Title".into(),
            artist: "Artist".into(),
            album: String::new(),
            bpm: Some(140.0),
        }
    }

    fn update<'a>(crates: &'a [Crate], songs: &'a [Song], remove: &'a [String]) -> Update<'a> {
        Update {
            crates,
            songs,
            remove_crates: remove,
            deleted: &[],
            now: NOW,
        }
    }

    #[test]
    fn file_names_are_safe_and_never_subcrates() {
        let cases = [
            ("Warm up", "Warm up.crate"),
            ("Genre › House", "Genre › House.crate"),
            ("AC/DC: Live?", "AC_DC_ Live_.crate"),
            ("100%% Vinyl", "100% Vinyl.crate"),
            ("50%%%% off", "50% off.crate"),
            ("  ", "Playlist.crate"),
        ];
        for (name, expected) in cases {
            assert_eq!(file_name(name), expected, "{name}");
        }
    }

    #[test]
    fn paths_are_from_the_drive_root() {
        let cases = [
            (
                "/Contents/Burial/Untrue/01 Archangel.mp3",
                "Contents/Burial/Untrue/01 Archangel.mp3",
            ),
            ("Contents/a.mp3", "Contents/a.mp3"),
            ("\\Contents\\A\\b.wav", "Contents/A/b.wav"),
        ];
        for (drive, expected) in cases {
            assert_eq!(
                SeratoPath::from_drive_path(drive).as_str(),
                expected,
                "{drive}"
            );
        }
    }

    #[test]
    fn a_crate_holds_its_songs_in_order() {
        let tracks = paths(&[
            "/Contents/B/b.mp3",
            "/Contents/Ä/ö – 1.flac",
            "/Contents/A/a.mp3",
        ]);
        let bytes = encode_crate(&tracks);
        assert_eq!(decode_crate(&bytes).expect("decodes"), tracks);
        assert_eq!(decode_crate(&encode_crate(&[])).expect("empty"), Vec::new());
    }

    #[test]
    fn a_crate_starts_as_serato_writes_one() {
        let bytes = encode_crate(&[]);
        let version = utf16(CRATE_VERSION);
        let length = u32::try_from(version.len()).expect("short");
        assert_eq!(&bytes[..4], b"vrsn");
        assert_eq!(&bytes[4..8], &length.to_be_bytes());
        assert_eq!(&bytes[8..8 + version.len()], version.as_slice());
        let tags: Vec<[u8; 4]> = fields(&bytes)
            .expect("fields")
            .iter()
            .map(|f| f.0)
            .collect();
        assert_eq!(tags.iter().filter(|t| *t == b"ovct").count(), COLUMNS.len());
    }

    #[test]
    fn broken_files_are_errors() {
        let good = encode_crate(&paths(&["/Contents/a.mp3"]));
        let cases: [&[u8]; 3] = [&good[..good.len() - 1], b"otr", b"otrk\0\0\0\x02\0"];
        for bytes in cases {
            assert!(decode_crate(bytes).is_err(), "{bytes:?}");
            assert!(
                merge_database(Some(bytes), &[], &[], NOW).is_err(),
                "{bytes:?}"
            );
        }
    }

    #[test]
    fn a_new_database_lists_each_song_once() {
        let songs = [
            song("/Contents/a.mp3"),
            song("/Contents/B.MP3"),
            song("/contents/A.mp3"),
        ];
        let bytes = merge_database(None, &songs, &[], NOW)
            .expect("builds")
            .bytes;
        assert!(bytes.starts_with(b"vrsn"));
        assert_eq!(
            database_songs(&bytes).expect("reads"),
            paths(&["Contents/a.mp3", "Contents/B.MP3"])
        );
        let record = fields(&bytes).expect("fields")[1].1;
        let tags: Vec<[u8; 4]> = fields(record)
            .expect("record")
            .iter()
            .map(|f| f.0)
            .collect();
        assert_eq!(
            tags,
            [
                *b"ttyp", *b"pfil", *b"tsng", *b"tart", *b"tbpm", *b"tadd", *b"uadd"
            ]
        );
    }

    #[test]
    fn merging_keeps_seratos_records_and_drops_deleted_songs() {
        let serato_record = field(
            *b"otrk",
            &[
                text_field(*b"pfil", "Contents/kept.mp3"),
                field(*b"bmis", &[0]),
                text_field(*b"tcom", "Serato wrote this"),
            ]
            .concat(),
        );
        let existing = [
            text_field(*b"vrsn", DATABASE_VERSION),
            serato_record.clone(),
            song_record(&song("/Contents/gone.mp3"), NOW),
        ]
        .concat();
        let merged = merge_database(
            Some(&existing),
            &[song("/Contents/KEPT.mp3"), song("/Contents/new.mp3")],
            &paths(&["/Contents/Gone.mp3"]),
            NOW,
        )
        .expect("merges")
        .bytes;
        assert_eq!(
            database_songs(&merged).expect("reads"),
            paths(&["Contents/kept.mp3", "Contents/new.mp3"])
        );
        let kept = fields(&merged).expect("fields")[1];
        assert_eq!(field(kept.0, kept.1), serato_record);
    }

    #[test]
    fn writes_the_library_and_removes_crates_keeping_copies() {
        let usb = dir("usb");
        let backup = usb.join("PIONEER/manplay-backup/2026-11-21-120000");
        let songs = [song("/Contents/a.mp3"), song("/Contents/b.mp3")];
        let warm = Crate {
            name: "Warm up".into(),
            tracks: paths(&["/Contents/a.mp3"]),
        };
        let old = Crate {
            name: "Old".into(),
            tracks: paths(&["/Contents/b.mp3"]),
        };
        let subcrates = usb.join(SUBCRATES_DIR);
        fs::create_dir_all(&subcrates).expect("dir");
        fs::write(subcrates.join("._Warm up.crate"), b"xattrs").expect("sidecar");

        let both = [warm.clone(), old];
        let first = write(&usb, &update(&both, &songs, &[]), &backup).expect("writes");
        assert_eq!(
            first,
            Written {
                crates: 2,
                removed: 0,
                songs_added: 2,
                backed_up: false
            }
        );
        assert!(!subcrates.join("._Warm up.crate").exists());
        let database = fs::read(usb.join(DATABASE_PATH)).expect("database V2");
        assert_eq!(database_songs(&database).expect("reads").len(), 2);

        let one = [warm.clone()];
        let same = write(&usb, &update(&one, &songs, &[]), &backup).expect("again");
        assert_eq!((same.songs_added, same.backed_up), (0, false));

        let changed = [Crate {
            tracks: paths(&["/Contents/a.mp3", "/Contents/c.mp3"]),
            ..warm
        }];
        let more = [song("/Contents/a.mp3"), song("/Contents/c.mp3")];
        let names = [
            "Old".to_owned(),
            "Never there".to_owned(),
            "Warm up".to_owned(),
        ];
        let second = write(&usb, &update(&changed, &more, &names), &backup).expect("rewrites");
        assert_eq!(
            second,
            Written {
                crates: 1,
                removed: 1,
                songs_added: 1,
                backed_up: true
            }
        );

        let on_drive = decode_crate(&fs::read(subcrates.join("Warm up.crate")).expect("crate"));
        assert_eq!(on_drive.expect("decodes"), changed[0].tracks);
        assert!(!subcrates.join("Old.crate").exists());
        let kept = backup.join(SUBCRATES_DIR);
        assert_eq!(
            decode_crate(&fs::read(kept.join("Warm up.crate")).expect("copy")).expect("decodes"),
            paths(&["/Contents/a.mp3"])
        );
        assert!(kept.join("Old.crate").is_file());
        assert!(backup.join(DATABASE_PATH).is_file());
    }

    #[test]
    fn leaves_an_unreadable_database_alone() {
        let usb = dir("broken");
        let database = usb.join(DATABASE_PATH);
        fs::create_dir_all(database.parent().expect("parent")).expect("dir");
        fs::write(&database, b"otrk\0\0\0\x09").expect("broken");
        let crates = [Crate {
            name: "Warm up".into(),
            tracks: Vec::new(),
        }];
        let error = write(&usb, &update(&crates, &[], &[]), &usb.join("backup"));
        assert_eq!(
            error.expect_err("refuses").kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(fs::read(&database).expect("still there"), b"otrk\0\0\0\x09");
        assert!(!usb.join(SUBCRATES_DIR).join("Warm up.crate").exists());
    }
}
