use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::properties::FileProperties;
use lofty::read_from_path;
use lofty::tag::{Accessor, ItemKey};
use walkdir::WalkDir;

use crate::db::NewTrack;

const EXTENSIONS: &[&str] = &["wav", "flac", "mp3", "aif", "aiff", "m4a"];

pub fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

const SAMPLE: u64 = 64 * 1024;

/// Cheap content fingerprint used to recognise a file after it was renamed or moved:
/// the size plus two 64 KiB samples from inside the audio (so editing tags in place at the
/// start or end of the file does not change it). Reads ~128 KiB per file, even for huge WAVs.
pub fn fingerprint(path: &Path, size: u64) -> Option<String> {
    fingerprint_reader(&mut File::open(path).ok()?, size)
}

/// Same as [`fingerprint`] for any seekable source of `size` bytes (e.g. a file unpacked from a zip).
pub fn fingerprint_reader<R: Read + Seek>(file: &mut R, size: u64) -> Option<String> {
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

/// Byte ranges `(offset, length)` that [`fingerprint`] samples for a file of `size` bytes.
/// A file of at most two samples is read whole. `None` where [`fingerprint`] itself fails
/// because a sample would run past the end (sizes just above two samples).
pub fn sample_ranges(size: u64) -> Option<Vec<(u64, u64)>> {
    if size <= SAMPLE * 2 {
        return Some(vec![(0, size)]);
    }
    let ranges: Vec<(u64, u64)> = (1..=2).map(|third| (size / 3 * third, SAMPLE)).collect();
    ranges.iter().all(|(o, l)| o + l <= size).then_some(ranges)
}

/// Fingerprint from already-fetched sample bytes (in [`sample_ranges`] order), so a remote file
/// can be compared with the library without downloading it.
pub fn fingerprint_from_samples(size: u64, samples: &[Vec<u8>]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&size.to_le_bytes());
    for s in samples {
        hasher.update(s);
    }
    hasher.finalize().to_hex().to_string()
}

pub struct ScanResult {
    pub tracks: Vec<NewTrack>,
    /// Entries that could not be read. A scan with errors is not trusted to say what is missing.
    pub errors: usize,
    /// How often each value of the suggestion fields (artists, genres, ...) occurs.
    pub values: std::collections::HashMap<(&'static str, String), i64>,
}

/// Counts the names in the suggestion fields of one file, from the list fields kept for it
/// (`NewTrack::fields`), so a file the scan did not read again is counted like one it did.
pub fn collect_values(
    fields: Option<&str>,
    into: &mut std::collections::HashMap<(&'static str, String), i64>,
) {
    let Some(listed) = fields.and_then(|json| {
        serde_json::from_str::<std::collections::BTreeMap<String, String>>(json).ok()
    }) else {
        return;
    };
    for field in crate::tags::SUGGEST {
        let Some(text) = listed.get(*field) else {
            continue;
        };
        let names = if crate::tags::MULTI.contains(field) {
            crate::tags::split_names(text)
        } else {
            vec![text.clone()]
        };
        for name in names.into_iter().filter(|n| !n.is_empty()) {
            *into.entry((*field, name)).or_insert(0) += 1;
        }
    }
}

/// The `tags::LISTED` values of one file's tag, as a JSON object.
fn listed_fields(tag: &lofty::tag::Tag) -> Option<String> {
    let map: std::collections::BTreeMap<&str, String> = crate::tags::LISTED
        .iter()
        .filter_map(|f| crate::tags::read_field(Some(tag), f).map(|v| (*f, v)))
        .collect();
    serde_json::to_string(&map).ok()
}

/// Artist and album as named by the folders: the two folders directly above the file
/// (`…/Artist/Album/track.ext`), so wrappers like `Media.localized/Music/` are ignored.
/// A file directly inside an artist folder gets the album "Unknown". `None` only for files
/// sitting loose in `root`.
pub fn folder_names(root: &Path, path: &Path) -> Option<(String, String)> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<&str> = rel.iter().filter_map(|p| p.to_str()).collect();
    match parts.as_slice() {
        [.., artist, album, _] => Some(((*artist).to_owned(), (*album).to_owned())),
        [artist, _] => Some(((*artist).to_owned(), "Unknown".to_owned())),
        _ => None,
    }
}

/// An audio file the walk found, with what tells whether it changed since it was last read.
struct Found {
    path: PathBuf,
    size: u64,
    /// Unix milliseconds; `None` when the file system gives no modification time.
    mtime_ms: Option<i64>,
}

impl Found {
    fn of(entry: &walkdir::DirEntry) -> Option<Self> {
        let meta = entry.metadata().ok()?;
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|since| i64::try_from(since.as_millis()).ok());
        Some(Self {
            path: entry.path().to_owned(),
            size: meta.len(),
            mtime_ms,
        })
    }

