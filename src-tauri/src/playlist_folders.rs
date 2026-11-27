//! Playlists as folders on a USB drive, for players that only browse folders (the Gemini
//! MDJ-500): `Playlists/<playlist>/<position> <name>`, the songs numbered so a player that sorts
//! by name lists them in playlist order. The name is the song's file name, or what the user's
//! [`FileNameTemplate`] makes of its tags.
//!
//! A song is stored once where it can be: the file in its first playlist's folder is the song
//! itself, the one the drive's libraries point at. Only a song in several playlists has copies,
//! one in each further folder (FAT32 has no links). A song no playlist holds lives in `Contents`
//! as usual, and goes back there when its last playlist lets go of it.
//!
//! Songs are moved before the libraries are written and copied after ([`move_homes`], then
//! [`Arrangement::fill`]), so the libraries never name a file that is not there for longer than
//! the renames take.

mod file_name;

pub use file_name::FileNameTemplate;

use crate::anlz;
use crate::pdb::{self, Library};
use crate::usb_export::{content_path_of, copy_file, numbered, write_atomic};
use crate::usb_files::{
    file_names, flattened, on_drive, playlist_file_names, remove_if_there, remove_mac_files,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// The folder holding the playlist folders. The players this is for browse any folder, so the
/// name only has to say what is inside.
pub const DIR: &str = "Playlists";
/// The copies manplay made, one `<track id>\t<path>` a line, so only those are ever replaced or
/// removed. The file being there is what says a drive has playlist folders.
const LIST: &str = ".manplay/playlist-folders.txt";
/// The file name each song in the folders had before it was named from its tags, one
/// `<track id>\t<file name>` a line, so it gets that name back in `Contents` and is still known
/// by it. A song not listed is called what it was: its name in the folder without the position.
const NAMES: &str = ".manplay/playlist-folders-names.txt";
/// The [`FileNameTemplate`] the folders were named with, so edits on the drive name songs alike.
const TEMPLATE: &str = ".manplay/playlist-folders-template.json";
/// What a song is called for a moment while it and another swap places.
const SET_ASIDE: &str = "manplay-move";
/// The longest path, in bytes, the players this is for read.
const MAX_PATH: usize = 255;

type TrackId = u32;

/// A further copy of a song, in the folder of a playlist that is not its first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Copy {
    pub track: TrackId,
    /// Path from the drive root, `/Playlists/<playlist>/<position> <file name>`.
    pub path: String,
}

/// What the playlist folders hold after an export.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Songs in the folders, counting each folder a song is in.
    pub songs: usize,
    /// Of those, the copies of songs that are in more than one playlist.
    pub copies: usize,
    /// Bytes this run copied.
    pub bytes_copied: u64,
    /// Songs this run moved into, between or out of the folders.
    pub moved: usize,
    /// Places left empty because the path would be longer than a player reads.
    pub too_long: usize,
    /// Places left empty because a file manplay did not put there is in the way.
    pub in_the_way: usize,
}

/// Whether the drive at `mount` has playlist folders manplay wrote.
pub fn is_on(mount: &Path) -> bool {
    mount.join(LIST).is_file()
}

/// How many songs and folders the drive's playlist folders hold, counting a song in each folder
/// it is in; `None` when the drive has none of manplay's.
pub fn held(mount: &Path) -> Option<(usize, usize)> {
    if !is_on(mount) {
        return None;
    }
    let folders: Vec<PathBuf> = fs::read_dir(mount.join(DIR))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    let songs = folders
        .iter()
        .flat_map(|folder| file_names(folder))
        .filter(|name| !name.starts_with('.'))
        .count();
    Some((songs, folders.len()))
}

