//! Album artwork: a folder image if present, otherwise embedded tag art,
//! downscaled and cached on disk per album folder.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::Path;

use image::ImageFormat;
use lofty::file::TaggedFileExt;
use lofty::read_from_path;

const FOLDER_NAMES: &[&str] = &["cover", "folder", "front", "album", "artwork"];
const FOLDER_EXTS: &[&str] = &["jpg", "jpeg", "png"];
const THUMB_SIZE: u32 = 400;

/// Result of looking for raw artwork bytes.
enum Lookup {
    Found(Vec<u8>),
    /// Looked everywhere readable and there is definitely none.
    Absent,
    /// Could not read something (permissions, unmounted volume, ...). Never cache this.
    Unreadable,
}

fn folder_image(dir: &Path) -> Lookup {
    let Ok(read) = fs::read_dir(dir) else {
        return Lookup::Unreadable;
    };
    let mut candidates: Vec<_> = read
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase);
            let stem = p
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase);
            ext.is_some_and(|e| FOLDER_EXTS.contains(&e.as_str()))
                && stem.is_some_and(|s| FOLDER_NAMES.contains(&s.as_str()))
        })
        .collect();
    candidates.sort();
    match candidates.first() {
        None => Lookup::Absent,
        Some(p) => fs::read(p).map_or(Lookup::Unreadable, Lookup::Found),
    }
}

fn embedded_image(track: &Path) -> Lookup {
    let Ok(tagged) = read_from_path(track) else {
        return Lookup::Unreadable;
    };
    tagged
        .tags()
        .iter()
        .find_map(|t| t.pictures().first())
        .map_or(Lookup::Absent, |p| Lookup::Found(p.data().to_vec()))
}

fn cache_key(dir: &Path) -> String {
    let mut h = DefaultHasher::new();
    dir.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn encode_thumbnail(raw: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(raw)
        .ok()?
        .thumbnail(THUMB_SIZE, THUMB_SIZE)
        .to_rgb8();
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::Jpeg).ok()?;
    Some(out.into_inner())
}

/// JPEG thumbnail for the album containing `track`, or `None` if it has no art.
///
/// "No art" is remembered on disk only when every lookup succeeded; read failures
/// are retried next time so a permissions hiccup cannot hide artwork forever.
pub fn thumbnail(track: &Path, cache_dir: &Path) -> Option<Vec<u8>> {
    let dir = track.parent()?;
    // Embedded art first: it is what the tag editor sets, so edits show up even when a
    // stale cover.jpg sits in the folder.
    thumbnail_filed(dir, cache_dir, || match embedded_image(track) {
        Lookup::Absent => folder_image(dir),
        found => found,
    })
}

/// [`thumbnail`] of a song whose file is kept elsewhere than its folder (a streamed song's copy
/// in the stream cache): the art is read from `file`, and filed under `folder`, the song's own,
/// so songs from different albums kept side by side keep their own covers.
pub fn thumbnail_in(file: &Path, folder: &Path, cache_dir: &Path) -> Option<Vec<u8>> {
    thumbnail_filed(folder, cache_dir, || embedded_image(file))
}

/// The thumbnail of the picture file `picture`, filed under `folder` (a streamed song's cover
/// set on this device, before any file of it is here).
pub fn picture_thumbnail(picture: &Path, folder: &Path, cache_dir: &Path) -> Option<Vec<u8>> {
    thumbnail_filed(folder, cache_dir, || match fs::read(picture) {
        Ok(bytes) => Lookup::Found(bytes),
        Err(_) => Lookup::Unreadable,
    })
}

/// The cached thumbnail filed under `folder`, else the art `read` finds, encoded and cached.
fn thumbnail_filed(
    folder: &Path,
    cache_dir: &Path,
    read: impl FnOnce() -> Lookup,
) -> Option<Vec<u8>> {
    let key = cache_key(folder);
    let hit = cache_dir.join(format!("{key}.jpg"));
    let miss = cache_dir.join(format!("{key}.none"));
    if let Ok(bytes) = fs::read(&hit) {
        return Some(bytes);
    }
    if miss.exists() {
        return None;
    }
    let raw = read();
    // Cache writes are best-effort; failing to cache must not hide the art.
    let _ = fs::create_dir_all(cache_dir);
    match raw {
        Lookup::Found(bytes) => {
            let thumb = encode_thumbnail(&bytes);
            let _ = match &thumb {
                Some(t) => fs::write(&hit, t),
                None => fs::write(&miss, b""), // undecodable format: permanent
            };
            thumb
        }
        Lookup::Absent => {
            let _ = fs::write(&miss, b"");
            None
        }
        Lookup::Unreadable => None,
    }
}

/// Forgets the cached thumbnail (or "no art" marker) for the folder holding `track`.
pub fn forget(track: &Path, cache_dir: &Path) {
    if let Some(dir) = track.parent() {
        let key = cache_key(dir);
        let _ = fs::remove_file(cache_dir.join(format!("{key}.jpg")));
        let _ = fs::remove_file(cache_dir.join(format!("{key}.none")));
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    /// Two pictures kept side by side (as streamed songs' files are, in the stream cache) keep
    /// their own thumbnails when filed under their songs' own folders.
    #[test]
    fn pictures_kept_side_by_side_are_filed_under_their_own_folders() {
        let dir = std::env::temp_dir().join(format!("manplay-art-filed-{}", std::process::id()));
        let cache = dir.join("cache");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        let one = dir.join("a1_01.png");
        let two = dir.join("a1_02.png");
        fs::write(&one, crate::tags::tests::picture(10)).expect("one");
        fs::write(&two, crate::tags::tests::picture(200)).expect("two");
        let first = picture_thumbnail(&one, Path::new("/music/A/One"), &cache).expect("first");
        let second = picture_thumbnail(&two, Path::new("/music/B/Two"), &cache).expect("second");
        assert_ne!(first, second, "each album has its own cover");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Runs only when `MANPLAY_ART_TRACK` points at an audio file.
    #[test]
    fn thumbnail_for_real_track() {
        let Ok(track) = std::env::var("MANPLAY_ART_TRACK") else {
            return;
        };
        let cache = std::env::temp_dir().join("manplay-art-test");
        let bytes = thumbnail(Path::new(&track), &cache);
        eprintln!("art bytes: {:?}", bytes.as_ref().map(Vec::len));
        assert!(bytes.as_ref().is_none_or(|b| b.starts_with(&[0xFF, 0xD8])));
    }
}
