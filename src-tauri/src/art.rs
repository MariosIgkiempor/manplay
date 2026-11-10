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
    let key = cache_key(dir);
    let hit = cache_dir.join(format!("{key}.jpg"));
    let miss = cache_dir.join(format!("{key}.none"));
    if let Ok(bytes) = fs::read(&hit) {
        return Some(bytes);
    }
    if miss.exists() {
        return None;
    }

    let folder = folder_image(dir);
    let raw = match folder {
        Lookup::Found(bytes) => Lookup::Found(bytes),
        other => match embedded_image(track) {
            Lookup::Found(bytes) => Lookup::Found(bytes),
            Lookup::Unreadable => Lookup::Unreadable,
            Lookup::Absent => other,
        },
    };

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

#[cfg(test)]
mod tests {
    use super::*;

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