/// How the drive's playlist folders name their songs; `None` when the drive has none of
/// manplay's. A drive with folders but no saved template uses the file names.
pub fn template(mount: &Path) -> Option<FileNameTemplate> {
    if !is_on(mount) {
        return None;
    }
    Some(
        fs::read_to_string(mount.join(TEMPLATE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default(),
    )
}

/// Each song's own file name: what it was called before it went into a playlist folder.
pub fn original_names(mount: &Path, lib: &Library) -> HashMap<TrackId, String> {
    let recorded: HashMap<TrackId, String> = fs::read_to_string(mount.join(NAMES))
        .map(|text| {
            text.lines()
                .filter_map(|line| {
                    let (id, name) = line.split_once('\t')?;
                    Some((id.parse().ok()?, name.to_owned()))
                })
                .filter(|(_, name): &(TrackId, String)| !name.is_empty() && !name.contains('/'))
                .collect()
        })
        .unwrap_or_default();
    lib.tracks
        .iter()
        .map(|t| {
            // A song outside the folders is called what its path says, whatever was recorded.
            let name = recorded
                .get(&t.id)
                .filter(|_| in_folders(&t.path))
                .map_or_else(|| base_name(&t.path).to_owned(), Clone::clone);
            (t.id, name)
        })
        .collect()
}

/// `track`'s own file name from `originals`, or what its path says when it has none there.
pub fn own_name<'a>(originals: &'a HashMap<TrackId, String>, track: &'a pdb::Track) -> &'a str {
    originals
        .get(&track.id)
        .map_or_else(|| base_name(&track.path), String::as_str)
}

/// Records the own file names of the songs that are or will be in the folders, before any is
/// renamed, so a run that stops half way loses none.
fn write_names(
    mount: &Path,
    lib: &Library,
    homes: &HashMap<TrackId, String>,
    originals: &HashMap<TrackId, String>,
) -> std::io::Result<()> {
    let text: String = lib
        .tracks
        .iter()
        .filter(|t| in_folders(&t.path) || homes.get(&t.id).is_some_and(|h| in_folders(h)))
        .filter_map(|t| {
            originals
                .get(&t.id)
                .map(|name| format!("{}\t{name}\n", t.id))
        })
        .collect();
    if text.is_empty() {
        remove_if_there(&mount.join(NAMES))
    } else {
        write_atomic(&mount.join(NAMES), text.as_bytes())
    }
}

/// The further copies manplay made of songs in several playlists, each with its song.
pub fn copies(mount: &Path) -> Vec<Copy> {
    listed(mount)
}

/// The drive's playlist folders as paths from the drive root: every song file in them, and each
/// folder with its songs in order (their names start with their place). `None` when the drive
/// has none of manplay's.
pub fn contents(mount: &Path) -> Option<crate::usb_browse::Contents> {
    if !is_on(mount) {
        return None;
    }
    let mut folders: Vec<String> = fs::read_dir(mount.join(DIR))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| !n.starts_with('.'))
                .collect()
        })
        .unwrap_or_default();
    folders.sort();
    let mut songs = Vec::new();
    let mut playlists = Vec::new();
    for folder in folders {
        let mut files = file_names(&mount.join(DIR).join(&folder));
        files.retain(|n| !n.starts_with('.'));
        files.sort();
        let paths: Vec<String> = files
            .iter()
            .map(|f| format!("/{DIR}/{folder}/{f}"))
            .collect();
        songs.extend(paths.iter().cloned());
        playlists.push((folder, paths));
    }
    Some(crate::usb_browse::Contents { songs, playlists })
}

/// The paths, in lower case, of the further copies manplay made of songs in several playlists.
pub fn copy_paths(mount: &Path) -> HashSet<String> {
    listed(mount)
        .into_iter()
        .map(|copy| copy.path.to_lowercase())
        .collect()
}

fn in_folders(path: &str) -> bool {
    path.strip_prefix('/')
        .and_then(|p| p.strip_prefix(DIR))
        .is_some_and(|rest| rest.starts_with('/'))
}

/// A song's file name without the position a playlist folder put in front of it.
pub fn base_name(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or_default();
    if !in_folders(path) {
        return name;
    }
    let digits = name.bytes().take_while(u8::is_ascii_digit).count();
    match name.get(digits..).and_then(|rest| rest.strip_prefix(' ')) {
        Some(rest) if digits > 0 && !rest.is_empty() => rest,
        _ => name,
    }
}

/// Where every song should be.
#[derive(Debug, Default, PartialEq, Eq)]
struct Layout {
    /// The path of the song itself, for each song that is not to stay where it is.
    homes: HashMap<TrackId, String>,
    copies: Vec<Copy>,
    too_long: usize,
}

/// Works out the folders from the drive's playlists: each playlist's songs in order, a song
/// twice in a playlist once, named by `template`. With no template there are no folders, so
/// every song in one goes back to `Contents` under its own file name from `originals`.
fn layout(
    lib: &Library,
    template: Option<&FileNameTemplate>,
    originals: &HashMap<TrackId, String>,
) -> Layout {
    let original = |t: &pdb::Track| own_name(originals, t).to_owned();
    let mut out = Layout::default();
    if let Some(template) = template {
        let tracks: HashMap<TrackId, &pdb::Track> = lib.tracks.iter().map(|t| (t.id, t)).collect();
        let playlists = flattened(lib);
        let names = playlist_file_names(playlists.iter().map(|(name, _)| name.as_str()));
        for ((_, playlist), name) in playlists.iter().zip(&names) {
            let mut seen = HashSet::new();
            let songs: Vec<&pdb::Track> = playlist
                .track_ids
                .iter()
                .filter(|id| seen.insert(**id))
                .filter_map(|id| tracks.get(id).copied())
                .collect();
            let width = songs.len().to_string().len().max(2);
            for (position, track) in songs.into_iter().enumerate() {
                let path = format!(
                    "/{DIR}/{name}/{:0width$} {}",
                    position + 1,
                    template.render(track, &original(track))
                );
                if path.len() > MAX_PATH {
                    out.too_long += 1;
                } else if let Some(home) = out.homes.get(&track.id) {
                    debug_assert_ne!(home, &path);
                    out.copies.push(Copy {
                        track: track.id,
                        path,
                    });
                } else {
                    out.homes.insert(track.id, path);
                }
            }
        }
    }
    let mut taken: HashSet<String> = lib.tracks.iter().map(|t| t.path.to_lowercase()).collect();
    for track in &lib.tracks {
        if out.homes.contains_key(&track.id) || !in_folders(&track.path) {
            continue;
        }
        let wanted = content_path_of(&track.artist, &track.album, &original(track));
        let mut chosen = wanted.clone();
        let mut n = 1;
        while !taken.insert(chosen.to_lowercase()) {
            n += 1;
            chosen = numbered(&wanted, n);
        }
        out.homes.insert(track.id, chosen);
    }
    out
}

