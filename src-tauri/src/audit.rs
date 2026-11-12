//! Library health: finds files that break the library conventions (MP3 only, ID3v2.3 tags,
//! `Artist/Album/track.mp3` layout) and fixes them. Every fix is a transaction: the new file is
//! built beside the old one, checked, swapped in, and only then is the original sent to the Trash.
//! A failure at any step puts everything back.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::read_from_path;
use lofty::tag::{Accessor, ItemKey, TagExt, TagType};
use serde::Serialize;
use walkdir::WalkDir;

use crate::error::Error;
use crate::fsops::{self, Undo};
use crate::itunes::{ffmpeg_args, sanitize};
use crate::scan::is_audio;

/// MP3 tops out at 48 kHz; high-resolution sources must be resampled to convert.
const MAX_MP3_SAMPLE_RATE: u32 = 48_000;
const TARGET_SAMPLE_RATE: &str = "44100";

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// Not an MP3 (FLAC, M4A, WAV, ...). Fix: convert.
    NotMp3,
    /// ID3v2.4 tags, which older hardware shows as garbage or ignores. Fix: rewrite as v2.3.
    TagVersion,
    /// Not at `Artist/Album/track` (a `Disc N` folder is allowed below the album).
    Misplaced,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub path: String,
    pub kind: Kind,
    pub message: String,
    pub fixable: bool,
    /// Set when the user can fix this by typing the missing artist and/or album.
    pub place: Option<PlaceForm>,
}

