//! The whole files of streamed songs, kept in the app's cache folder after they were played (or
//! were next in the queue), so playing or seeking in them again needs no destination. The cache
//! has a size the person chooses; the songs played longest ago go first. A cached file never
//! counts as kept: the song stays streamed (`db::FileState::Streamed`).
//!
//! A file is named by the song's audio (`audio_fp`), so a rename on the destination does not
//! fetch it again. Only this module deletes files here, and only inside the cache folder.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use rusqlite::Connection;
use serde::Serialize;

use crate::db;
use crate::error::Error;

/// A size in bytes.
pub type Bytes = u64;

/// One GB as the app shows sizes (`formatBytes` in `format.ts`): 1024³ bytes.
pub const GB: Bytes = 1024 * 1024 * 1024;
/// 5 GB.
pub const DEFAULT_LIMIT: Bytes = 5 * GB;
/// The smallest cache that may be set: room for a few long mixes.
pub const MIN_LIMIT: Bytes = GB;
/// The largest: 1 TB.
pub const MAX_LIMIT: Bytes = 1024 * GB;

const SETTING_LIMIT: &str = "stream_cache_bytes";

/// What a download that has not finished yet is named, after the file it becomes.
const PART: &str = ".manplay-part";

/// How big the cache may grow.
pub fn limit(conn: &Connection) -> Result<Bytes, Error> {
    Ok(db::get_setting(conn, SETTING_LIMIT)?
        .and_then(|v| v.parse::<Bytes>().ok())
        .map_or(DEFAULT_LIMIT, |v| v.clamp(MIN_LIMIT, MAX_LIMIT)))
}

/// Sets how big the cache may grow; a size outside [`MIN_LIMIT`]..=[`MAX_LIMIT`] is refused.
pub fn set_limit(conn: &Connection, bytes: Bytes) -> Result<(), Error> {
    if !(MIN_LIMIT..=MAX_LIMIT).contains(&bytes) {
        return Err(Error::Msg(format!(
            "the stream cache can be {} to {} GB",
            MIN_LIMIT / GB,
            MAX_LIMIT / GB
        )));
    }
    db::set_setting(conn, SETTING_LIMIT, Some(&bytes.to_string()))
}

/// How full the cache is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub used: Bytes,
    pub limit: Bytes,
}

/// Files that must stay while something (a USB export) is about to read them.
static PINNED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Keeps files in the cache until it is dropped: [`StreamCache::trim`] passes them by.
#[derive(Debug)]
pub struct Pins(Vec<PathBuf>);

impl Drop for Pins {
    fn drop(&mut self) {
        if let Ok(mut pinned) = PINNED.lock() {
            for file in &self.0 {
                if let Some(at) = pinned.iter().position(|p| p == file) {
                    pinned.swap_remove(at);
                }
            }
        }
    }
}

fn is_pinned(file: &Path) -> bool {
    PINNED
        .lock()
        .map_or(true, |pinned| pinned.iter().any(|p| p == file))
}

/// The cache folder.
#[derive(Debug, Clone)]
pub struct StreamCache {
    dir: PathBuf,
}