    /// The library's row for this file, when the file is as it was when that row was read:
    /// same size, same modification time.
    fn unchanged(&self, known: &mut HashMap<String, NewTrack>) -> Option<NewTrack> {
        let path = self.path.to_str()?;
        let same = known.get(path).is_some_and(|k| {
            self.mtime_ms.is_some()
                && k.mtime_ms == self.mtime_ms
                && u64::try_from(k.size).is_ok_and(|size| size == self.size)
        });
        same.then(|| known.remove(path)).flatten()
    }
}

fn read_track(root: &Path, found: &Found) -> Option<NewTrack> {
    let path = found.path.as_path();
    let folders = folder_names(root, path);
    let tagged = read_from_path(path).ok();
    let tag = tagged.as_ref().and_then(|f| f.primary_tag());
    let tag_text = |get: fn(&lofty::tag::Tag) -> Option<std::borrow::Cow<'_, str>>| {
        tag.and_then(get).map(std::borrow::Cow::into_owned)
    };
    // Jellyfin's rule: tags decide grouping (album artist, else artist; album tag), and the
    // folder names are only the fallback for untagged files.
    let (folder_artist, folder_album) = folders.unzip();
    let album_artist = tag
        .and_then(|t| t.get_string(ItemKey::AlbumArtist))
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .map(str::to_owned);
    let artist = album_artist
        .or_else(|| tag_text(Accessor::artist).filter(|a| !a.trim().is_empty()))
        .or(folder_artist)
        .unwrap_or_else(|| "Unknown".to_owned());
    let album = tag_text(Accessor::album)
        .filter(|a| !a.trim().is_empty())
        .or(folder_album)
        .unwrap_or_else(|| "Unknown".to_owned());
    let stem = path.file_stem()?.to_str()?.to_owned();
    let title = tag_text(Accessor::title).unwrap_or(stem);
    let props = tagged.as_ref().map(AudioFile::properties);
    let millis = props.and_then(|p| i64::try_from(p.duration().as_millis()).ok());
    Some(NewTrack {
        path: path.to_str()?.to_owned(),
        artist,
        album,
        title,
        size: i64::try_from(found.size).ok()?,
        fingerprint: fingerprint(path, found.size),
        audio_fp: Some(crate::audioprint::audio_print_path(path).unwrap_or_default()),
        duration_ms: millis.filter(|m| *m > 0),
        bitrate: props.and_then(FileProperties::audio_bitrate).map(i64::from),
        sample_rate: props.and_then(FileProperties::sample_rate).map(i64::from),
        tag_bpm: crate::tags::read_field(tag, "bpm")
            .and_then(|b| b.trim().replace(',', ".").parse::<f64>().ok())
            .filter(|b| b.is_finite() && *b > 0.0),
        tag_key: crate::tags::read_field(tag, "key")
            .and_then(|k| crate::analysis::normalize_key(&k)),
        fields: tag.and_then(listed_fields),
        mtime_ms: found.mtime_ms,
    })
}

/// Reads the given files on a few threads, since each one is opened, parsed and fingerprinted
/// on its own. The results come back in the order of `files`; `None` for a file that failed.
fn read_tracks(root: &Path, files: &[&Found]) -> Vec<Option<NewTrack>> {
    let workers = std::thread::available_parallelism()
        .map_or(2, std::num::NonZero::get)
        .clamp(1, 8)
        .min(files.len().max(1));
    let next = AtomicUsize::new(0);
    let mut read: Vec<(usize, Option<NewTrack>)> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                scope.spawn(|| {
                    let mut mine = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(found) = files.get(i) else { break };
                        mine.push((i, read_track(root, found)));
                    }
                    mine
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap_or_default())
            .collect()
    });
    read.sort_by_key(|(i, _)| *i);
    let mut tracks: Vec<Option<NewTrack>> = read.into_iter().map(|(_, track)| track).collect();
    // A reader that panicked took its files with it: they count as unread.
    tracks.resize_with(files.len(), || None);
    tracks
}

