//! Edits to the playlists on a CDJ USB drive: rename, delete, create, move, and remove songs.
//!
//! Each edit reads the drive's library (`export.pdb`, plus anything only its `OneLibrary` has),
//! changes its playlist tree and writes both databases back, as an export does, so every player
//! reads the same playlists. No song is deleted: a song taken out of every playlist stays on the
//! drive, as it does in rekordbox. On a drive with playlist folders the songs follow their
//! playlists (see [`playlist_folders`]), and a Gemini library there is rewritten to match. The
//! first edit of a day keeps a copy of the databases it started from.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::gemini;
use crate::pdb::{Library, Playlist};
use crate::playlist_folders;
use crate::usb_export::{has_library, has_rekordbox, read_libraries, write_libraries};

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Edit {
    Rename {
        id: u32,
        name: String,
    },
    /// A folder goes with everything in it.
    Delete {
        id: u32,
    },
    Create {
        parent_id: u32,
        name: String,
        folder: bool,
    },
    /// To the end of `parent_id` (0 for the top level).
    Move {
        id: u32,
        parent_id: u32,
    },
    /// Entries by their 0-based place in the playlist, since a song can be in it twice.
    RemoveTracks {
        playlist_id: u32,
        positions: Vec<usize>,
    },
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give it a name.".into());
    }
    Ok(name.to_owned())
}

fn find(lib: &mut Library, id: u32) -> Result<&mut Playlist, String> {
    lib.playlists
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| "That playlist is no longer on the drive.".to_owned())
}

/// `id` and every playlist and folder under it.
fn subtree(lib: &Library, id: u32) -> HashSet<u32> {
    let mut out = HashSet::from([id]);
    loop {
        let before = out.len();
        for p in &lib.playlists {
            if out.contains(&p.parent_id) {
                out.insert(p.id);
            }
        }
        if out.len() == before {
            return out;
        }
    }
}

fn check_folder(lib: &Library, parent_id: u32) -> Result<(), String> {
    if parent_id == 0
        || lib
            .playlists
            .iter()
            .any(|p| p.id == parent_id && p.is_folder)
    {
        Ok(())
    } else {
        Err("That folder is no longer on the drive.".into())
    }
}

fn next_sort(lib: &Library, parent_id: u32) -> u32 {
    lib.playlists
        .iter()
        .filter(|p| p.parent_id == parent_id)
        .map(|p| p.sort_order + 1)
        .max()
        .unwrap_or(0)
}

/// Applies `edit` to `lib`; returns the id of a created playlist.
pub fn apply(lib: &mut Library, edit: Edit) -> Result<Option<u32>, String> {
    match edit {
        Edit::Rename { id, name } => {
            find(lib, id)?.name = clean_name(&name)?;
        }
        Edit::Delete { id } => {
            find(lib, id)?;
            let gone = subtree(lib, id);
            lib.playlists.retain(|p| !gone.contains(&p.id));
        }
        Edit::Create {
            parent_id,
            name,
            folder,
        } => {
            check_folder(lib, parent_id)?;
            let id = lib.playlists.iter().map(|p| p.id).max().unwrap_or(0) + 1;
            lib.playlists.push(Playlist {
                id,
                parent_id,
                name: clean_name(&name)?,
                is_folder: folder,
                sort_order: next_sort(lib, parent_id),
                track_ids: Vec::new(),
            });
            return Ok(Some(id));
        }
        Edit::Move { id, parent_id } => {
            check_folder(lib, parent_id)?;
            if subtree(lib, id).contains(&parent_id) {
                return Err("A folder can't go inside itself.".into());
            }
            let sort = next_sort(lib, parent_id);
            let p = find(lib, id)?;
            if p.parent_id != parent_id {
                p.parent_id = parent_id;
                p.sort_order = sort;
            }
        }
        Edit::RemoveTracks {
            playlist_id,
            positions,
        } => {
            let p = find(lib, playlist_id)?;
            let drop: HashSet<usize> = positions.into_iter().collect();
            p.track_ids = p
                .track_ids
                .iter()
                .enumerate()
                .filter(|(i, _)| !drop.contains(i))
                .map(|(_, t)| *t)
                .collect();
        }
    }
    Ok(None)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub library: Library,
    pub created: Option<u32>,
}

