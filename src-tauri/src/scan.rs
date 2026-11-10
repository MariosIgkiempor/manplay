use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use lofty::file::TaggedFileExt;
use lofty::read_from_path;
use lofty::tag::Accessor;
use walkdir::WalkDir;

use crate::db::NewTrack;

const EXTENSIONS: &[&str] = &["wav", "flac", "mp3", "aif", "aiff", "m4a"];

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

const SAMPLE: u64 = 64 * 1024;

/// Cheap content fingerprint used to recognise a file after it was renamed or moved:
/// the size plus two 64 KiB samples from inside the audio (so editing tags in place at the
/// start or end of the file does not change it). Reads ~128 KiB per file, even for huge WAVs.
pub fn fingerprint(path: &Path, size: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(&size.to_le_bytes());
    let mut buf = vec![0_u8; usize::try_from(SAMPLE).ok()?];
    if size <= SAMPLE * 2 {
        let mut all = Vec::new();
        file.read_to_end(&mut all).ok()?;
        hasher.update(&all);
    } else {
        for third in 1..=2 {
            file.seek(SeekFrom::Start(size / 3 * third)).ok()?;
            file.read_exact(&mut buf).ok()?;
            hasher.update(&buf);
        }
    }
    Some(hasher.finalize().to_hex().to_string())
}

pub struct ScanResult {
    pub tracks: Vec<NewTrack>,
    /// Entries that could not be read. A scan with errors is not trusted to say what is missing.
    pub errors: usize,
}

fn read_track(root: &Path, entry: &walkdir::DirEntry) -> Option<NewTrack> {
    let path = entry.path();
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<&str> = rel.iter().filter_map(|p| p.to_str()).collect();
    let tagged = read_from_path(path).ok();
    let tag = tagged.as_ref().and_then(|f| f.primary_tag());
    let tag_text = |get: fn(&lofty::tag::Tag) -> Option<std::borrow::Cow<'_, str>>| {
        tag.and_then(get).map(std::borrow::Cow::into_owned)
    };
    let (artist, album) = match parts.as_slice() {
        [artist, album, _] => ((*artist).to_owned(), (*album).to_owned()),
        _ => (
            tag_text(Accessor::artist).unwrap_or_else(|| "Unknown".to_owned()),
            tag_text(Accessor::album).unwrap_or_else(|| "Unknown".to_owned()),
        ),
    };
    let stem = path.file_stem()?.to_str()?.to_owned();
    let title = tag_text(Accessor::title).unwrap_or(stem);
    let len = entry.metadata().ok()?.len();
    Some(NewTrack {
        path: path.to_str()?.to_owned(),
        artist,
        album,
        title,
        size: i64::try_from(len).ok()?,
        fingerprint: fingerprint(path, len),
    })
}

/// Library layout is `root/artist/album/track.ext`. Folder names win when the
/// file sits at that depth; otherwise fall back to tags, then "Unknown".
pub fn scan(root: &Path) -> ScanResult {
    let mut result = ScanResult {
        tracks: Vec::new(),
        errors: 0,
    };
    for entry in WalkDir::new(root) {
        match entry {
            Err(_) => result.errors += 1,
            Ok(e) if e.file_type().is_file() && is_audio(e.path()) => match read_track(root, &e) {
                Some(t) => result.tracks.push(t),
                None => result.errors += 1,
            },
            Ok(_) => {}
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(len: usize, seed: u8) -> Vec<u8> {
        (0..len)
            .map(|i| u8::try_from(i % 251).unwrap_or(0).wrapping_add(seed))
            .collect()
    }

    fn write(dir: &Path, name: &str, data: &[u8]) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, data).unwrap_or_default();
        p
    }

    fn fp(path: &Path) -> Option<String> {
        fingerprint(path, std::fs::metadata(path).ok()?.len())
    }

    #[test]
    fn fingerprint_identifies_content_not_name_or_edited_edges() {
        let dir = std::env::temp_dir().join(format!("manplay-fp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap_or_default();

        let original = bytes(400_000, 1);
        let a = write(&dir, "a.bin", &original);
        let renamed = write(&dir, "renamed.bin", &original);
        let other = write(&dir, "other.bin", &bytes(400_000, 9));
        let mut retagged = original.clone();
        retagged[..200].fill(0xAB); // in-place tag edit at the start
        let retagged = write(&dir, "retagged.bin", &retagged);
        let mut truncated = original;
        truncated.pop();
        let truncated = write(&dir, "truncated.bin", &truncated);

        assert_eq!(
            fp(&a),
            fp(&renamed),
            "same content under another name matches"
        );
        assert_ne!(fp(&a), fp(&other), "different audio differs");
        assert_eq!(
            fp(&a),
            fp(&retagged),
            "in-place edits at the file edges are tolerated"
        );
        assert_ne!(fp(&a), fp(&truncated), "a different size differs");
        assert!(fp(&a).is_some());

        let tiny = write(&dir, "tiny.bin", b"hello");
        assert_ne!(fp(&tiny), fp(&a));
        assert_eq!(fp(&dir.join("missing.bin")), None);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
