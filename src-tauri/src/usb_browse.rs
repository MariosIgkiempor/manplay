//! Each library a drive holds, as the drive's page browses it: rekordbox's two as they are, and
//! the others (Serato, `VirtualDJ`, Gemini, playlist folders) from their own files. Those name
//! songs only by path, so each song's details come from the drive's main list of songs, by path;
//! a song that list does not have is shown by its file name.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Deserialize;

use crate::pdb::{self, Library};
use crate::usb::{self, ONE_LIBRARY_PATH};

/// A library on a drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    DeviceLibrary,
    OneLibrary,
    Serato,
    VirtualDj,
    Gemini,
    PlaylistFolders,
}

/// A library as its own files hold it: songs and playlists, by path from the drive root
/// (`/Contents/A/B/x.mp3`).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Contents {
    pub songs: Vec<String>,
    /// Each playlist's name and songs, in order.
    pub playlists: Vec<(String, Vec<String>)>,
}

/// The library in `format` on the drive at `mount`; an empty one when the drive has none.
pub fn library(mount: &Path, format: Format) -> Result<Library, String> {
    let other = match format {
        Format::DeviceLibrary => return usb::library(mount),
        Format::OneLibrary => {
            let path = mount.join(ONE_LIBRARY_PATH);
            return if path.is_file() {
                crate::onelib::read(&path)
            } else {
                Ok(Library::default())
            };
        }
        Format::Serato => crate::serato::contents(mount),
        Format::VirtualDj => crate::virtualdj::contents(mount),
        Format::Gemini => crate::gemini::contents(mount),
        Format::PlaylistFolders => crate::playlist_folders::contents(mount).map(Ok),
    };
    let Some(contents) = other.transpose()? else {
        return Ok(Library::default());
    };
    let main = usb::library(mount)?;
    let copies = crate::playlist_folders::copies(mount)
        .into_iter()
        .map(|c| (c.path.to_lowercase(), c.track))
        .collect();
    Ok(assemble(&main, &copies, contents))
}

/// File names on FAT and exFAT ignore case.
fn key(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// A song the main list does not have, known only by its file.
fn unknown(id: u32, path: &str) -> pdb::Track {
    let file = path.rsplit('/').next().unwrap_or(path);
    let title = file.rsplit_once('.').map_or(file, |(stem, _)| stem);
    pdb::Track {
        id,
        title: title.to_owned(),
        path: path.to_owned(),
        ..pdb::Track::default()
    }
}

/// `contents` as a library: songs with the main list's details (a playlist folder's further copy
/// of a song, by `copies`, counts as that song), then the playlists.
fn assemble(main: &Library, copies: &HashMap<String, u32>, contents: Contents) -> Library {
    let by_id: HashMap<u32, &pdb::Track> = main.tracks.iter().map(|t| (t.id, t)).collect();
    let by_path: HashMap<String, &pdb::Track> =
        main.tracks.iter().map(|t| (key(&t.path), t)).collect();
    let mut next = main.tracks.iter().map(|t| t.id).max().unwrap_or(0) + 1;
    let mut ids: HashMap<String, u32> = HashMap::new();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut tracks = Vec::new();
    let mut id_of = |path: &str, tracks: &mut Vec<pdb::Track>| -> u32 {
        let k = key(path);
        if let Some(id) = ids.get(&k) {
            return *id;
        }
        let known = by_path
            .get(&k)
            .copied()
            .or_else(|| copies.get(&k).and_then(|id| by_id.get(id).copied()));
        let id = known.map_or_else(
            || {
                next += 1;
                next - 1
            },
            |t| t.id,
        );
        if seen.insert(id) {
            tracks.push(known.cloned().unwrap_or_else(|| unknown(id, path)));
        }
        ids.insert(k, id);
        id
    };
    for path in &contents.songs {
        id_of(path, &mut tracks);
    }
    let playlists = contents
        .playlists
        .into_iter()
        .zip(1u32..)
        .map(|((name, paths), id)| pdb::Playlist {
            id,
            parent_id: 0,
            name,
            is_folder: false,
            sort_order: id,
            track_ids: paths.iter().map(|p| id_of(p, &mut tracks)).collect(),
        })
        .collect();
    Library {
        tracks,
        playlists,
        artwork: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: u32, path: &str, title: &str) -> pdb::Track {
        pdb::Track {
            id,
            title: title.into(),
            path: path.into(),
            ..pdb::Track::default()
        }
    }

    #[test]
    fn songs_take_their_details_from_the_main_list_by_path() {
        let main = Library {
            tracks: vec![
                track(1, "/Contents/A/B/One.mp3", "One"),
                track(2, "/Contents/A/B/Two.mp3", "Two"),
            ],
            ..Library::default()
        };
        let copies = HashMap::from([("/playlists/late/01 two.mp3".to_owned(), 2)]);
        let contents = Contents {
            songs: vec![
                "/contents/a/b/ONE.mp3".into(),
                "/Contents/X/Y/Stray Song.flac".into(),
            ],
            playlists: vec![(
                "Late".into(),
                vec![
                    "/Playlists/Late/01 Two.mp3".into(),
                    "/Contents/A/B/One.mp3".into(),
                    "/Contents/X/Y/Stray Song.flac".into(),
                ],
            )],
        };
        let lib = assemble(&main, &copies, contents);
        let titles: Vec<(u32, &str)> = lib
            .tracks
            .iter()
            .map(|t| (t.id, t.title.as_str()))
            .collect();
        assert_eq!(titles, [(1, "One"), (3, "Stray Song"), (2, "Two")]);
        assert_eq!(lib.playlists.len(), 1);
        assert_eq!(lib.playlists[0].name, "Late");
        assert_eq!(
            lib.playlists[0].track_ids,
            [2, 1, 3],
            "a copy counts as its song"
        );
    }
}