/// Reads the drive's library, applies `edit` and writes it back as both databases.
pub fn edit(mount: &Path, edit: Edit, stamp: &str, today: &str) -> Result<Outcome, String> {
    if !has_library(mount) {
        return Err("This drive has no library yet.".into());
    }
    let rekordbox = has_rekordbox(mount);
    let (mut lib, sequence) = read_libraries(mount)?;
    let created = apply(&mut lib, edit)?;
    // A drive with playlist folders or a Gemini library keeps them in step with its playlists.
    let arrangement = playlist_folders::move_homes(mount, &mut lib, playlist_folders::is_on(mount));
    let unmoved = arrangement
        .failed
        .first()
        .map(|(path, error)| format!("{path}: {error}"));
    let (_, one) = write_libraries(mount, &lib, sequence, stamp, today, rekordbox)?;
    one.map_err(|e| format!("The Device Library was saved, but the OneLibrary was not: {e}"))?;
    let (_, copies) = arrangement
        .fill(mount, &lib, |_, _, _| {})
        .map_err(|e| format!("The playlists were saved, but their folders were not: {e}"))?;
    if gemini::present(mount) {
        gemini::write(mount, &lib, &HashMap::new(), stamp, &copies).map_err(|e| {
            format!("The rekordbox libraries were saved, but the Gemini library was not: {e}")
        })?;
    }
    if let Some(unmoved) = unmoved {
        return Err(format!(
            "The playlists were saved, but a song could not be moved to its playlist folder: {unmoved}"
        ));
    }
    Ok(Outcome {
        library: lib,
        created,
    })
}

/// What a reset clears: everything rekordbox and manplay export (the libraries, the analysis
/// files, artwork, the songs in `Contents` and the playlist folders) and the libraries other
/// players keep of those songs (Gemini's, `VirtualDJ`'s, and Serato's with its backups), which would otherwise
/// list songs that are gone. Player settings (`*SETTING.DAT`, `djprofile.nxs`), manplay's
/// backups and anything else on the drive stay, so the `PIONEER` folder itself does too.
/// `.manplay` is manplay's own record of what it put on the drive.
pub const RESET_PATHS: [&str; 11] = [
    "Contents",
    "Playlists",
    "GEMINI",
    "_Serato_",
    "_Serato_Backup",
    "VirtualDJ",
    "PIONEER/rekordbox",
    "PIONEER/USBANLZ",
    "PIONEER/Artwork",
    "PIONEER/extracted",
    ".manplay",
];

/// The parts of [`RESET_PATHS`] that exist on the drive at `mount`.
pub fn reset_targets(mount: &Path) -> Vec<PathBuf> {
    RESET_PATHS
        .iter()
        .map(|rel| mount.join(rel))
        .filter(|p| p.symlink_metadata().is_ok())
        .collect()
}

