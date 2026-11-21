//! What the writers of a USB drive's libraries share: paths on the drive, careful file writes,
//! and the drive's playlists as a flat list of names that work as file and folder names.

use crate::pdb::{self, Library};
use crate::usb_export::{safe_name, write_atomic};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The file a drive path (`/Contents/Artist/Album/Song.mp3`) names on the drive at `mount`.
pub fn on_drive(mount: &Path, path: &str) -> PathBuf {
    mount.join(path.trim_start_matches('/'))
}

/// Playlists in the order rekordbox shows them, with folders flattened into the name
/// (`Folder - Playlist`): the player has no folders.
pub fn flattened(lib: &Library) -> Vec<(String, &pdb::Playlist)> {
    fn walk<'a>(
        lib: &'a Library,
        parent: u32,
        prefix: &str,
        seen: &mut HashSet<u32>,
        out: &mut Vec<(String, &'a pdb::Playlist)>,
    ) {
        let mut children: Vec<&pdb::Playlist> = lib
            .playlists
            .iter()
            .filter(|p| p.parent_id == parent)
            .collect();
        children.sort_by_key(|p| p.sort_order);
        for p in children {
            // A library whose folders loop is not walked forever.
            if !seen.insert(p.id) {
                continue;
            }
            let name = format!("{prefix}{}", p.name);
            if p.is_folder {
                walk(lib, p.id, &format!("{name} - "), seen, out);
            } else {
                out.push((name, p));
            }
        }
    }
    let mut out = Vec::new();
    walk(lib, 0, "", &mut HashSet::new(), &mut out);
    out
}

/// A name per playlist that works as a file or folder name, unique ignoring case (FAT32 does).
pub fn playlist_file_names<'a>(names: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut used = HashSet::new();
    names
        .map(|name| {
            let base = safe_name(name, "playlist");
            let mut candidate = base.clone();
            let mut n = 1;
            while !used.insert(candidate.to_lowercase()) {
                n += 1;
                candidate = format!("{base} ({n})");
            }
            candidate
        })
        .collect()
}

/// Names of the plain files in `dir`.
pub fn file_names(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Skips rewriting an identical file: a stick writes slowly and wears.
pub fn write_if_changed(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if fs::metadata(path).is_ok_and(|m| m.len() == bytes.len() as u64)
        && fs::read(path).is_ok_and(|old| old == bytes)
    {
        return Ok(());
    }
    write_atomic(path, bytes)
}

pub fn remove_if_there(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// macOS leaves `._name` files on FAT drives; a player reads `._x.m3u` as a playlist.
pub fn remove_mac_files(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            remove_mac_files(&path);
        } else if entry
            .file_name()
            .to_str()
            .is_some_and(|n| n.starts_with("._") || n == ".DS_Store")
        {
            let _ = fs::remove_file(path);
        }
    }
}