fn listed(mount: &Path) -> Vec<Copy> {
    let Ok(text) = fs::read_to_string(mount.join(LIST)) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| {
            let (id, path) = line.split_once('\t')?;
            Some(Copy {
                track: id.parse().ok()?,
                path: path.to_owned(),
            })
        })
        .collect()
}

fn write_list<'a>(mount: &Path, copies: impl Iterator<Item = &'a Copy>) -> std::io::Result<()> {
    let text: String = copies
        .map(|c| format!("{}\t{}\n", c.track, c.path))
        .collect::<Vec<_>>()
        .concat();
    write_atomic(&mount.join(LIST), text.as_bytes())
}

fn size(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .filter(fs::Metadata::is_file)
        .map(|m| m.len())
}

/// A song manplay analysed keeps its analysis files where its path says they are, so they move
/// with it, naming the new path. Files rekordbox wrote stay where rekordbox put them.
fn follow_analysis(mount: &Path, track: &mut pdb::Track, old_path: &str) {
    if track.analyze_path.is_empty() || track.analyze_path != anlz::dat_path(track.id, old_path) {
        return;
    }
    let new_rel = anlz::dat_path(track.id, &track.path);
    let old_dat = on_drive(mount, &track.analyze_path);
    let new_dat = on_drive(mount, &new_rel);
    let moved = ["DAT", "EXT"].iter().all(|ext| {
        fs::read(old_dat.with_extension(ext))
            .ok()
            .and_then(|bytes| anlz::with_path(&bytes, &track.path))
            .is_some_and(|bytes| write_atomic(&new_dat.with_extension(ext), &bytes).is_ok())
    });
    if moved && new_dat != old_dat {
        for ext in ["DAT", "EXT"] {
            let _ = fs::remove_file(old_dat.with_extension(ext));
        }
        if let Some(folder) = old_dat.parent() {
            let _ = fs::remove_dir(folder);
        }
        track.analyze_path = new_rel;
    }
}

/// What [`move_homes`] did and what is left for [`Arrangement::fill`].
#[derive(Debug, Default)]
pub struct Arrangement {
    /// How the folders name their songs; `None` when there are to be no folders.
    template: Option<FileNameTemplate>,
    /// The copies the layout asks for.
    copies: Vec<Copy>,
    /// Files in the folders that are manplay's: the copies listed before, and songs a copy took
    /// the place of.
    owned: Vec<Copy>,
    moved: usize,
    too_long: usize,
    /// Where the songs that moved were, for libraries that list songs by path.
    pub moved_from: Vec<String>,
    /// Songs that could not be moved, each with why. They stay where they were.
    pub failed: Vec<(String, String)>,
}

/// Removes the folders a file that moved away left empty, up to the drive's root.
fn remove_emptied_folders(mount: &Path, file: &Path) {
    let mut folder = file.parent();
    while let Some(dir) = folder.filter(|dir| *dir != mount && dir.starts_with(mount)) {
        // Fails, as it should, on a folder that still holds something.
        if fs::remove_dir(dir).is_err() {
            break;
        }
        folder = dir.parent();
    }
}

/// Who has a path on the drive.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Holder {
    Song(TrackId),
    Copy(TrackId),
}

/// Where a song that is moving goes, once the place has been made free.
enum Place {
    /// Rename the song to this path.
    Free(String),
    /// A copy of this very song is at this path already: it becomes the song.
    Taken(String),
    /// The song is already beside the file that is in the way of its place.
    Stay,
}

/// The drive's files while songs are moved one at a time.
struct Moves<'a> {
    mount: &'a Path,
    held: HashMap<String, Holder>,
    /// Songs whose place changes in this run.
    moving: HashSet<TrackId>,
    /// Of those, the ones already at their new place.
    settled: HashSet<TrackId>,
    /// Songs moved out of another's way until their own turn, and where they wait.
    set_aside: HashMap<TrackId, PathBuf>,
}