/// What is already known when asking the user where a file belongs.
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaceForm {
    pub artist: Option<String>,
    pub album: Option<String>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FixFailure {
    pub path: String,
    pub error: String,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FixReport {
    pub fixed: usize,
    pub failed: Vec<FixFailure>,
}

fn is_mp3(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mp3"))
}

/// Major version of the file's `ID3v2` header (3 is v2.3, 4 is v2.4); `None` without one.
fn id3v2_major(path: &Path) -> Option<u8> {
    let mut header = [0_u8; 10];
    File::open(path).ok()?.read_exact(&mut header).ok()?;
    (&header[..3] == b"ID3").then_some(header[3])
}

fn sample_rate(path: &Path) -> Option<u32> {
    read_from_path(path).ok()?.properties().sample_rate()
}

fn is_disc_folder(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower
        .strip_prefix("disc")
        .or_else(|| lower.strip_prefix("cd"))
        .map(str::trim)
        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// Where a file belongs.
#[derive(Debug, PartialEq, Eq)]
pub enum Placement {
    Ok,
    Move(PathBuf),
    /// Misplaced, and only the user can say where it goes (what is known is prefilled).
    NeedsInput(PlaceForm),
    /// Misplaced but cannot be fixed automatically (the reason is shown to the user).
    Stuck(String),
}

fn artist_album_tags(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(tagged) = read_from_path(path) else {
        return (None, None);
    };
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return (None, None);
    };
    let text = |s: Option<&str>| {
        s.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let artist =
        text(tag.get_string(ItemKey::AlbumArtist)).or_else(|| text(tag.artist().as_deref()));
    (artist, text(tag.album().as_deref()))
}

/// Same rule the library scan uses: the two folders above the file are artist and album.
/// Files with fewer or more folders are moved to `root/Artist/Album/` (keeping a `Disc N` folder).
pub fn placement(root: &Path, path: &Path) -> Placement {
    let Ok(rel) = path.strip_prefix(root) else {
        return Placement::Stuck("outside the library".to_owned());
    };
    let parts: Vec<String> = rel
        .iter()
        .filter_map(|p| p.to_str().map(str::to_owned))
        .collect();
    let Some((file, dirs)) = parts.split_last() else {
        return Placement::Ok;
    };
    let (core, disc) = match dirs.split_last() {
        Some((last, rest)) if rest.len() >= 2 && is_disc_folder(last) => (rest, Some(last)),
        _ => (dirs, None),
    };
    let (artist, album) = match core {
        [_, _] => return Placement::Ok,
        [] => match artist_album_tags(path) {
            (Some(ar), Some(al)) => (
                sanitize(&ar, "Unknown Artist"),
                sanitize(&al, "Unknown Album"),
            ),
            (artist, album) => return Placement::NeedsInput(PlaceForm { artist, album }),
        },
        [artist] => match artist_album_tags(path).1 {
            Some(al) => (artist.clone(), sanitize(&al, "Unknown Album")),
            None => {
                return Placement::NeedsInput(PlaceForm {
                    artist: Some(artist.clone()),
                    album: None,
                });
            }
        },
        [.., artist, album] => (artist.clone(), album.clone()),
    };
    let mut target = root.join(artist).join(album);
    if let Some(d) = disc {
        target.push(d);
    }
    target.push(file);
    if target.symlink_metadata().is_ok() {
        return Placement::Stuck(
            "a file with that name already exists in the right folder".to_owned(),
        );
    }
    Placement::Move(target)
}

fn issues_for(root: &Path, path: &Path, ffmpeg: bool) -> Vec<Issue> {
    let issue = |kind, message: &str, fixable| Issue {
        path: path.to_string_lossy().into_owned(),
        kind,
        message: message.to_owned(),
        fixable,
        place: None,
    };
    let mut out = Vec::new();
    if is_mp3(path) {
        if id3v2_major(path) == Some(4) {
            out.push(issue(
                Kind::TagVersion,
                "ID3v2.4 tags (older players need v2.3)",
                true,
            ));
        }
    } else {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("?")
            .to_uppercase();
        out.push(issue(Kind::NotMp3, &format!("{ext} file, not MP3"), ffmpeg));
    }
    match placement(root, path) {
        Placement::Ok => {}
        Placement::Move(to) => {
            let dest = to
                .parent()
                .and_then(|p| p.strip_prefix(root).ok())
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            out.push(issue(Kind::Misplaced, &format!("Belongs in {dest}"), true));
        }
        Placement::NeedsInput(form) => out.push(Issue {
            place: Some(form),
            ..issue(Kind::Misplaced, "Not in an Artist/Album folder", false)
        }),
        Placement::Stuck(why) => {
            out.push(issue(Kind::Misplaced, &format!("Misplaced: {why}"), false));
        }
    }
    out
}

/// Checks every audio file under `root`. Fails when the library cannot be read at all, so an
/// unreadable folder is never mistaken for a clean one.
pub fn audit(root: &Path, ffmpeg: bool) -> Result<Vec<Issue>, Error> {
    fsops::read_dir(root)?;
    let mut out = Vec::new();
    let walker = WalkDir::new(root).into_iter().filter_entry(|e| {
        e.depth() == 0 || !e.file_name().to_str().is_some_and(|n| n.starts_with('.'))
    });
    for entry in walker.filter_map(Result::ok) {
        if entry.file_type().is_file() && is_audio(entry.path()) {
            out.extend(issues_for(root, entry.path(), ffmpeg));
        }
    }
    Ok(out)
}

/// Sends a replaced original to the Trash so it stays recoverable. Tests delete instead, so
/// running them does not fill the developer's Trash.
fn recoverable_delete(path: &Path) -> Result<(), String> {
    if cfg!(test) {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    } else {
        trash::delete(path).map_err(|e| e.to_string())
    }
}

fn err(msg: impl Into<String>) -> Error {
    Error::Msg(msg.into())
}

/// A hidden scratch file next to `near`, unique per process and purpose.
fn scratch(near: &Path, tag: &str) -> PathBuf {
    near.with_file_name(format!(".manplay-{tag}-{}.mp3", std::process::id()))
}

/// Swaps `new` in for `original` (same folder). The original is parked in a scratch folder
/// first and goes back if the swap fails; afterwards it is trashed (`keep_in_trash`) or deleted.
fn replace_file(original: &Path, new: &Path, keep_in_trash: bool) -> Result<(), Error> {
    let name = original.file_name().ok_or_else(|| err("no file name"))?;
    let parent = original.parent().ok_or_else(|| err("no parent folder"))?;
    let aside_dir = parent.join(format!(".manplay-aside-{}", std::process::id()));
    std::fs::create_dir_all(&aside_dir)?;
    let aside = aside_dir.join(name);
    let cleanup = || {
        let _ = std::fs::remove_dir(&aside_dir);
    };
    if let Err(e) = std::fs::rename(original, &aside) {
        cleanup();
        return Err(e.into());
    }
    if let Err(e) = std::fs::rename(new, original) {
        let restored = std::fs::rename(&aside, original).is_ok();
        cleanup();
        return Err(err(if restored {
            format!("{e}. The original is unchanged.")
        } else {
            format!("{e}. The original is at {}", aside.display())
        }));
    }
    if keep_in_trash {
        if let Err(e) = recoverable_delete(&aside) {
            log::warn!("could not trash {}: {e}; deleting", aside.display());
            let _ = std::fs::remove_file(&aside);
        }
    } else {
        let _ = std::fs::remove_file(&aside);
    }
    cleanup();
    Ok(())
}

fn convert_args(src: &Path, out: &Path) -> Vec<std::ffi::OsString> {
    let mut args = ffmpeg_args(src, out);
    if sample_rate(src).is_some_and(|r| r > MAX_MP3_SAMPLE_RATE) {
        let last = args.pop();
        args.push("-ar".into());
        args.push(TARGET_SAMPLE_RATE.into());
        args.extend(last);
    }
    args
}

/// Converts to MP3 (320 kbps, tags and cover kept) as `name.mp3` beside the source, then sends the
/// original to the Trash. Sources above 48 kHz are resampled to 44.1 kHz.
fn convert(path: &Path, ffmpeg: &Path) -> Result<PathBuf, Error> {
    let dest = path.with_extension("mp3");
    if dest.symlink_metadata().is_ok() {
        return Err(err(format!(
            "{} already exists; not overwriting",
            dest.file_name()
                .map(|n| n.to_string_lossy())
                .unwrap_or_default()
        )));
    }
    let tmp = scratch(path, "convert");
    let out = Command::new(ffmpeg)
        .args(convert_args(path, &tmp))
        .output()
        .map_err(|e| err(format!("could not run ffmpeg: {e}")))?;
    let healthy = out.status.success()
        && read_from_path(&tmp).is_ok_and(|f| f.properties().duration().as_millis() > 0);
    if !healthy {
        let _ = std::fs::remove_file(&tmp);
        let msg = String::from_utf8_lossy(&out.stderr);
        let last = msg.lines().rev().find(|l| !l.trim().is_empty());
        return Err(err(format!(
            "conversion failed: {}",
            last.unwrap_or("output unreadable").trim()
        )));
    }
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    // The MP3 is safely in place; the original is recoverable from the Trash.
    if let Err(e) = recoverable_delete(path) {
        return Err(err(format!(
            "converted, but could not move the original to the Trash: {e}"
        )));
    }
    Ok(dest)
}

/// Rewrites ID3v2.4 tags as v2.3 on a copy, checks it, and swaps it in.
fn downgrade_tags(path: &Path) -> Result<(), Error> {
    let tmp = scratch(path, "id3");
    std::fs::copy(path, &tmp)?;
    let result = (|| -> Result<(), Error> {
        let tagged = read_from_path(&tmp).map_err(|e| err(format!("unreadable tags: {e}")))?;
        let tag = tagged
            .tag(TagType::Id3v2)
            .ok_or_else(|| err("no ID3v2 tag"))?;
        tag.save_to_path(&tmp, WriteOptions::default().use_id3v23(true))
            .map_err(|e| err(format!("could not write tags: {e}")))?;
        if id3v2_major(&tmp) != Some(3) {
            return Err(err("tag rewrite did not produce ID3v2.3"));
        }
        if read_from_path(&tmp).is_err() {
            return Err(err("rewritten file is unreadable"));
        }
        Ok(())
    })();
    match result {
        Ok(()) => replace_file(path, &tmp, false).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        }),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn relocate(root: &Path, from: &Path, to: &Path) -> Result<PathBuf, Error> {
    let dir = to.parent().ok_or_else(|| err("no destination folder"))?;
    let mut undo = Undo::default();
    if let Err(e) = undo.create_dir_all(dir) {
        return Err(fsops::rolled_back(&e, undo));
    }
    if let Err(e) = undo.rename(from, to) {
        return Err(fsops::rolled_back(&e, undo));
    }
    if let Some(old) = from.parent() {
        fsops::prune_empty(root, old);
    }
    Ok(to.to_owned())
}

/// Files `path` under `root/artist/album/` using names the user typed, creating the folders.
/// Never overwrites; the file keeps its name.
pub fn place_file(root: &Path, path: &Path, artist: &str, album: &str) -> Result<PathBuf, Error> {
    let root = root.canonicalize()?;
    let from = fsops::inside(&root, path)?;
    if artist.trim().is_empty() || album.trim().is_empty() {
        return Err(err("enter both an artist and an album"));
    }
    let file = from.file_name().ok_or_else(|| err("no file name"))?;
    let to = root
        .join(sanitize(artist, "Unknown Artist"))
        .join(sanitize(album, "Unknown Album"))
        .join(file);
    if to == from {
        return Ok(from);
    }
    if to.symlink_metadata().is_ok() {
        return Err(err("a file with that name already exists in that album"));
    }
    relocate(&root, &from, &to)
}

/// Fixes everything wrong with one file, step by step. Returns where the file ended up.
/// Each step leaves the file intact if it fails.
pub fn fix_file(root: &Path, path: &Path, ffmpeg: Option<&Path>) -> Result<PathBuf, Error> {
    let root = root.canonicalize()?;
    let mut cur = fsops::inside(&root, path)?;
    if !is_mp3(&cur) {
        let ffmpeg = ffmpeg.ok_or_else(|| err("ffmpeg is not installed (brew install ffmpeg)"))?;
        cur = convert(&cur, ffmpeg)?;
    }
    if id3v2_major(&cur) == Some(4) {
        downgrade_tags(&cur)?;
    }
    match placement(&root, &cur) {
        Placement::Move(to) => cur = relocate(&root, &cur, &to)?,
        Placement::NeedsInput(_) => {
            return Err(err("not moved: needs an artist and album (use the form)"));
        }
        Placement::Stuck(why) => return Err(err(format!("not moved: {why}"))),
        Placement::Ok => {}
    }
    Ok(cur)
}

/// Fixes each path independently: one failure never stops or undoes the others.
pub fn fix_all(root: &Path, paths: &[PathBuf], ffmpeg: Option<&Path>) -> FixReport {
    let mut report = FixReport::default();
    for p in paths {
        match fix_file(root, p, ffmpeg) {
            Ok(_) => report.fixed += 1,
            Err(e) => report.failed.push(FixFailure {
                path: p.to_string_lossy().into_owned(),
                error: e.to_string(),
            }),
        }
    }
    report
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("manplay-audit-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("mkdir");
        d.canonicalize().expect("canon")
    }

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().expect("parent")).expect("mkdir");
        std::fs::write(p, b"x").expect("write");
    }

    #[test]
    fn disc_folders_are_recognised() {
        for yes in ["Disc 1", "disc2", "CD 3", "cd10"] {
            assert!(is_disc_folder(yes), "{yes}");
        }
        for no in ["Discovery", "Disc", "CD", "Abbey Road", "Disc One"] {
            assert!(!is_disc_folder(no), "{no}");
        }
    }

    #[test]
    fn id3_version_is_read_from_the_header() {
        let root = tmp("id3");
        let v4 = root.join("a.mp3");
        std::fs::write(&v4, b"ID3\x04\x00\x00\x00\x00\x00\x00rest").expect("w");
        let v3 = root.join("b.mp3");
        std::fs::write(&v3, b"ID3\x03\x00\x00\x00\x00\x00\x00rest").expect("w");
        let none = root.join("c.mp3");
        std::fs::write(&none, b"\xff\xfb\x90\x00\x00\x00\x00\x00\x00\x00\x00").expect("w");
        assert_eq!(id3v2_major(&v4), Some(4));
        assert_eq!(id3v2_major(&v3), Some(3));
        assert_eq!(id3v2_major(&none), None);
    }

    #[test]
    fn placement_follows_artist_album_layout() {
        let root = tmp("place");
        let ok = root.join("A/B/01 t.mp3");
        touch(&ok);
        assert_eq!(placement(&root, &ok), Placement::Ok);

        let disc = root.join("A/B/Disc 2/01 t.mp3");
        touch(&disc);
        assert_eq!(
            placement(&root, &disc),
            Placement::Ok,
            "disc folder is allowed"
        );

        let wrapped = root.join("Media/Music/A/B/t.mp3");
        touch(&wrapped);
        assert_eq!(
            placement(&root, &wrapped),
            Placement::Move(root.join("A/B/t.mp3"))
        );

        let wrapped_disc = root.join("Media/A/B/Disc 1/t.mp3");
        touch(&wrapped_disc);
        assert_eq!(
            placement(&root, &wrapped_disc),
            Placement::Move(root.join("A/B/Disc 1/t.mp3"))
        );

        // Loose file with no readable tags cannot be filed.
        let loose = root.join("loose.mp3");
        touch(&loose);
        assert!(matches!(placement(&root, &loose), Placement::NeedsInput(_)));
        let artist_only = root.join("A/single.mp3");
        touch(&artist_only);
        assert!(matches!(
            placement(&root, &artist_only),
            Placement::NeedsInput(_)
        ));
    }

    #[test]
    fn unfileable_files_ask_the_user_with_what_is_known() {
        let root = tmp("ask");
        touch(&root.join("A/single.mp3"));
        assert_eq!(
            placement(&root, &root.join("A/single.mp3")),
            Placement::NeedsInput(PlaceForm {
                artist: Some("A".to_owned()),
                album: None
            })
        );
        touch(&root.join("loose.mp3"));
        let issues = issues_for(&root, &root.join("loose.mp3"), true);
        assert_eq!(issues.len(), 1);
        assert!(!issues[0].fixable && issues[0].place.is_some());
    }

    #[test]
    fn place_file_creates_the_folders_and_never_overwrites() {
        let root = tmp("place-form");
        touch(&root.join("A/single.mp3"));
        let to = place_file(&root, &root.join("A/single.mp3"), "A", "My: Album").expect("place");
        assert_eq!(to, root.join("A/My_ Album/single.mp3"));
        assert!(to.exists() && !root.join("A/single.mp3").exists());

        touch(&root.join("single.mp3"));
        assert!(place_file(&root, &root.join("single.mp3"), "A", "My: Album").is_err());
        assert!(root.join("single.mp3").exists(), "untouched on failure");
        assert!(place_file(&root, &root.join("single.mp3"), " ", "x").is_err());
        assert!(place_file(&root, &root.join("../x.mp3"), "A", "B").is_err());
    }

    #[test]
    fn placement_refuses_to_overwrite() {
        let root = tmp("clash");
        touch(&root.join("A/B/t.mp3"));
        touch(&root.join("X/A/B/t.mp3"));
        assert!(matches!(
            placement(&root, &root.join("X/A/B/t.mp3")),
            Placement::Stuck(_)
        ));
    }

    #[test]
    fn audit_flags_non_mp3_and_skips_hidden_and_non_audio() {
        let root = tmp("flags");
        touch(&root.join("A/B/01 t.flac"));
        touch(&root.join("A/B/cover.jpg"));
        touch(&root.join(".hidden/x.flac"));
        let issues = audit(&root, true).expect("audit");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].kind, Kind::NotMp3);
        assert!(issues[0].fixable);
        assert!(
            !audit(&root, false).expect("audit")[0].fixable,
            "no ffmpeg, no conversion"
        );
    }

    #[test]
    fn relocate_moves_creates_folders_and_prunes_the_old_ones() {
        let root = tmp("reloc");
        touch(&root.join("Media/Music/A/B/t.mp3"));
        let from = root.join("Media/Music/A/B/t.mp3");
        let to = root.join("A/B/t.mp3");
        relocate(&root, &from, &to).expect("move");
        assert!(to.exists());
        assert!(!root.join("Media").exists(), "emptied folders removed");
    }

    #[test]
    fn replace_file_swaps_and_leaves_no_scratch_behind() {
        let root = tmp("swap");
        let orig = root.join("a.mp3");
        std::fs::write(&orig, b"old").expect("w");
        let new = root.join(".new.tmp");
        std::fs::write(&new, b"new").expect("w");
        replace_file(&orig, &new, false).expect("swap");
        assert_eq!(std::fs::read(&orig).expect("r"), b"new");
        let names: Vec<_> = std::fs::read_dir(&root)
            .expect("ls")
            .filter_map(Result::ok)
            .map(|e| e.file_name())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
    }

    #[test]
    fn replace_file_restores_the_original_when_the_swap_fails() {
        let root = tmp("swapfail");
        let orig = root.join("a.mp3");
        std::fs::write(&orig, b"old").expect("w");
        let missing = root.join(".nope.tmp");
        assert!(replace_file(&orig, &missing, false).is_err());
        assert_eq!(std::fs::read(&orig).expect("r"), b"old");
    }

    #[test]
    fn fix_all_reports_each_failure_and_keeps_going() {
        let root = tmp("fixall");
        touch(&root.join("Media/A/B/t.mp3"));
        touch(&root.join("loose.mp3")); // stuck: no tags
        let paths = [root.join("loose.mp3"), root.join("Media/A/B/t.mp3")];
        let report = fix_all(&root, &paths, None);
        assert_eq!(report.fixed, 1);
        assert_eq!(report.failed.len(), 1);
        assert!(root.join("A/B/t.mp3").exists());
        assert!(root.join("loose.mp3").exists(), "failed file untouched");
    }

    /// Makes a 1 s tone with ffmpeg; `None` when ffmpeg is not installed (test is skipped).
    fn tone(ffmpeg: &Path, out: &Path, extra: &[&str]) {
        std::fs::create_dir_all(out.parent().expect("parent")).expect("mkdir");
        let status = Command::new(ffmpeg)
            .args([
                "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "sine=d=1",
            ])
            .args([
                "-metadata",
                "artist=Tone Artist",
                "-metadata",
                "album=Tone Album",
            ])
            .args(extra)
            .arg(out)
            .status()
            .expect("run ffmpeg");
        assert!(status.success());
    }

    #[test]
    fn end_to_end_fixes_with_real_audio() {
        let Some(ffmpeg) = crate::itunes::find_ffmpeg() else {
            return;
        };
        let root = tmp("e2e");
        // FLAC loose in the root: convert + file under Artist/Album.
        tone(&ffmpeg, &root.join("song.flac"), &[]);
        // High-resolution FLAC: needs resampling to become an MP3.
        tone(&ffmpeg, &root.join("A/B/hi.flac"), &["-ar", "96000"]);
        // 44.1 kHz MP3 with ID3v2.4: tag rewrite only.
        tone(
            &ffmpeg,
            &root.join("A/B/v4.mp3"),
            &["-ar", "44100", "-id3v2_version", "4"],
        );
        let before = audit(&root, true).expect("audit");
        let kinds = |p: &str| -> Vec<Kind> {
            before
                .iter()
                .filter(|i| i.path.ends_with(p))
                .map(|i| i.kind)
                .collect()
        };
        assert!(kinds("song.flac").contains(&Kind::NotMp3));
        assert!(kinds("song.flac").contains(&Kind::Misplaced));
        assert!(kinds("hi.flac").contains(&Kind::NotMp3));
        assert_eq!(kinds("v4.mp3"), vec![Kind::TagVersion]);

        let paths: Vec<PathBuf> = ["song.flac", "A/B/hi.flac", "A/B/v4.mp3"]
            .iter()
            .map(|p| root.join(p))
            .collect();
        let report = fix_all(&root, &paths, Some(&ffmpeg));
        assert!(report.failed.is_empty(), "{:?}", report.failed);

        assert!(root.join("Tone Artist/Tone Album/song.mp3").exists());
        assert!(!root.join("song.flac").exists(), "original moved to Trash");
        assert_eq!(sample_rate(&root.join("A/B/hi.mp3")), Some(44_100));
        assert!(!root.join("A/B/hi.flac").exists());
        assert_eq!(id3v2_major(&root.join("A/B/v4.mp3")), Some(3));
        assert_eq!(
            audit(&root, true).expect("audit"),
            Vec::new(),
            "a clean library has no issues"
        );
    }
}
