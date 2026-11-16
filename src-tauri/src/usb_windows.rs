//! Drives on Windows: drive letters other than the system drive that are removable or sit on a
//! USB/SD bus (external SSDs report themselves as fixed disks).

use super::{Drive, ONE_LIBRARY_PATH};
use crate::process::command;
use std::collections::HashMap;
use std::path::{Component, Path, Prefix};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use sysinfo::Disks;

/// The drive letter of `path`, upper-cased.
fn letter(path: &Path) -> Option<u8> {
    match path.components().next()? {
        Component::Prefix(p) => match p.kind() {
            Prefix::Disk(l) | Prefix::VerbatimDisk(l) => Some(l.to_ascii_uppercase()),
            _ => None,
        },
        _ => None,
    }
}

/// The drive Windows runs from, usually `C`.
fn system_drive() -> u8 {
    std::env::var("SystemDrive")
        .ok()
        .and_then(|d| d.bytes().next())
        .map_or(b'C', |b| b.to_ascii_uppercase())
}

/// A drive's root: `E:\`.
pub fn is_mount_point(mount: &Path) -> bool {
    let mut c = mount.components();
    letter(mount).is_some()
        && c.next().is_some()
        && matches!(c.next(), Some(Component::RootDir))
        && c.next().is_none()
}

pub fn on_drive(path: &Path) -> bool {
    letter(path).is_some_and(|l| l != system_drive())
}

/// Whether a fixed disk is attached over USB or a card reader. Asking PowerShell takes a moment,
/// so answers are kept per drive letter and volume serial for as long as the app runs.
fn on_external_bus(mount: &Path, serial: Option<u64>) -> bool {
    static SEEN: LazyLock<Mutex<HashMap<(u8, Option<u64>), bool>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    let Some(l) = letter(mount) else {
        return false;
    };
    if let Some(known) = SEEN.lock().ok().and_then(|m| m.get(&(l, serial)).copied()) {
        return known;
    }
    let script = format!(
        "(Get-Partition -DriveLetter {} | Get-Disk).BusType",
        l as char
    );
    let external = command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .is_some_and(|o| {
            matches!(
                String::from_utf8_lossy(&o.stdout).trim(),
                "USB" | "SD" | "MMC" | "1394"
            )
        });
    if let Ok(mut m) = SEEN.lock() {
        m.insert((l, serial), external);
    }
    external
}

/// Every mounted removable drive, by name.
pub fn list() -> Vec<Drive> {
    let system = system_drive();
    let Ok(disks) = Disks::new_with_refreshed_list() else {
        return Vec::new();
    };
    let mut drives: Vec<Drive> = disks
        .iter()
        .filter(|d| {
            let mount = d.mount_point();
            is_mount_point(mount)
                && letter(mount) != Some(system)
                && (d.is_removable() || on_external_bus(mount, d.id()))
        })
        .map(|d| {
            let mount = d.mount_point().to_path_buf();
            let label = d.name().to_string_lossy().trim().to_owned();
            let name = if label.is_empty() {
                format!("USB Drive ({}:)", letter(&mount).map_or('?', char::from))
            } else {
                label
            };
            let id = d.id().map_or_else(
                || format!("name:{name}"),
                |s| format!("{:04X}-{:04X}", s >> 16 & 0xFFFF, s & 0xFFFF),
            );
            Drive {
                id,
                filesystem: d.file_system().to_string_lossy().to_lowercase(),
                total_bytes: d.total_space(),
                free_bytes: d.available_space(),
                writable: !d.is_read_only(),
                has_library: mount.join(super::PDB_PATH).is_file(),
                has_one_library: mount.join(ONE_LIBRARY_PATH).is_file(),
                name,
                mount,
            }
        })
        .collect();
    drives.sort_by_key(|d| d.name.to_lowercase());
    drives
}

/// Asks Explorer to eject the drive (what "Eject" in its menu does), then waits for it to go.
/// Fails while another app has a file on it open.
pub fn eject(mount: &Path) -> Result<(), String> {
    let l = letter(mount).ok_or_else(|| format!("{} is not a drive", mount.display()))?;
    let script = format!(
        "$d = (New-Object -ComObject Shell.Application).Namespace(17).ParseName('{}:'); \
         if ($d) {{ $d.InvokeVerb('Eject') }} else {{ exit 2 }}",
        l as char
    );
    let out = command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("powershell: {e}"))?;
    if out.status.success() {
        // The verb returns before Windows has finished flushing and unmounting.
        for _ in 0..40 {
            if !mount.exists() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    Err(
        "Windows could not eject the drive. Close any app using it and try again, or use \
         Safely Remove Hardware in the taskbar."
            .to_owned(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_drive_roots() {
        assert!(is_mount_point(Path::new(r"E:\")));
        assert!(!is_mount_point(Path::new(r"E:\Music")));
        assert!(!is_mount_point(Path::new("E:")));
        assert!(on_drive(Path::new(r"E:\Contents\a.mp3")));
        assert!(!on_drive(Path::new(r"\\server\share\a.mp3")));
    }
}
