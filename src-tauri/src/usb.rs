//! Removable drives a CDJ can read, and the rekordbox library already on them.

use crate::pdb;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Where players look for the database, relative to the drive root.
pub const PDB_PATH: &str = "PIONEER/rekordbox/export.pdb";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
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
    Drive {
        name,
        filesystem: info.get("FilesystemType").unwrap_or_default().to_owned(),
        total_bytes: info.number("TotalSize"),
        free_bytes: info
            .number("FreeSpace")
            .max(info.number("APFSContainerFree")),
        writable: info.flag("Writable") || info.flag("WritableVolume"),
        has_library: rekordbox.join("export.pdb").is_file(),
        has_one_library: rekordbox.join("exportLibrary.db").is_file(),
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

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

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