impl StreamCache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Where the file of the song with audio `audio_fp` and file extension `ext` is kept, or
    /// `None` when either is not something a file name can safely hold (both come from other
    /// devices through the shared library).
    pub fn file_for(&self, audio_fp: &str, ext: &str) -> Option<PathBuf> {
        let fp_ok = !audio_fp.is_empty()
            && audio_fp.len() <= 128
            && audio_fp
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == ':');
        let ext_ok =
            !ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric());
        (fp_ok && ext_ok).then(|| {
            self.dir.join(format!(
                "{}.{}",
                audio_fp.replace(':', "_"),
                ext.to_ascii_lowercase()
            ))
        })
    }

    /// The cached file, if it is there; it then counts as just played.
    pub fn cached(&self, audio_fp: &str, ext: &str) -> Option<PathBuf> {
        let file = self.file_for(audio_fp, ext)?;
        let opened = std::fs::File::options().write(true).open(&file).ok()?;
        if let Err(e) = opened.set_modified(SystemTime::now()) {
            log::info!("could not mark {} as played: {e}", file.display());
        }
        Some(file)
    }

    /// The cached file, if it is there, without counting it as played (for its cover).
    pub fn peek(&self, audio_fp: &str, ext: &str) -> Option<PathBuf> {
        self.file_for(audio_fp, ext).filter(|file| file.is_file())
    }

    /// Keeps the cache files of these songs (`(audio_fp, extension)`), downloaded or not yet,
    /// from being trimmed until the returned [`Pins`] is dropped.
    pub fn pin<'a>(&self, songs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Pins {
        let files: Vec<PathBuf> = songs
            .into_iter()
            .filter_map(|(fp, ext)| self.file_for(fp, ext))
            .collect();
        if let Ok(mut pinned) = PINNED.lock() {
            pinned.extend(files.iter().cloned());
        }
        Pins(files)
    }

    /// The files in the cache, finished ones only, with their sizes and when each was last used.
    fn files(&self) -> Vec<(PathBuf, Bytes, SystemTime)> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        entries
            .filter_map(Result::ok)
            .filter(|e| !e.file_name().to_string_lossy().ends_with(PART))
            .filter_map(|e| {
                let meta = e.metadata().ok().filter(std::fs::Metadata::is_file)?;
                Some((e.path(), meta.len(), meta.modified().ok()?))
            })
            .collect()
    }

    pub fn usage(&self, limit: Bytes) -> Usage {
        Usage {
            used: self.files().iter().map(|(_, size, _)| size).sum(),
            limit,
        }
    }

    /// Removes the files used longest ago until the cache fits in `limit`, never `keep` (the
    /// song just fetched) or a pinned file. Returns how many went.
    pub fn trim(&self, limit: Bytes, keep: Option<&Path>) -> usize {
        let mut files = self.files();
        let mut used: Bytes = files.iter().map(|(_, size, _)| size).sum();
        files.sort_by_key(|(_, _, used_at)| *used_at);
        let mut removed = 0;
        for (path, size, _) in files {
            if used <= limit {
                break;
            }
            if Some(path.as_path()) == keep || is_pinned(&path) {
                continue;
            }
            match std::fs::remove_file(&path) {
                Ok(()) => {
                    used = used.saturating_sub(size);
                    removed += 1;
                }
                Err(e) => log::info!("could not remove {} from the cache: {e}", path.display()),
            }
        }
        removed
    }

    /// Removes every file in the cache, unfinished downloads too.
    pub fn empty(&self) -> Result<(), Error> {
        match std::fs::read_dir(&self.dir) {
            Ok(entries) => {
                for entry in entries.filter_map(Result::ok) {
                    if entry.file_type().is_ok_and(|t| t.is_file()) {
                        std::fs::remove_file(entry.path())?;
                    }
                }
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    fn cache(name: &str) -> StreamCache {
        let dir = std::env::temp_dir().join(format!(
            "manplay-stream-cache-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        StreamCache::new(dir)
    }

    /// A cached file of `size` bytes last used `age` seconds ago.
    fn put(cache: &StreamCache, fp: &str, size: usize, age: u64) -> PathBuf {
        let path = cache.file_for(fp, "mp3").expect("name");
        std::fs::write(&path, vec![0u8; size]).expect("write");
        let when = SystemTime::now() - std::time::Duration::from_secs(age);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .and_then(|f| f.set_modified(when))
            .expect("age");
        path
    }

    #[test]
    fn a_file_name_is_made_only_of_what_a_file_name_can_hold() {
        let cache = StreamCache::new(PathBuf::from("/cache"));
        let cases: [(&str, &str, Option<&str>); 7] = [
            ("a1:00ff", "mp3", Some("/cache/a1_00ff.mp3")),
            ("a1:00ff", "FLAC", Some("/cache/a1_00ff.flac")),
            ("../../etc", "mp3", None),
            ("a1:00ff/x", "mp3", None),
            ("", "mp3", None),
            ("a1:00ff", "", None),
            ("a1:00ff", "mp3/..", None),
        ];
        for (fp, ext, want) in cases {
            assert_eq!(
                cache.file_for(fp, ext),
                want.map(PathBuf::from),
                "{fp} {ext}"
            );
        }
    }

    #[test]
    fn the_songs_played_longest_ago_go_first_and_the_one_just_fetched_stays() {
        let cache = cache("trim");
        let oldest = put(&cache, "a1:01", 100, 300);
        let older = put(&cache, "a1:02", 100, 200);
        let newest = put(&cache, "a1:03", 100, 100);
        assert_eq!(cache.usage(0).used, 300);
        assert_eq!(cache.trim(200, None), 1);
        assert!(!oldest.exists());
        assert!(older.exists());
        assert_eq!(
            cache.trim(0, Some(&newest)),
            1,
            "all but the one being played"
        );
        assert!(newest.exists());
        assert!(!older.exists());
    }

    #[test]
    fn pinned_files_stay_through_a_trim_until_the_pins_are_dropped() {
        let cache = cache("pins");
        let oldest = put(&cache, "a1:01", 100, 300);
        let older = put(&cache, "a1:02", 100, 200);
        let newest = put(&cache, "a1:03", 100, 100);
        let pins = cache.pin([("a1:01", "mp3"), ("a1:02", "mp3")]);
        assert_eq!(cache.trim(0, None), 1, "only the one nobody pinned");
        assert!(oldest.exists() && older.exists());
        assert!(!newest.exists());
        drop(pins);
        assert_eq!(cache.trim(0, None), 2);
        assert!(!oldest.exists() && !older.exists());
    }

    #[test]
    fn a_file_pinned_twice_stays_until_both_pins_are_dropped() {
        let cache = cache("pins-twice");
        let song = put(&cache, "a1:01", 100, 300);
        let first = cache.pin([("a1:01", "mp3")]);
        let second = cache.pin([("a1:01", "mp3")]);
        drop(first);
        assert_eq!(cache.trim(0, None), 0);
        drop(second);
        assert_eq!(cache.trim(0, None), 1);
        assert!(!song.exists());
    }

    #[test]
    fn a_song_played_again_moves_to_the_back_of_the_line() {
        let cache = cache("touch");
        let first = put(&cache, "a1:01", 100, 300);
        let second = put(&cache, "a1:02", 100, 200);
        assert_eq!(cache.cached("a1:01", "mp3"), Some(first.clone()));
        cache.trim(100, None);
        assert!(first.exists(), "played just now");
        assert!(!second.exists());
        assert_eq!(cache.cached("a1:09", "mp3"), None, "not cached");
    }

    #[test]
    fn unfinished_downloads_do_not_count_and_emptying_removes_everything() {
        let cache = cache("empty");
        put(&cache, "a1:01", 100, 10);
        std::fs::write(cache.dir().join(format!("a1_02.mp3{PART}")), [0u8; 50]).expect("part");
        assert_eq!(cache.usage(0).used, 100);
        cache.empty().expect("empty");
        assert_eq!(std::fs::read_dir(cache.dir()).expect("dir").count(), 0);
    }

    #[test]
    fn the_size_limit_is_kept_within_bounds() {
        let conn = db::open(Path::new(":memory:")).expect("db");
        assert_eq!(limit(&conn).expect("limit"), DEFAULT_LIMIT);
        let cases: [(Bytes, bool); 5] = [
            (MIN_LIMIT, true),
            (20 * GB, true),
            (MAX_LIMIT, true),
            (MIN_LIMIT - 1, false),
            (MAX_LIMIT + 1, false),
        ];
        for (bytes, ok) in cases {
            assert_eq!(set_limit(&conn, bytes).is_ok(), ok, "{bytes}");
            if ok {
                assert_eq!(limit(&conn).expect("limit"), bytes);
            }
        }
    }
}
