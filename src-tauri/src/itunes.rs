//! iTunes → library import: finds `.m4a` files in the iTunes folder that the library does not
//! have yet, converts them to 320 kbps MP3 with ffmpeg and files them under
//! `library/artist/album/`. The iTunes folder is only ever read.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use lofty::file::TaggedFileExt;
use lofty::prelude::Accessor;
use lofty::read_from_path;
use lofty::tag::ItemKey;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::error::Error;

/// Top-level iTunes folders that hold things other than music.
const NON_MUSIC_DIRS: &[&str] = &[
    "podcasts",
    "audiobooks",
    "books",
    "voice memos",
    "tones",
    "ringtones",
    "mobile applications",
    "movies",
    "tv shows",
];

#[derive(Debug, Clone)]
pub struct Candidate {
    pub path: PathBuf,
    pub size: i64,
    pub artist: String,
    pub album_artist: Option<String>,
    pub album: String,
    pub title: String,
    pub track: Option<u32>,
    pub disc: Option<u32>,
    pub disc_total: Option<u32>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Converted {
    pub artist: String,
    pub album: String,
    pub title: String,
    pub dest: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub file: String,
    pub error: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub ran_at: i64,
    pub converted: Vec<Converted>,
    /// Songs skipped because the library has them or they were imported before.
    pub skipped: usize,
    pub failed: Vec<Failure>,
    /// Set when the run could not start (no ffmpeg, unreadable folder).
    pub error: Option<String>,
}

pub fn normalize(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn song_key(artist: &str, title: &str) -> String {
    format!("{}\u{1}{}", normalize(artist), normalize(title))
}

/// Makes `name` safe as a single path component on macOS, Windows and Linux.
pub fn sanitize(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed: String = cleaned
        .trim()
        .trim_start_matches('.')
        .trim_end_matches(['.', ' '])
        .chars()
        .take(120)
        .collect();
    let trimmed = trimmed.trim_end_matches(['.', ' ']).to_owned();
    if trimmed.is_empty() {
        fallback.to_owned()
    } else {
        trimmed
    }
}

/// Library file name: `NN Title.mp3`, `D-NN Title.mp3` on multi-disc releases, or `Title.mp3`.
pub fn file_name(c: &Candidate) -> String {
    let title = sanitize(&c.title, "Untitled");
    let multi_disc = c.disc_total.is_some_and(|t| t > 1);
    match (c.track, c.disc) {
        (Some(t), Some(d)) if multi_disc => format!("{d}-{t:02} {title}.mp3"),
        (Some(t), _) => format!("{t:02} {title}.mp3"),
        _ => format!("{title}.mp3"),
    }
}

/// Folder for the track's artist: album artist when tagged (keeps compilations together).
pub fn artist_folder(c: &Candidate) -> String {
    let name = c
        .album_artist
        .as_deref()
        .filter(|a| !a.trim().is_empty())
        .unwrap_or(&c.artist);
    sanitize(name, "Unknown Artist")
}

/// Reuses an existing directory that differs only in letter case, otherwise names a new one.
fn resolve_dir(parent: &Path, name: &str) -> PathBuf {
    // Look names up instead of testing `join(name).is_dir()`: macOS volumes are
    // case-insensitive, so that would accept a wrongly-cased name as-is.
    let wanted = name.to_lowercase();
    let mut found: Option<std::ffi::OsString> = None;
    for entry in std::fs::read_dir(parent).into_iter().flatten().flatten() {
        let existing = entry.file_name();
        if !entry.path().is_dir() || existing.to_string_lossy().to_lowercase() != wanted {
            continue;
        }
        if existing.to_string_lossy() == name {
            return parent.join(existing);
        }
        found.get_or_insert(existing);
    }
    parent.join(found.as_deref().unwrap_or(name.as_ref()))
}

/// Where `c` belongs in the library (directories are not created here).
pub fn destination(root: &Path, c: &Candidate) -> PathBuf {
    let artist_dir = resolve_dir(root, &artist_folder(c));
    let album_dir = resolve_dir(&artist_dir, &sanitize(&c.album, "Unknown Album"));
    album_dir.join(file_name(c))
}

fn read_candidate(root: &Path, path: &Path) -> Option<Candidate> {
    let size = i64::try_from(std::fs::metadata(path).ok()?.len()).ok()?;
    let tagged = read_from_path(path).ok()?;
    let tag = tagged.primary_tag();
    let text = |get: fn(&lofty::tag::Tag) -> Option<std::borrow::Cow<'_, str>>| {
        tag.and_then(get)
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
    };
    let stem = path.file_stem()?.to_str()?.to_owned();
    let folders = crate::scan::folder_names(root, path);
    Some(Candidate {
        path: path.to_owned(),
        size,
        // Folders name the artist and album; tags are only a fallback for loose files.
        artist: folders
            .as_ref()
            .map(|f| f.0.clone())
            .or_else(|| text(Accessor::artist))
            .unwrap_or_else(|| "Unknown Artist".to_owned()),
        album_artist: if folders.is_some() {
            None
        } else {
            tag.and_then(|t| t.get_string(ItemKey::AlbumArtist))
                .map(|s| s.trim().to_owned())
        },
        album: folders
            .as_ref()
            .map(|f| f.1.clone())
            .or_else(|| text(Accessor::album))
            .unwrap_or_else(|| "Unknown Album".to_owned()),
        title: text(Accessor::title).unwrap_or(stem),
        track: tag.and_then(Accessor::track),
        disc: tag.and_then(Accessor::disk),
        disc_total: tag.and_then(Accessor::disk_total),
    })
}

fn is_m4a(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("m4a"))
}

