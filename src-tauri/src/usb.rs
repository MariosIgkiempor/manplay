//! Removable drives a CDJ can read, and the rekordbox library already on them.

use crate::{onelib, pdb};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Where players look for the database, relative to the drive root.
pub const PDB_PATH: &str = "PIONEER/rekordbox/export.pdb";
pub const ONE_LIBRARY_PATH: &str = "PIONEER/rekordbox/exportLibrary.db";
/// The drive's songs and playlists as manplay keeps them on a drive it writes no rekordbox
/// library to, in `export.pdb`'s format. Every other library on the drive is written from it.
pub const OWN_LIBRARY_PATH: &str = ".manplay/library.pdb";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    /// Stays the same across renames and remounts: the volume's UUID, else `name:<name>`.
    pub id: String,
    pub name: String,
    pub mount: PathBuf,
    pub filesystem: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub writable: bool,
    /// Whether `PIONEER/rekordbox/export.pdb` exists.
    pub has_library: bool,
    /// Whether rekordbox also wrote the newer `OneLibrary` database (`exportLibrary.db`).
    pub has_one_library: bool,
}

#[cfg(target_os = "macos")]
#[path = "usb_mac.rs"]
mod sys;
#[cfg(windows)]
#[path = "usb_windows.rs"]
mod sys;

pub use sys::{eject, list};

/// Only drives listed by [`list`] may be read or written as drives.
pub fn check_mount(mount: &Path) -> Result<(), String> {
    if sys::is_mount_point(mount) && list().iter().any(|d| d.mount == mount) {
        Ok(())
    } else {
        Err(format!("{} is not a connected USB drive", mount.display()))
    }
}

/// Whether `path` is on a removable drive, judged by its location alone (no disk lookups), for
/// the cheap checks that run per request.
pub fn on_drive(path: &Path) -> bool {
    sys::on_drive(path)
}

/// Opens the drive in Finder or Explorer.
pub fn reveal(mount: &Path) -> Result<(), String> {
    tauri_plugin_opener::open_path(mount, None::<&str>).map_err(|e| e.to_string())
}

/// The drive's songs and playlists: its rekordbox library, else the list manplay keeps on a
/// drive without one (see [`OWN_LIBRARY_PATH`]), else nothing yet.
pub fn library(mount: &Path) -> Result<pdb::Library, String> {
    for rel in [PDB_PATH, OWN_LIBRARY_PATH] {
        let path = mount.join(rel);
        match std::fs::read(&path) {
            Ok(bytes) => {
                return pdb::read(&bytes).map_err(|e| format!("{}: {e}", path.display()));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
    }
    Ok(pdb::Library::default())
}

/// Size of one of the drive's libraries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub tracks: usize,
    /// Playlists, or what the format has for them: crates, playlist folders.
    pub playlists: usize,
}

impl Summary {
    fn of(lib: &pdb::Library) -> Self {
        Self {
            tracks: lib.tracks.len(),
            playlists: lib.playlists.iter().filter(|p| !p.is_folder).count(),
        }
    }
}

/// Which library formats a drive holds, and so which players can read it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Formats {
    /// `export.pdb`, read by the CDJ-3000 and older players.
    pub device_library: Option<Summary>,
    /// `exportLibrary.db`, read by the CDJ-3000X, OPUS-QUAD, XDJ-AZ and OMNIS-DUO.
    pub one_library: Option<Summary>,
    /// Serato's `database V2` and crates, read by Serato DJ.
    pub serato: Option<Summary>,
    /// The `GEMINI` library, read by Gemini MDJ players.
    pub gemini: Option<Summary>,
    /// The playlists as folders of songs, for players that only browse folders.
    pub playlist_folders: Option<Summary>,
    /// Why a file that is there could not be read.
    pub device_library_error: Option<String>,
    pub one_library_error: Option<String>,
    pub serato_error: Option<String>,
    pub gemini_error: Option<String>,
}