impl<'a> Moves<'a> {
    /// The drive as it is: each song where the library has it, and the copies manplay made.
    fn new(
        mount: &'a Path,
        lib: &Library,
        homes: &HashMap<TrackId, String>,
        copies: &[Copy],
    ) -> Self {
        let mut held: HashMap<String, Holder> = copies
            .iter()
            .map(|c| (c.path.to_lowercase(), Holder::Copy(c.track)))
            .collect();
        for t in &lib.tracks {
            held.insert(t.path.to_lowercase(), Holder::Song(t.id));
        }
        let moving = lib
            .tracks
            .iter()
            .filter(|t| {
                homes
                    .get(&t.id)
                    .is_some_and(|home| home.to_lowercase() != t.path.to_lowercase())
            })
            .map(|t| t.id)
            .collect();
        Self {
            mount,
            held,
            moving,
            settled: HashSet::new(),
            set_aside: HashMap::new(),
        }
    }

    /// Frees `home` for the song `track` (now at `old`, `bytes` long), or finds the place beside
    /// it when what is there is not manplay's to move.
    fn make_room(
        &mut self,
        track: TrackId,
        bytes: u64,
        home: &str,
        old: &str,
    ) -> std::io::Result<Place> {
        let there = on_drive(self.mount, home);
        match self.held.get(&home.to_lowercase()).copied() {
            Some(Holder::Copy(of)) if of == track && size(&there) == Some(bytes) => {
                return Ok(Place::Taken(home.to_owned()));
            }
            // Any other copy of manplay's is in the way and can be made again.
            Some(Holder::Copy(_)) => remove_if_there(&there)?,
            // A song that has yet to move away steps aside until its turn.
            Some(Holder::Song(other))
                if self.moving.contains(&other) && !self.settled.contains(&other) =>
            {
                let aside = PathBuf::from(format!("{}.{SET_ASIDE}", there.display()));
                match fs::rename(&there, &aside) {
                    Ok(()) => {
                        self.set_aside.insert(other, aside);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
            }
            // Someone else's file, or a song that is staying: go beside it.
            _ => {
                let mut dest = home.to_owned();
                let mut n = 1;
                while dest.to_lowercase() != old.to_lowercase()
                    && (self.held.contains_key(&dest.to_lowercase())
                        || on_drive(self.mount, &dest).exists())
                {
                    n += 1;
                    dest = numbered(home, n);
                }
                return Ok(if dest.to_lowercase() == old.to_lowercase() {
                    Place::Stay
                } else {
                    Place::Free(dest)
                });
            }
        }
        Ok(Place::Free(home.to_owned()))
    }
}

/// Moves each song to where the playlists now put it (see the module notes), named by
/// `template`, and points `lib` at it; with no template, every song goes back to `Contents`.
/// Renames only, so it is quick; a song that cannot be moved stays where it was.
pub fn move_homes(
    mount: &Path,
    lib: &mut Library,
    template: Option<&FileNameTemplate>,
) -> Arrangement {
    let originals = original_names(mount, lib);
    let plan = layout(lib, template, &originals);
    let mut out = Arrangement {
        template: template.cloned(),
        owned: listed(mount),
        too_long: plan.too_long,
        copies: plan.copies,
        ..Arrangement::default()
    };
    if let Err(e) = write_names(mount, lib, &plan.homes, &originals) {
        // Without the record a song renamed from its tags would lose its own name, so none moves.
        out.failed.push((NAMES.to_owned(), e.to_string()));
        return out;
    }
    let mut moves = Moves::new(mount, lib, &plan.homes, &out.owned);

    for track in &mut lib.tracks {
        let Some(home) = plan
            .homes
            .get(&track.id)
            .filter(|_| moves.moving.contains(&track.id))
        else {
            continue;
        };
        let old = track.path.clone();
        let from = moves
            .set_aside
            .remove(&track.id)
            .unwrap_or_else(|| on_drive(mount, &old));
        let Some(bytes) = size(&from) else {
            // The song is not on the drive; the library is left saying where it should be.
            continue;
        };
        let placed = moves
            .make_room(track.id, bytes, home, &old)
            .and_then(|place| {
                if let Place::Free(dest) = &place {
                    let to = on_drive(mount, dest);
                    to.parent().map_or(Ok(()), fs::create_dir_all)?;
                    fs::rename(&from, &to)?;
                }
                Ok(place)
            });
        let dest = match placed {
            Ok(Place::Stay) => continue,
            Ok(Place::Free(dest)) => {
                if moves.held.get(&old.to_lowercase()) == Some(&Holder::Song(track.id)) {
                    moves.held.remove(&old.to_lowercase());
                }
                remove_emptied_folders(mount, &on_drive(mount, &old));
                dest
            }
            Ok(Place::Taken(dest)) => {
                // The file left behind is now a spare of manplay's: kept if the layout wants a
                // copy there, removed otherwise.
                out.owned
                    .retain(|c| c.path.to_lowercase() != dest.to_lowercase());
                out.owned.push(Copy {
                    track: track.id,
                    path: old.clone(),
                });
                moves
                    .held
                    .insert(old.to_lowercase(), Holder::Copy(track.id));
                dest
            }
            Err(e) => {
                // Put back where the library says it is, if it had stepped aside and the place
                // is still free; otherwise it keeps its set-aside name, and nothing is lost.
                let back = on_drive(mount, &old);
                if from != back && !back.exists() {
                    let _ = fs::rename(&from, &back);
                }
                out.failed.push((old, e.to_string()));
                continue;
            }
        };
        moves
            .held
            .insert(dest.to_lowercase(), Holder::Song(track.id));
        moves.settled.insert(track.id);
        track.path = dest;
        follow_analysis(mount, track, &old);
        out.moved_from.push(old);
        out.moved += 1;
    }
    // A song set aside whose own move then failed goes back where the library says it is.
    for (id, aside) in moves.set_aside {
        if let Some(back) = lib
            .tracks
            .iter()
            .find(|t| t.id == id)
            .map(|t| on_drive(mount, &t.path))
            .filter(|back| !back.exists())
        {
            let _ = fs::rename(&aside, back);
        }
    }
    out
}

/// Removes the folders under `dir` that hold nothing, and `dir` itself if it ends up empty.
fn remove_empty_folders(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            remove_empty_folders(&entry.path());
        }
    }
    let _ = fs::remove_dir(dir);
}