fn skipped_dir(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .and_then(|rel| rel.iter().next())
        .and_then(|first| first.to_str())
        .is_some_and(|first| NON_MUSIC_DIRS.contains(&first.to_lowercase().as_str()))
}

/// Every `.m4a` music file under `root` (read-only walk).
pub fn find_m4a(root: &Path) -> Vec<PathBuf> {
    WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && is_m4a(e.path()))
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter(|e| !skipped_dir(root, e.path()))
        .map(walkdir::DirEntry::into_path)
        .collect()
}

pub struct Known {
    songs: HashSet<String>,
    imported: HashSet<(String, i64)>,
}

impl Known {
    pub fn load(conn: &Connection) -> Result<Self, Error> {
        let mut songs = HashSet::new();
        // Folder names carry the (album) artist, so match on that and on the file's own title.
        let mut stmt =
            conn.prepare("SELECT artist, title FROM tracks WHERE missing_since IS NULL")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (artist, title) = row?;
            songs.insert(song_key(&artist, &title));
        }
        let mut stmt = conn.prepare("SELECT source, size FROM itunes_imported")?;
        let imported = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
            .collect::<Result<HashSet<_>, _>>()?;
        Ok(Self { songs, imported })
    }

    fn already_imported(&self, c: &Candidate) -> bool {
        c.path
            .to_str()
            .is_some_and(|p| self.imported.contains(&(p.to_owned(), c.size)))
    }

    fn in_library(&self, c: &Candidate) -> bool {
        self.songs.contains(&song_key(&c.artist, &c.title))
            || c.album_artist
                .as_deref()
                .is_some_and(|aa| self.songs.contains(&song_key(aa, &c.title)))
    }

    fn add(&mut self, c: &Candidate) {
        self.songs.insert(song_key(&c.artist, &c.title));
    }
}

pub fn record_imported(
    conn: &Connection,
    c: &Candidate,
    dest: &Path,
    now: i64,
) -> Result<(), Error> {
    conn.execute(
        "INSERT OR REPLACE INTO itunes_imported (source, size, dest, imported_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            c.path.to_string_lossy(),
            c.size,
            dest.to_string_lossy(),
            now
        ],
    )?;
    Ok(())
}

/// Finds ffmpeg even when the app was launched from Finder (which has a minimal PATH).
pub fn find_ffmpeg() -> Option<PathBuf> {
    let fixed = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
        "/usr/bin",
    ];
    let from_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
    fixed
        .iter()
        .map(PathBuf::from)
        .chain(from_path)
        .map(|d| d.join("ffmpeg"))
        .find(|p| p.is_file())
}

/// Arguments for a highest-quality (320 kbps CBR) MP3 with tags and cover art carried over.
pub fn ffmpeg_args(src: &Path, out: &Path) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = Vec::new();
    let mut push = |s: &str| args.push(s.into());
    for a in ["-nostdin", "-y", "-v", "error", "-i"] {
        push(a);
    }
    args.push(src.into());
    let mut push = |s: &str| args.push(s.into());
    for a in [
        "-map",
        "0:a:0",
        "-map",
        "0:v:0?",
        "-map_metadata",
        "0",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "320k",
        "-c:v",
        "copy",
        "-id3v2_version",
        "3",
        "-write_id3v1",
        "1",
        "-f",
        "mp3",
    ] {
        push(a);
    }
    args.push(out.into());
    args
}