/// Library layout is `…/artist/album/track.ext`. Tags win (album artist, then artist; album),
/// matching Jellyfin; folder names are the fallback for untagged files, then "Unknown".
///
/// `known` is what earlier scans read, by path (`db::scanned_tracks`). A file with the size and
/// modification time it had then is taken from there instead of being opened, so a scan of a
/// library that has not changed only walks its folders. Pass an empty map to read every file.
pub fn scan(root: &Path, mut known: HashMap<String, NewTrack>) -> ScanResult {
    let mut errors = 0;
    let mut files: Vec<Found> = Vec::new();
    for entry in WalkDir::new(root) {
        match entry {
            Err(_) => errors += 1,
            Ok(e) if e.file_type().is_file() && is_audio(e.path()) => match Found::of(&e) {
                Some(found) => files.push(found),
                None => errors += 1,
            },
            Ok(_) => {}
        }
    }
    let mut slots: Vec<Option<NewTrack>> = files.iter().map(|f| f.unchanged(&mut known)).collect();
    let changed: Vec<usize> = (0..files.len()).filter(|i| slots[*i].is_none()).collect();
    let to_read: Vec<&Found> = changed.iter().map(|i| &files[*i]).collect();
    for (i, track) in changed.iter().zip(read_tracks(root, &to_read)) {
        slots[*i] = track;
    }
    let mut result = ScanResult {
        tracks: Vec::with_capacity(slots.len()),
        errors,
        values: HashMap::new(),
    };
    for slot in slots {
        match slot {
            Some(track) => {
                collect_values(track.fields.as_deref(), &mut result.values);
                result.tracks.push(track);
            }
            None => result.errors += 1,
        }
    }
    result
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    #[test]
    fn sampled_fingerprint_matches_reader() {
        for size in [10_u64, 131_072, 131_073, 500_000] {
            let data: Vec<u8> = (0..size)
                .map(|i| u8::try_from(i % 251).unwrap_or(0))
                .collect();
            let expect = super::fingerprint_reader(&mut std::io::Cursor::new(&data), size);
            let Some(ranges) = super::sample_ranges(size) else {
                assert_eq!(expect, None, "size {size}");
                continue;
            };
            let parts: Vec<Vec<u8>> = ranges
                .into_iter()
                .map(|(o, l)| {
                    let o = usize::try_from(o).unwrap_or(0);
                    let l = usize::try_from(l).unwrap_or(0);
                    data[o..o + l].to_vec()
                })
                .collect();
            assert_eq!(
                Some(super::fingerprint_from_samples(size, &parts)),
                expect,
                "size {size}"
            );
        }
    }

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

    #[test]
    fn folders_name_artist_and_album_even_when_nested() {
        let root = Path::new("/lib");
        let names = |p: &str| folder_names(root, Path::new(p));
        let some = |a: &str, b: &str| Some((a.to_owned(), b.to_owned()));
        assert_eq!(names("/lib/A/B/t.mp3"), some("A", "B"));
        assert_eq!(
            names("/lib/Media.localized/Music/A/B/t.m4a"),
            some("A", "B")
        );
        assert_eq!(names("/lib/A/t.mp3"), some("A", "Unknown"));
        assert_eq!(names("/lib/t.mp3"), None);
    }

    /// Minimal valid WAV: mono, 8-bit, `rate` Hz, `secs` seconds of silence.
    fn wav(rate: u32, secs: u32) -> Vec<u8> {
        let data_len = rate * secs;
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data_len).to_le_bytes());
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&16_u32.to_le_bytes());
        v.extend_from_slice(&1_u16.to_le_bytes()); // PCM
        v.extend_from_slice(&1_u16.to_le_bytes()); // mono
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&rate.to_le_bytes()); // byte rate
        v.extend_from_slice(&1_u16.to_le_bytes()); // block align
        v.extend_from_slice(&8_u16.to_le_bytes()); // bits
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data_len.to_le_bytes());
        v.resize(v.len() + data_len as usize, 128);
        v
    }

    #[test]
    fn scan_reads_duration_and_sample_rate() {
        let root = std::env::temp_dir().join(format!("manplay-props-{}", std::process::id()));
        let album = root.join("Artist").join("Album");
        std::fs::create_dir_all(&album).unwrap_or_default();
        std::fs::write(album.join("01 tone.wav"), wav(8000, 2)).unwrap_or_default();

        let result = scan(&root, HashMap::new());
        assert_eq!(result.errors, 0);
        let track = result.tracks.first().expect("one track");
        assert_eq!(track.artist, "Artist");
        assert_eq!(track.sample_rate, Some(8000));
        let ms = track.duration_ms.expect("duration");
        assert!((1900..=2100).contains(&ms), "duration was {ms} ms");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A library of `names` (WAV files of `seconds` each) under one album folder.
    fn library(tag: &str, names: &[(&str, u32)]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("manplay-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let album = root.join("Artist").join("Album");
        std::fs::create_dir_all(&album).expect("album folder");
        for (name, seconds) in names {
            std::fs::write(album.join(name), wav(8000, *seconds)).expect("song");
        }
        root
    }

    fn by_path(result: &ScanResult) -> HashMap<String, NewTrack> {
        result
            .tracks
            .iter()
            .map(|t| (t.path.clone(), t.clone()))
            .collect()
    }

    /// What a scan remembers of each file, marked so a test can tell a remembered row from a
    /// file that was read again.
    fn remembered(result: &ScanResult) -> HashMap<String, NewTrack> {
        let mut known = by_path(result);
        for track in known.values_mut() {
            track.title = "remembered".to_owned();
        }
        known
    }

    /// Titles in the order the scan gave them, which is the folder's own order.
    fn titles(result: &ScanResult) -> Vec<&str> {
        result.tracks.iter().map(|t| t.title.as_str()).collect()
    }

    #[test]
    fn many_files_come_back_in_walk_order() {
        let names: Vec<String> = (0..40).map(|i| format!("{i:02}.wav")).collect();
        let files: Vec<(&str, u32)> = names.iter().map(|n| (n.as_str(), 1)).collect();
        let root = library("order", &files);

        let result = scan(&root, HashMap::new());
        assert_eq!(result.errors, 0);
        let found: Vec<&str> = result.tracks.iter().map(|t| t.path.as_str()).collect();
        let walked: Vec<String> = WalkDir::new(&root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .filter_map(|e| e.path().to_str().map(str::to_owned))
            .collect();
        assert_eq!(walked.len(), 40);
        assert_eq!(
            found, walked,
            "tracks follow the walk, not the reader that finished first"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unchanged_file_is_not_read_again() {
        let root = library("unchanged", &[("a.wav", 1), ("b.wav", 1)]);
        let first = scan(&root, HashMap::new());

        let second = scan(&root, remembered(&first));
        assert_eq!(second.errors, 0);
        assert_eq!(titles(&second), ["remembered", "remembered"]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_changed_or_new_file_is_read() {
        let root = library("changed", &[("a.wav", 1), ("b.wav", 1)]);
        let first = scan(&root, HashMap::new());
        let album = root.join("Artist").join("Album");
        // A different length is a different size; a new file is not remembered at all.
        std::fs::write(album.join("b.wav"), wav(8000, 2)).expect("rewrite");
        std::fs::write(album.join("c.wav"), wav(8000, 1)).expect("new");

        let second = scan(&root, remembered(&first));
        let mut read = titles(&second);
        read.sort_unstable();
        assert_eq!(read, ["b", "c", "remembered"]);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// What makes a remembered row stale, or not good enough to stand in for the file.
    #[test]
    fn a_remembered_row_is_only_used_for_the_file_it_was_read_from() {
        type Change = fn(&mut NewTrack);
        let stale: [(&str, Change); 3] = [
            ("another time", |t| t.mtime_ms = t.mtime_ms.map(|at| at - 1)),
            ("another size", |t| t.size += 1),
            ("no time kept", |t| t.mtime_ms = None),
        ];
        for (case, change) in stale {
            let root = library("stale", &[("a.wav", 1)]);
            let mut known = remembered(&scan(&root, HashMap::new()));
            known.values_mut().for_each(change);

            let again = scan(&root, known);
            assert_eq!(titles(&again), ["a"], "{case}");

            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn remembered_files_still_count_toward_the_suggested_values() {
        let root = library("values", &[("a.wav", 1), ("b.wav", 1)]);
        let mut known = remembered(&scan(&root, HashMap::new()));
        for track in known.values_mut() {
            track.fields =
                Some(r#"{"genre":"House; Disco","label":"Low Tide","year":"2024"}"#.into());
        }

        let result = scan(&root, known);
        assert_eq!(result.values.get(&("genre", "House".to_owned())), Some(&2));
        assert_eq!(result.values.get(&("genre", "Disco".to_owned())), Some(&2));
        assert_eq!(
            result.values.get(&("label", "Low Tide".to_owned())),
            Some(&2)
        );
        // Year is listed for the song lists but is not a field with suggestions.
        assert!(result.values.keys().all(|(field, _)| *field != "year"));

        let _ = std::fs::remove_dir_all(&root);
    }
}