/// Moves the drive's exported library and songs to its Trash (see [`RESET_PATHS`]), so the drive
/// reads as empty to players and the next export starts fresh. Returns how many folders moved.
pub fn reset(mount: &Path) -> Result<usize, String> {
    let targets = reset_targets(mount);
    if targets.is_empty() {
        return Ok(0);
    }
    let n = targets.len();
    trash::delete_all(targets).map_err(|e| format!("could not move to the Trash: {e}"))?;
    Ok(n)
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;
    use crate::pdb;
    use crate::usb::{ONE_LIBRARY_PATH, PDB_PATH};
    use std::fs;

    fn list(id: u32, parent_id: u32, name: &str, folder: bool, tracks: &[u32]) -> Playlist {
        Playlist {
            id,
            parent_id,
            name: name.into(),
            is_folder: folder,
            sort_order: id,
            track_ids: tracks.to_vec(),
        }
    }

    fn lib() -> Library {
        Library {
            tracks: Vec::new(),
            playlists: vec![
                list(1, 0, "Sets", true, &[]),
                list(2, 1, "Friday", false, &[10, 11, 10]),
                list(3, 1, "Warmup", true, &[]),
                list(4, 3, "Deep", false, &[12]),
                list(5, 0, "Loose", false, &[13]),
            ],
            artwork: Vec::new(),
        }
    }

    fn ids(lib: &Library) -> Vec<u32> {
        lib.playlists.iter().map(|p| p.id).collect()
    }

    #[test]
    fn deleting_a_folder_takes_its_contents() {
        let mut l = lib();
        apply(&mut l, Edit::Delete { id: 1 }).expect("delete");
        assert_eq!(ids(&l), [5]);
    }

    #[test]
    fn renames_trim_and_refuse_blanks() {
        let mut l = lib();
        apply(
            &mut l,
            Edit::Rename {
                id: 5,
                name: "  Late ".into(),
            },
        )
        .expect("rename");
        assert_eq!(l.playlists[4].name, "Late");
        assert!(
            apply(
                &mut l,
                Edit::Rename {
                    id: 5,
                    name: " ".into()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn creates_at_the_end_of_a_folder() {
        let mut l = lib();
        let id = apply(
            &mut l,
            Edit::Create {
                parent_id: 1,
                name: "Saturday".into(),
                folder: false,
            },
        )
        .expect("create");
        let p = l.playlists.last().expect("new");
        assert_eq!((id, p.parent_id, p.sort_order), (Some(6), 1, 4));
        assert!(
            apply(
                &mut l,
                Edit::Create {
                    parent_id: 5,
                    name: "x".into(),
                    folder: false
                }
            )
            .is_err(),
            "a playlist is not a folder"
        );
    }

    #[test]
    fn folders_cannot_move_into_themselves() {
        let mut l = lib();
        assert!(
            apply(
                &mut l,
                Edit::Move {
                    id: 1,
                    parent_id: 3
                }
            )
            .is_err()
        );
        apply(
            &mut l,
            Edit::Move {
                id: 4,
                parent_id: 0,
            },
        )
        .expect("move");
        assert_eq!(l.playlists[3].parent_id, 0);
    }

    #[test]
    fn removes_entries_by_place() {
        let mut l = lib();
        apply(
            &mut l,
            Edit::RemoveTracks {
                playlist_id: 2,
                positions: vec![2],
            },
        )
        .expect("remove");
        assert_eq!(l.playlists[1].track_ids, [10, 11]);
    }

    #[test]
    fn edits_write_the_drive_and_keep_the_first_copy() {
        let mount = std::env::temp_dir().join(format!("manplay-usb-edit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&mount);
        let path = mount.join(PDB_PATH);
        fs::create_dir_all(path.parent().expect("dir")).expect("mkdir");
        let original = pdb::write(&lib(), 7);
        fs::write(&path, &original).expect("pdb");

        let out = edit(&mount, Edit::Delete { id: 5 }, "day-edits", "2026-11-15").expect("edit");
        assert_eq!(ids(&out.library), [1, 2, 3, 4]);
        edit(&mount, Edit::Delete { id: 1 }, "day-edits", "2026-11-15").expect("edit");

        let now = fs::read(&path).expect("read");
        assert_eq!(pdb::read(&now).expect("parse").playlists, []);
        assert_eq!(pdb::sequence(&now), Some(9));
        let kept =
            fs::read(mount.join("PIONEER/manplay-backup/day-edits/export.pdb")).expect("copy");
        assert_eq!(kept, original);
        // Players that read the newer library see the same (now empty) playlists.
        let one = crate::onelib::read(&mount.join(ONE_LIBRARY_PATH)).expect("OneLibrary");
        assert_eq!(one.playlists, []);
        let _ = fs::remove_dir_all(&mount);
    }

    #[test]
    fn reset_targets_only_what_an_export_writes() {
        let mount = std::env::temp_dir().join(format!("manplay-reset-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&mount);
        for dir in [
            "Contents/A",
            "Playlists/Friday",
            "GEMINI/wf",
            "_Serato_/Subcrates",
            "_Serato_Backup",
            "VirtualDJ/MyLists",
            "PIONEER/rekordbox",
            "PIONEER/USBANLZ/P001",
            "PIONEER/manplay-backup",
            "Music",
        ] {
            std::fs::create_dir_all(mount.join(dir)).expect("mkdir");
        }
        std::fs::write(mount.join("PIONEER/MYSETTING.DAT"), b"x").expect("write");
        let got = reset_targets(&mount);
        assert_eq!(
            got,
            [
                "Contents",
                "Playlists",
                "GEMINI",
                "_Serato_",
                "_Serato_Backup",
                "VirtualDJ",
                "PIONEER/rekordbox",
                "PIONEER/USBANLZ"
            ]
            .map(|p| mount.join(p)),
            "settings, backups and the user's own folders stay"
        );
        let _ = std::fs::remove_dir_all(mount);
    }
}