fn convert(ffmpeg: &Path, c: &Candidate, dest: &Path) -> Result<(), String> {
    let dir = dest.parent().ok_or("no destination folder")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(".manplay-{}.tmp", std::process::id()));
    let out = Command::new(ffmpeg)
        .args(ffmpeg_args(&c.path, &tmp))
        .output()
        .map_err(|e| format!("could not run ffmpeg: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        let msg = String::from_utf8_lossy(&out.stderr);
        let last = msg.lines().rev().find(|l| !l.trim().is_empty());
        return Err(last.unwrap_or("ffmpeg failed").trim().to_owned());
    }
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("save {}: {e}", dest.display())
    })
}

/// Converts every new song under `source` into `library`. `record` is called after each file
/// is safely in the library so a crash never loses track of what was imported.
pub fn import(
    source: &Path,
    library: &Path,
    mut known: Known,
    now: i64,
    mut record: impl FnMut(&Candidate, &Path) -> Result<(), Error>,
) -> ImportReport {
    let mut report = ImportReport {
        ran_at: now,
        ..ImportReport::default()
    };
    if !source.is_dir() {
        report.error = Some(format!("iTunes folder not found: {}", source.display()));
        return report;
    }
    if !library.is_dir() {
        report.error = Some(format!("library folder not found: {}", library.display()));
        return report;
    }
    let files = find_m4a(source);
    let mut pending = Vec::new();
    for path in files {
        let Some(c) = read_candidate(source, &path) else {
            report.failed.push(Failure {
                file: path.display().to_string(),
                error: "could not read tags".to_owned(),
            });
            continue;
        };
        if known.already_imported(&c) || known.in_library(&c) {
            report.skipped += 1;
        } else {
            known.add(&c);
            pending.push(c);
        }
    }
    if pending.is_empty() {
        return report;
    }
    let Some(ffmpeg) = find_ffmpeg() else {
        report.error = Some("ffmpeg not found. Install it with: brew install ffmpeg".to_owned());
        return report;
    };
    for c in pending {
        let dest = destination(library, &c);
        if dest.exists() {
            // Something already sits at this name; never overwrite library files.
            report.skipped += 1;
            let _ = record(&c, &dest);
            continue;
        }
        match convert(&ffmpeg, &c, &dest) {
            Ok(()) => {
                if let Err(e) = record(&c, &dest) {
                    report.failed.push(Failure {
                        file: c.path.display().to_string(),
                        error: format!("converted but not recorded: {e}"),
                    });
                }
                report.converted.push(Converted {
                    artist: c.artist,
                    album: c.album,
                    title: c.title,
                    dest: dest.display().to_string(),
                });
            }
            Err(error) => report.failed.push(Failure {
                file: c.path.display().to_string(),
                error,
            }),
        }
    }
    report
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;
    use lofty::file::AudioFile;

    fn cand(artist: &str, album: &str, title: &str) -> Candidate {
        Candidate {
            path: PathBuf::from("/itunes/x.m4a"),
            size: 10,
            artist: artist.into(),
            album_artist: None,
            album: album.into(),
            title: title.into(),
            track: Some(3),
            disc: Some(1),
            disc_total: Some(1),
        }
    }

    #[test]
    fn sanitize_replaces_path_characters_and_trims() {
        assert_eq!(sanitize("AC/DC", "x"), "AC_DC");
        assert_eq!(sanitize("What?: Why", "x"), "What__ Why");
        assert_eq!(sanitize("..hidden.", "x"), "hidden");
        assert_eq!(sanitize("  ", "Unknown"), "Unknown");
    }

    #[test]
    fn file_names_carry_track_and_disc_numbers() {
        let mut c = cand("A", "B", "Song");
        assert_eq!(file_name(&c), "03 Song.mp3");
        c.disc = Some(2);
        c.disc_total = Some(2);
        assert_eq!(file_name(&c), "2-03 Song.mp3");
        c.track = None;
        assert_eq!(file_name(&c), "Song.mp3");
    }

    #[test]
    fn album_artist_wins_for_the_artist_folder() {
        let mut c = cand("Artist feat. Guest", "B", "Song");
        assert_eq!(artist_folder(&c), "Artist feat. Guest");
        c.album_artist = Some("Artist".into());
        assert_eq!(artist_folder(&c), "Artist");
    }

    #[test]
    fn destination_reuses_existing_folders_ignoring_case() {
        let root = std::env::temp_dir().join(format!("manplay-itunes-dest-{}", std::process::id()));
        std::fs::create_dir_all(root.join("Daft Punk").join("Discovery")).unwrap();
        let c = cand("daft punk", "discovery", "One More Time");
        let dest = destination(&root, &c);
        assert_eq!(
            dest,
            root.join("Daft Punk")
                .join("Discovery")
                .join("03 One More Time.mp3")
        );
        let fresh = destination(&root, &cand("New", "Album", "T"));
        assert_eq!(fresh, root.join("New").join("Album").join("03 T.mp3"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn known_songs_match_on_artist_or_album_artist() {
        let conn = crate::db::open(Path::new(":memory:")).unwrap();
        conn.execute(
            "INSERT INTO tracks (path, artist, album, title, size) VALUES ('/l/a.mp3','Artist','Alb','Song  One',1)",
            [],
        )
        .unwrap();
        let known = Known::load(&conn).unwrap();
        assert!(known.in_library(&cand("artist", "x", "song one")));
        let mut c = cand("Artist feat. X", "x", "Song One");
        assert!(!known.in_library(&c));
        c.album_artist = Some("Artist".into());
        assert!(known.in_library(&c));
        assert!(!known.in_library(&cand("Artist", "x", "Other")));
    }

    #[test]
    fn non_music_folders_and_hidden_files_are_skipped() {
        let root = std::env::temp_dir().join(format!("manplay-itunes-find-{}", std::process::id()));
        for d in ["Music/A/B", "Podcasts/Show"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        for f in [
            "Music/A/B/s.m4a",
            "Podcasts/Show/e.m4a",
            "Music/A/B/._s.m4a",
            "Music/A/B/s.mp3",
        ] {
            std::fs::write(root.join(f), b"x").unwrap();
        }
        let found = find_m4a(&root);
        assert_eq!(found, vec![root.join("Music/A/B/s.m4a")]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn imports_new_m4a_once_and_leaves_the_source_alone() {
        let Some(ffmpeg) = find_ffmpeg() else { return };
        let base = std::env::temp_dir().join(format!("manplay-itunes-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src_dir = base.join("itunes/Music/Some Artist/Some Album");
        let library = base.join("library");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&library).unwrap();
        let src = src_dir.join("1 Tune.m4a");
        let made = Command::new(&ffmpeg)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
            ])
            .args([
                "-metadata",
                "artist=Some Artist",
                "-metadata",
                "album=Some Album",
            ])
            .args(["-metadata", "title=Tune", "-metadata", "track=1"])
            .arg(&src)
            .status()
            .unwrap();
        assert!(made.success());
        let before = std::fs::read(&src).unwrap();

        let conn = crate::db::open(Path::new(":memory:")).unwrap();
        let mut recorded = Vec::new();
        let report = import(
            &base.join("itunes"),
            &library,
            Known::load(&conn).unwrap(),
            1,
            |c, d| {
                recorded.push((c.clone(), d.to_path_buf()));
                Ok(())
            },
        );
        assert!(
            report.error.is_none() && report.failed.is_empty(),
            "{report:?}"
        );
        let dest = library.join("Some Artist/Some Album/01 Tune.mp3");
        assert_eq!(report.converted.len(), 1);
        assert!(dest.is_file());
        let tagged = read_from_path(&dest).unwrap();
        assert_eq!(
            tagged.primary_tag().and_then(Accessor::title).as_deref(),
            Some("Tune")
        );
        let kbps = tagged.properties().audio_bitrate().unwrap_or(0);
        assert!((300..=330).contains(&kbps), "bitrate was {kbps}");
        assert_eq!(
            std::fs::read(&src).unwrap(),
            before,
            "source must not change"
        );
        assert!(
            !std::fs::read_dir(library.join("Some Artist/Some Album"))
                .unwrap()
                .any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".tmp"))
        );

        for (c, d) in &recorded {
            record_imported(&conn, c, d, 1).unwrap();
        }
        let again = import(
            &base.join("itunes"),
            &library,
            Known::load(&conn).unwrap(),
            2,
            |_, _| Ok(()),
        );
        assert!(again.converted.is_empty());
        assert_eq!(again.skipped, 1);
        let _ = std::fs::remove_dir_all(&base);
    }
}