/// Reads every library on a drive (the SQLite ones from a temporary copy, so nothing is written).
pub fn formats(mount: &Path) -> Formats {
    let mut f = Formats::default();
    if mount.join(PDB_PATH).is_file() {
        match library(mount) {
            Ok(lib) => f.device_library = Some(Summary::of(&lib)),
            Err(e) => f.device_library_error = Some(e),
        }
    }
    let one = mount.join(ONE_LIBRARY_PATH);
    if one.is_file() {
        match onelib::read(&one) {
            Ok(lib) => f.one_library = Some(Summary::of(&lib)),
            Err(e) => f.one_library_error = Some(e),
        }
    }
    let size = |(tracks, playlists)| Summary { tracks, playlists };
    match crate::serato::held(mount) {
        Some(Ok(found)) => f.serato = Some(size(found)),
        Some(Err(e)) => f.serato_error = Some(e),
        None => {}
    }
    match crate::gemini::held(mount) {
        Some(Ok(found)) => f.gemini = Some(size(found)),
        Some(Err(e)) => f.gemini_error = Some(e),
        None => {}
    }
    f.playlist_folders = crate::playlist_folders::held(mount).map(size);
    f
}

/// Where each export and the first edit of a day keep a copy of the databases they replaced.
pub const BACKUP_DIR: &str = "PIONEER/manplay-backup";

/// The copies of earlier libraries manplay kept on a drive.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backups {
    pub count: usize,
    pub bytes: u64,
    /// Folder name of the newest, e.g. `2026-11-15-221530`.
    pub latest: Option<String>,
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(_) => e.metadata().map_or(0, |m| m.len()),
            Err(_) => 0,
        })
        .sum()
}

/// Backup folders, oldest first (their names are dates, so they sort by age).
fn backup_dirs(mount: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(mount.join(BACKUP_DIR)) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    dirs
}

pub fn backups(mount: &Path) -> Backups {
    let dirs = backup_dirs(mount);
    Backups {
        count: dirs.len(),
        bytes: dirs.iter().map(|d| dir_size(d)).sum(),
        latest: dirs
            .last()
            .and_then(|d| d.file_name())
            .map(|n| n.to_string_lossy().into_owned()),
    }
}

/// Deletes all but the newest `keep` backups, for good (the drive's Trash would keep the space
/// taken). Returns what is left.
pub fn delete_backups(mount: &Path, keep: usize) -> Result<Backups, String> {
    let dirs = backup_dirs(mount);
    let drop = dirs.len().saturating_sub(keep);
    for dir in &dirs[..drop] {
        std::fs::remove_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    Ok(backups(mount))
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    #[test]
    fn old_backups_go_and_the_newest_stay() {
        let mount = std::env::temp_dir().join(format!("manplay-backups-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&mount);
        for (stamp, bytes) in [
            ("2026-01-02-100000", 10),
            ("2026-03-01-edits", 20),
            ("2026-02-01-090000", 30),
        ] {
            let dir = mount.join(BACKUP_DIR).join(stamp);
            std::fs::create_dir_all(&dir).expect("dir");
            std::fs::write(dir.join("export.pdb"), vec![0u8; bytes]).expect("file");
        }
        assert_eq!(
            backups(&mount),
            Backups {
                count: 3,
                bytes: 60,
                latest: Some("2026-03-01-edits".into())
            }
        );
        let left = delete_backups(&mount, 1).expect("deletes");
        assert_eq!((left.count, left.bytes), (1, 20));
        assert_eq!(delete_backups(&mount, 1).expect("again").count, 1);
        assert_eq!(delete_backups(&mount, 0).expect("all").count, 0);
        let _ = std::fs::remove_dir_all(&mount);
    }

    #[test]
    fn tells_which_formats_a_drive_has() {
        let usb = std::env::temp_dir().join(format!("manplay-usb-formats-{}", std::process::id()));
        let rb = usb.join("PIONEER/rekordbox");
        std::fs::create_dir_all(&rb).expect("dir");
        assert_eq!(formats(&usb), Formats::default());

        std::fs::write(
            rb.join("exportLibrary.db"),
            include_bytes!("onelib/testdata/rekordbox7.db"),
        )
        .expect("db");
        std::fs::write(rb.join("export.pdb"), b"garbage").expect("pdb");
        let f = formats(&usb);
        assert_eq!(
            f.one_library,
            Some(Summary {
                tracks: 41,
                playlists: 5
            })
        );
        assert_eq!(f.device_library, None);
        assert!(f.device_library_error.is_some());
        let _ = std::fs::remove_dir_all(&usb);
    }

    /// Lists the drives plugged into this machine: `cargo test -- --ignored plugged_in --nocapture`.
    #[test]
    #[ignore = "depends on what is plugged in"]
    fn plugged_in() {
        for d in list() {
            let lib = library(&d.mount);
            println!(
                "{d:?}\n  {} tracks",
                lib.map_or_else(|e| e, |l| l.tracks.len().to_string())
            );
        }
    }
}
