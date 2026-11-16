//! Removable drives a CDJ can read, and the rekordbox library already on them.

use crate::{onelib, pdb};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Where players look for the database, relative to the drive root.
pub const PDB_PATH: &str = "PIONEER/rekordbox/export.pdb";
pub const ONE_LIBRARY_PATH: &str = "PIONEER/rekordbox/exportLibrary.db";

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

/// Values of a flat `diskutil info -plist` dictionary.
#[derive(Debug, Default)]
struct DiskInfo(HashMap<String, String>);

impl DiskInfo {
    fn parse(xml: &str) -> Option<Self> {
        // diskutil's output starts with a <!DOCTYPE plist …> line.
        let options = roxmltree::ParsingOptions {
            allow_dtd: true,
            ..roxmltree::ParsingOptions::default()
        };
        let doc = roxmltree::Document::parse_with_options(xml, options).ok()?;
        let dict = doc.descendants().find(|n| n.has_tag_name("dict"))?;
        let mut map = HashMap::new();
        let mut key = None;
        for child in dict.children().filter(roxmltree::Node::is_element) {
            if child.has_tag_name("key") {
                key = child.text().map(str::to_owned);
            } else if let Some(k) = key.take() {
                let value = match child.tag_name().name() {
                    "true" => "true".to_owned(),
                    "false" => "false".to_owned(),
                    _ => child.text().unwrap_or_default().to_owned(),
                };
                map.insert(k, value);
            }
        }
        Some(Self(map))
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(String::as_str)
    }

    fn flag(&self, key: &str) -> bool {
        self.get(key) == Some("true")
    }

    fn number(&self, key: &str) -> u64 {
        self.get(key).and_then(|v| v.parse().ok()).unwrap_or(0)
    }

    /// External, physical, and not the startup disk or a mounted disk image.
    fn is_removable(&self) -> bool {
        let external =
            self.flag("RemovableMediaOrExternalDevice") || self.get("Internal") == Some("false");
        external
            && self.get("BusProtocol") != Some("Disk Image")
            && self.get("MountPoint") != Some("/")
    }
}

fn disk_info(mount: &Path) -> Option<DiskInfo> {
    let out = Command::new("diskutil")
        .arg("info")
        .arg("-plist")
        .arg(mount)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    DiskInfo::parse(&String::from_utf8_lossy(&out.stdout))
}

fn drive(mount: PathBuf, info: &DiskInfo) -> Drive {
    let name = info
        .get("VolumeName")
        .filter(|n| !n.is_empty())
        .map(str::to_owned)
        .or_else(|| mount.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let rekordbox = mount.join("PIONEER/rekordbox");
    let id = info
        .get("VolumeUUID")
        .filter(|u| !u.is_empty())
        .map_or_else(|| format!("name:{name}"), str::to_owned);
    Drive {
        id,
        name,
        filesystem: info.get("FilesystemType").unwrap_or_default().to_owned(),
        total_bytes: info.number("TotalSize"),
        free_bytes: info
            .number("FreeSpace")
            .max(info.number("APFSContainerFree")),
        writable: info.flag("Writable") || info.flag("WritableVolume"),
        has_library: rekordbox.join("export.pdb").is_file(),
        has_one_library: mount.join(ONE_LIBRARY_PATH).is_file(),
        mount,
    }
}

/// Every mounted removable drive, by name.
pub fn list() -> Vec<Drive> {
    let Ok(entries) = std::fs::read_dir("/Volumes") else {
        return Vec::new();
    };
    let mut drives: Vec<Drive> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            // The startup disk appears here as a symlink to "/".
            !p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with('.'))
                && std::fs::canonicalize(p).is_ok_and(|c| c != Path::new("/"))
        })
        .filter_map(|mount| {
            let info = disk_info(&mount)?;
            info.is_removable().then(|| drive(mount, &info))
        })
        .collect();
    drives.sort_by_key(|d| d.name.to_lowercase());
    drives
}

/// The rekordbox library on a drive, or an empty one if it has none yet.
pub fn library(mount: &Path) -> Result<pdb::Library, String> {
    let path = mount.join(PDB_PATH);
    match std::fs::read(&path) {
        Ok(bytes) => pdb::read(&bytes).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(pdb::Library::default()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Size of one of the drive's libraries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub tracks: usize,
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
    /// Why a file that is there could not be read.
    pub device_library_error: Option<String>,
    pub one_library_error: Option<String>,
}

/// Reads both libraries on a drive (the `OneLibrary` from a temporary copy).
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
    f
}

/// Only paths under `/Volumes` may be read or written as drives.
pub fn check_mount(mount: &Path) -> Result<(), String> {
    let ok = mount.starts_with("/Volumes")
        && mount.components().count() == 3
        && list().iter().any(|d| d.mount == mount);
    if ok {
        Ok(())
    } else {
        Err(format!("{} is not a connected USB drive", mount.display()))
    }
}

/// Unmounts the drive so it can be unplugged. Fails while another app has a file on it open.
pub fn eject(mount: &Path) -> Result<(), String> {
    let out = Command::new("diskutil")
        .arg("eject")
        .arg(mount)
        .output()
        .map_err(|e| format!("diskutil: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let why = String::from_utf8_lossy(&out.stderr).trim().to_owned();
    Err(if why.is_empty() {
        "The drive could not be ejected. Close any app using it and try again.".to_owned()
    } else {
        why
    })
}

/// Opens the drive in Finder.
pub fn reveal(mount: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(mount)
        .status()
        .map_err(|e| e.to_string())
        .and_then(|s| {
            s.success()
                .then_some(())
                .ok_or_else(|| "Finder could not open the drive.".to_owned())
        })
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

    const PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>BusProtocol</key><string>USB</string>
  <key>FilesystemType</key><string>msdos</string>
  <key>FreeSpace</key><integer>23035772928</integer>
  <key>Internal</key><false/>
  <key>MountPoint</key><string>/Volumes/NOCTURN</string>
  <key>RemovableMediaOrExternalDevice</key><true/>
  <key>TotalSize</key><integer>30769053696</integer>
  <key>VolumeName</key><string>NOCTURN</string>
  <key>Writable</key><true/>
</dict></plist>"#;

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

    #[test]
    fn reads_diskutil_output() {
        let info = DiskInfo::parse(PLIST).expect("parses");
        assert!(info.is_removable());
        let d = drive(PathBuf::from("/Volumes/NOCTURN"), &info);
        assert_eq!(d.name, "NOCTURN");
        assert_eq!(d.filesystem, "msdos");
        assert_eq!(d.free_bytes, 23_035_772_928);
        assert_eq!(d.total_bytes, 30_769_053_696);
        assert!(d.writable);
    }

    #[test]
    fn skips_disk_images_and_internal_disks() {
        let image = PLIST.replace("<string>USB</string>", "<string>Disk Image</string>");
        assert!(!DiskInfo::parse(&image).expect("parses").is_removable());
        let internal = PLIST
            .replace("<key>Internal</key><false/>", "<key>Internal</key><true/>")
            .replace(
                "<key>RemovableMediaOrExternalDevice</key><true/>",
                "<key>RemovableMediaOrExternalDevice</key><false/>",
            );
        assert!(!DiskInfo::parse(&internal).expect("parses").is_removable());
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