impl Arrangement {
    /// Makes the copies the layout asks for and removes manplay's files it no longer does, after
    /// the libraries were written. `progress` hears of each copy: how many are done, of how
    /// many, and the file's name. Returns what the folders now hold and the copies in place.
    pub fn fill(
        self,
        mount: &Path,
        lib: &Library,
        mut progress: impl FnMut(usize, usize, &str),
    ) -> Result<(Summary, Vec<Copy>), String> {
        let homes: HashMap<TrackId, &str> =
            lib.tracks.iter().map(|t| (t.id, t.path.as_str())).collect();
        let home_paths: HashSet<String> =
            lib.tracks.iter().map(|t| t.path.to_lowercase()).collect();
        let owned: HashMap<String, TrackId> = self
            .owned
            .iter()
            .map(|c| (c.path.to_lowercase(), c.track))
            .collect();
        let mut summary = Summary {
            moved: self.moved,
            too_long: self.too_long,
            ..Summary::default()
        };

        let mut placed = Vec::new();
        let mut todo = Vec::new();
        for copy in &self.copies {
            let Some(from) = homes.get(&copy.track).map(|home| on_drive(mount, home)) else {
                continue;
            };
            let Some(bytes) = size(&from) else {
                continue;
            };
            let to = on_drive(mount, &copy.path);
            let ours = owned.get(&copy.path.to_lowercase());
            if ours == Some(&copy.track) && size(&to) == Some(bytes) {
                placed.push(copy.clone());
            } else if ours.is_none() && to.exists() {
                summary.in_the_way += 1;
            } else {
                todo.push((copy, from, to, bytes));
            }
        }
        let wanted: HashSet<String> = self.copies.iter().map(|c| c.path.to_lowercase()).collect();
        let stale: Vec<&Copy> = self
            .owned
            .iter()
            .filter(|c| {
                let path = c.path.to_lowercase();
                !wanted.contains(&path) && !home_paths.contains(&path)
            })
            .collect();

        let needed: u64 = todo.iter().map(|(_, _, _, bytes)| bytes).sum();
        let freed: u64 = stale
            .iter()
            .filter_map(|c| size(&on_drive(mount, &c.path)))
            .sum();
        let free = crate::usb::list()
            .into_iter()
            .find(|d| d.mount == mount)
            .map(|d| d.free_bytes.saturating_add(freed));
        if let Some(free) = free
            && needed > free
        {
            return Err(format!(
                "Not enough space on the drive for songs that are in more than one playlist: their copies need {} MB and {} MB is free.",
                needed / 1_000_000,
                free / 1_000_000
            ));
        }

        // Listed before they are copied, so a run that stops half way leaves nothing unlisted.
        if !self.owned.is_empty() || !self.copies.is_empty() {
            write_list(mount, self.owned.iter().chain(&self.copies)).map_err(|e| e.to_string())?;
        }
        for copy in stale {
            let file = on_drive(mount, &copy.path);
            remove_if_there(&file).map_err(|e| format!("{}: {e}", file.display()))?;
        }
        let total = todo.len();
        for (done, (copy, from, to, _)) in todo.into_iter().enumerate() {
            progress(done, total, base_name(&copy.path));
            summary.bytes_copied +=
                copy_file(&from, &to).map_err(|e| format!("{}: {e}", to.display()))?;
            placed.push(copy.clone());
        }

        if let Some(template) = &self.template {
            write_list(mount, placed.iter()).map_err(|e| e.to_string())?;
            let json = serde_json::to_vec(template).map_err(|e| e.to_string())?;
            write_atomic(&mount.join(TEMPLATE), &json).map_err(|e| e.to_string())?;
        } else {
            let none_left = !lib.tracks.iter().any(|t| in_folders(&t.path));
            let gone = if none_left {
                &[LIST, TEMPLATE, NAMES][..]
            } else {
                &[LIST, TEMPLATE]
            };
            for file in gone {
                remove_if_there(&mount.join(file)).map_err(|e| e.to_string())?;
            }
        }
        let folders = mount.join(DIR);
        remove_mac_files(&folders);
        remove_empty_folders(&folders);
        summary.copies = placed.len();
        summary.songs = placed.len() + lib.tracks.iter().filter(|t| in_folders(&t.path)).count();
        Ok((summary, placed))
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    fn temp_mount(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "manplay-folders-test-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        fs::create_dir_all(dir.join("PIONEER")).expect("temp mount");
        dir
    }

    fn track(id: u32, path: &str) -> pdb::Track {
        pdb::Track {
            id,
            title: format!("Song {id}"),
            artist: "Artist".into(),
            album: "Album".into(),
            path: path.into(),
            ..pdb::Track::default()
        }
    }

    fn playlist(id: u32, name: &str, ids: &[u32]) -> pdb::Playlist {
        pdb::Playlist {
            id,
            parent_id: 0,
            name: name.into(),
            is_folder: false,
            sort_order: id,
            track_ids: ids.to_vec(),
        }
    }

    fn song(mount: &Path, path: &str, bytes: &[u8]) {
        let file = on_drive(mount, path);
        fs::create_dir_all(file.parent().expect("parent")).expect("dirs");
        fs::write(file, bytes).expect("song");
    }

    fn read(mount: &Path, path: &str) -> String {
        String::from_utf8(fs::read(on_drive(mount, path)).expect("file")).expect("text")
    }

    /// Arranges the drive as an export would, returning the summary and the copies.
    fn arrange(mount: &Path, lib: &mut Library, enabled: bool) -> (Summary, Vec<Copy>) {
        let template = FileNameTemplate::default();
        arrange_named(mount, lib, enabled.then_some(&template))
    }

    fn arrange_named(
        mount: &Path,
        lib: &mut Library,
        template: Option<&FileNameTemplate>,
    ) -> (Summary, Vec<Copy>) {
        let arrangement = move_homes(mount, lib, template);
        assert_eq!(arrangement.failed, []);
        arrangement.fill(mount, lib, |_, _, _| {}).expect("fill")
    }

    fn paths(lib: &Library) -> Vec<&str> {
        lib.tracks.iter().map(|t| t.path.as_str()).collect()
    }

    #[test]
    fn base_names_drop_only_a_playlist_folders_position() {
        for (path, expected) in [
            ("/Contents/a/b/01 Archangel.mp3", "01 Archangel.mp3"),
            ("/Playlists/Friday/03 Song.mp3", "Song.mp3"),
            ("/Playlists/Friday/02 01 Archangel.mp3", "01 Archangel.mp3"),
            ("/Playlists/Friday/Song.mp3", "Song.mp3"),
            ("/Playlists/Friday/2024.mp3", "2024.mp3"),
            ("/Playlists/Friday/12 ", "12 "),
            ("/Playlists2/a/01 Song.mp3", "01 Song.mp3"),
        ] {
            assert_eq!(base_name(path), expected, "{path}");
        }
    }

    #[test]
    fn a_song_lives_in_its_first_playlist_and_is_copied_into_the_others() {
        let lib = Library {
            tracks: vec![
                track(1, "/Contents/Artist/Album/One.mp3"),
                track(2, "/Contents/Artist/Album/Two.mp3"),
                track(3, "/Contents/Artist/Album/Loose.mp3"),
            ],
            playlists: vec![
                playlist(1, "Friday", &[2, 1, 2, 99]),
                playlist(2, "Late", &[1]),
            ],
            artwork: Vec::new(),
        };
        let template = FileNameTemplate::default();
        let plan = layout(&lib, Some(&template), &HashMap::new());
        assert_eq!(
            plan.homes,
            HashMap::from([
                (2, "/Playlists/Friday/01 Two.mp3".to_owned()),
                (1, "/Playlists/Friday/02 One.mp3".to_owned()),
            ]),
            "a song no playlist holds stays where it is"
        );
        assert_eq!(
            plan.copies,
            [Copy {
                track: 1,
                path: "/Playlists/Late/01 One.mp3".into()
            }]
        );
        assert_eq!(layout(&lib, None, &HashMap::new()), Layout::default());
    }

    #[test]
    fn songs_are_stored_once_and_follow_their_playlists() {
        let mount = temp_mount("once");
        song(&mount, "/Contents/Artist/Album/One.mp3", b"one");
        song(&mount, "/Contents/Artist/Album/Two.mp3", b"two!");
        song(&mount, "/Contents/Artist/Album/Loose.mp3", b"loose");
        let mut lib = Library {
            tracks: vec![
                track(1, "/Contents/Artist/Album/One.mp3"),
                track(2, "/Contents/Artist/Album/Two.mp3"),
                track(3, "/Contents/Artist/Album/Loose.mp3"),
            ],
            playlists: vec![playlist(1, "Friday", &[2, 1]), playlist(2, "Late", &[1])],
            artwork: Vec::new(),
        };

        let (summary, copies) = arrange(&mount, &mut lib, true);
        assert_eq!(
            paths(&lib),
            [
                "/Playlists/Friday/02 One.mp3",
                "/Playlists/Friday/01 Two.mp3",
                "/Contents/Artist/Album/Loose.mp3"
            ]
        );
        assert_eq!(
            summary,
            Summary {
                songs: 3,
                copies: 1,
                bytes_copied: 3,
                moved: 2,
                ..Summary::default()
            }
        );
        assert_eq!(copies.len(), 1);
        assert_eq!(read(&mount, "/Playlists/Late/01 One.mp3"), "one");
        assert_eq!(read(&mount, "/Playlists/Friday/01 Two.mp3"), "two!");
        assert_eq!(
            file_names(&mount.join("Contents/Artist/Album")),
            ["Loose.mp3"],
            "the songs moved, they were not copied"
        );
        assert!(is_on(&mount));

        // Nothing to do the second time.
        let (again, _) = arrange(&mount, &mut lib, true);
        assert_eq!((again.moved, again.bytes_copied, again.copies), (0, 0, 1));

        // The playlist is reordered: both songs swap numbers, neither is copied.
        lib.playlists[0].track_ids = vec![1, 2];
        let (swapped, _) = arrange(&mount, &mut lib, true);
        assert_eq!((swapped.moved, swapped.bytes_copied), (2, 0));
        assert_eq!(read(&mount, "/Playlists/Friday/01 One.mp3"), "one");
        assert_eq!(read(&mount, "/Playlists/Friday/02 Two.mp3"), "two!");
        assert_eq!(file_names(&mount.join("Playlists/Friday")).len(), 2);

        // The first playlist lets go of a song: its copy in the other becomes the song itself.
        lib.playlists[0].track_ids = vec![2];
        let (released, copies) = arrange(&mount, &mut lib, true);
        assert_eq!(lib.tracks[0].path, "/Playlists/Late/01 One.mp3");
        assert_eq!(
            (released.copies, released.bytes_copied, copies.len()),
            (0, 0, 0)
        );
        assert_eq!(file_names(&mount.join("Playlists/Friday")), ["01 Two.mp3"]);
        assert_eq!(read(&mount, "/Playlists/Late/01 One.mp3"), "one");

        // No playlist holds it any more: back to Contents. A file that is not manplay's stays.
        fs::write(mount.join("Playlists/Late/mine.txt"), "keep").expect("own file");
        lib.playlists.truncate(1);
        arrange(&mount, &mut lib, true);
        assert_eq!(lib.tracks[0].path, "/Contents/Artist/Album/One.mp3");
        assert_eq!(read(&mount, "/Contents/Artist/Album/One.mp3"), "one");
        assert_eq!(file_names(&mount.join("Playlists/Late")), ["mine.txt"]);

        // Turned off: every song is back in Contents and the folders are gone.
        let (off, copies) = arrange(&mount, &mut lib, false);
        assert_eq!((off.songs, copies.len()), (0, 0));
        assert_eq!(
            paths(&lib),
            [
                "/Contents/Artist/Album/One.mp3",
                "/Contents/Artist/Album/Two.mp3",
                "/Contents/Artist/Album/Loose.mp3"
            ]
        );
        assert!(!mount.join("Playlists/Friday").exists());
        assert!(!is_on(&mount));
        let _ = fs::remove_dir_all(&mount);
    }

    #[test]
    fn songs_named_from_their_tags_get_their_own_names_back() {
        let mount = temp_mount("named");
        song(&mount, "/Contents/Artist/Album/01 one.mp3", b"one");
        let mut lib = Library {
            tracks: vec![track(1, "/Contents/Artist/Album/01 one.mp3")],
            playlists: vec![playlist(1, "Friday", &[1])],
            artwork: Vec::new(),
        };
        let named: FileNameTemplate =
            serde_json::from_str(r#"[{"tag":"artist"},{"text":" - "},{"tag":"title"}]"#)
                .expect("template");
        arrange_named(&mount, &mut lib, Some(&named));
        assert_eq!(paths(&lib), ["/Playlists/Friday/01 Artist - Song 1.mp3"]);
        assert_eq!(template(&mount), Some(named.clone()));
        assert_eq!(
            original_names(&mount, &lib),
            HashMap::from([(1, "01 one.mp3".to_owned())]),
            "known by its own file name, not the one made from its tags"
        );

        // Edits on the drive name songs the same way.
        let again = move_homes(&mount, &mut lib, template(&mount).as_ref());
        assert_eq!(again.moved_from.len(), 0);

        // Back to the file name in the folder, then out of the folders altogether.
        arrange(&mount, &mut lib, true);
        assert_eq!(paths(&lib), ["/Playlists/Friday/01 01 one.mp3"]);
        arrange_named(&mount, &mut lib, Some(&named));
        arrange(&mount, &mut lib, false);
        assert_eq!(paths(&lib), ["/Contents/Artist/Album/01 one.mp3"]);
        assert_eq!(read(&mount, "/Contents/Artist/Album/01 one.mp3"), "one");
        assert!(!mount.join(NAMES).exists() && !mount.join(TEMPLATE).exists());
        assert_eq!(template(&mount), None);
        let _ = fs::remove_dir_all(&mount);
    }

    #[test]
    fn songs_with_the_same_file_name_swap_places_without_losing_either() {
        let mount = temp_mount("swap");
        song(&mount, "/Playlists/Friday/01 Song.mp3", b"first");
        song(&mount, "/Playlists/Friday/02 Song.mp3", b"second!");
        let mut lib = Library {
            tracks: vec![
                track(1, "/Playlists/Friday/01 Song.mp3"),
                track(2, "/Playlists/Friday/02 Song.mp3"),
            ],
            playlists: vec![playlist(1, "Friday", &[2, 1])],
            artwork: Vec::new(),
        };
        arrange(&mount, &mut lib, true);
        assert_eq!(
            paths(&lib),
            [
                "/Playlists/Friday/02 Song.mp3",
                "/Playlists/Friday/01 Song.mp3"
            ]
        );
        assert_eq!(read(&mount, "/Playlists/Friday/02 Song.mp3"), "first");
        assert_eq!(read(&mount, "/Playlists/Friday/01 Song.mp3"), "second!");
        assert_eq!(file_names(&mount.join("Playlists/Friday")).len(), 2);
        let _ = fs::remove_dir_all(&mount);
    }

    #[test]
    fn a_file_that_is_not_manplays_is_never_replaced() {
        let mount = temp_mount("foreign");
        song(&mount, "/Contents/Artist/Album/One.mp3", b"one");
        song(&mount, "/Playlists/Friday/01 One.mp3", b"someone else's");
        song(&mount, "/Playlists/Late/01 One.mp3", b"also someone else's");
        let mut lib = Library {
            tracks: vec![track(1, "/Contents/Artist/Album/One.mp3")],
            playlists: vec![playlist(1, "Friday", &[1]), playlist(2, "Late", &[1])],
            artwork: Vec::new(),
        };
        let (summary, copies) = arrange(&mount, &mut lib, true);
        assert_eq!(lib.tracks[0].path, "/Playlists/Friday/01 One (2).mp3");
        assert_eq!(
            read(&mount, "/Playlists/Friday/01 One.mp3"),
            "someone else's"
        );
        assert_eq!(
            read(&mount, "/Playlists/Late/01 One.mp3"),
            "also someone else's"
        );
        assert_eq!((summary.in_the_way, copies.len()), (1, 0));
        let _ = fs::remove_dir_all(&mount);
    }

    #[test]
    fn analysis_files_manplay_wrote_move_with_the_song() {
        let mount = temp_mount("analysis");
        let old = "/Contents/Artist/Album/One.mp3";
        song(&mount, old, b"one");
        let mut first = track(1, old);
        first.analyze_path = anlz::dat_path(1, old);
        let stored = anlz::Stored {
            grid_bpm: Some(128.0),
            first_beat: 0.25,
            bar_offset: 0,
            duration: 20.0,
            detail: vec![7; 3000],
        };
        let (dat, ext) = anlz::files(old, &stored, &[], None);
        let dat_file = on_drive(&mount, &first.analyze_path);
        write_atomic(&dat_file, &dat).expect("dat");
        write_atomic(&dat_file.with_extension("EXT"), &ext).expect("ext");
        let mut lib = Library {
            tracks: vec![first],
            playlists: vec![playlist(1, "Friday", &[1])],
            artwork: Vec::new(),
        };
        arrange(&mount, &mut lib, true);
        let moved = &lib.tracks[0];
        assert_eq!(moved.path, "/Playlists/Friday/01 One.mp3");
        assert_eq!(moved.analyze_path, anlz::dat_path(1, &moved.path));
        assert!(!dat_file.exists());
        let (new_dat, new_ext) = anlz::files(&moved.path, &stored, &[], None);
        let now = on_drive(&mount, &moved.analyze_path);
        assert_eq!(fs::read(&now).expect("dat"), new_dat);
        assert_eq!(fs::read(now.with_extension("EXT")).expect("ext"), new_ext);
        let _ = fs::remove_dir_all(&mount);
    }
}
