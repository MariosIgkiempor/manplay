//! Edits to the playlists on a CDJ USB drive: rename, delete, create, move, and remove songs.
//!
//! Each edit reads the drive's `export.pdb`, changes its playlist tree and writes it back whole,
//! with a higher sequence number so players notice. Songs and their files are never touched: a
//! song taken out of every playlist stays on the drive, as it does in rekordbox. The first edit
//! of a day keeps a copy of the database it started from, and rekordbox's `OneLibrary` files are
//! moved aside so every player reads the edited library.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::Path;

use serde::Deserialize;

use crate::pdb::{self, Library, Playlist};
use crate::usb::PDB_PATH;
use crate::usb_export::{back_up, write_atomic};

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

/// Reads the drive's library, applies `edit` and writes it back.
pub fn edit(mount: &Path, edit: Edit, stamp: &str) -> Result<Outcome, String> {
    let path = mount.join(PDB_PATH);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err("This drive has no rekordbox library yet.".into());
        }
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let mut lib = pdb::read(&bytes)
        .map_err(|e| format!("The drive's library could not be read, so it was left alone: {e}"))?;
    let sequence = pdb::sequence(&bytes).unwrap_or(1);
    let created = apply(&mut lib, edit)?;
    back_up(mount, stamp).map_err(|e| format!("backing up the library: {e}"))?;
    write_atomic(&path, &pdb::write(&lib, sequence + 1))
        .map_err(|e| format!("writing {}: {e}", path.display()))?;
    Ok(Outcome {
        library: lib,
        created,
    })
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

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

        let out = edit(&mount, Edit::Delete { id: 5 }, "day-edits").expect("edit");
        assert_eq!(ids(&out.library), [1, 2, 3, 4]);
        edit(&mount, Edit::Delete { id: 1 }, "day-edits").expect("edit");

        let now = fs::read(&path).expect("read");
        assert_eq!(pdb::read(&now).expect("parse").playlists, []);
        assert_eq!(pdb::sequence(&now), Some(9));
        let kept =
            fs::read(mount.join("PIONEER/manplay-backup/day-edits/export.pdb")).expect("copy");
        assert_eq!(kept, original);
        let _ = fs::remove_dir_all(&mount);
    }
}
