//! The app's own file picker: the places it starts from, the folders the user walks through,
//! and the picture it reads for a cover. It only looks; the one thing it writes is a new, empty
//! folder the user asks for. Nothing here is confined to the library, because choosing a folder
//! outside it (a library folder, an import folder, where to save an export) is the point.

use std::path::{Path, PathBuf};

use crate::error::Error;
use crate::fsops::{self, FsEntry};

/// The largest picture read for a cover. Far above any real cover, and small enough to hand to
/// the window in one piece.
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// The picture formats a cover can be written from, by file extension.
const IMAGE_EXTENSIONS: [&str; 3] = ["jpg", "jpeg", "png"];

#[derive(serde::Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PlaceKind {
    Home,
    Desktop,
    Documents,
    Downloads,
    Music,
    /// A disk: an internal one, a USB drive, a network share.
    Volume,
}

/// A folder the picker offers in its sidebar.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub kind: PlaceKind,
    pub name: String,
    pub path: PathBuf,
}

/// One step of the way from a disk's top folder down to a folder.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Crumb {
    pub name: String,
    pub path: PathBuf,
}

/// A folder as the picker shows it.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: PathBuf,
    /// From the disk's top folder down to `path` itself.
    pub crumbs: Vec<Crumb>,
    pub entries: Vec<FsEntry>,
}

fn err(msg: impl Into<String>) -> Error {
    Error::Msg(msg.into())
}

/// The window sends paths as text, so a relative one would be read against wherever the app
/// happened to start.
fn absolute(path: &Path) -> Result<&Path, Error> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(err(format!("not a full path: {}", path.display())))
    }
}

fn display_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// The user's own folders that exist, in the order given, then every disk.
pub fn places(personal: Vec<(PlaceKind, PathBuf)>) -> Vec<Place> {
    personal
        .into_iter()
        .filter(|(_, path)| path.is_dir())
        .map(|(kind, path)| Place {
            kind,
            name: display_name(&path),
            path,
        })
        .chain(volumes())
        .collect()
}

#[cfg(target_os = "macos")]
fn volumes() -> Vec<Place> {
    let Ok(entries) = std::fs::read_dir("/Volumes") else {
        return Vec::new();
    };
    let mut out: Vec<Place> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && !display_name(path).starts_with('.'))
        .map(|path| Place {
            kind: PlaceKind::Volume,
            name: display_name(&path),
            path,
        })
        .collect();
    out.sort_by_key(|place| place.name.to_lowercase());
    out
}

#[cfg(windows)]
fn volumes() -> Vec<Place> {
    ('A'..='Z')
        .map(|letter| (format!("{letter}:"), PathBuf::from(format!("{letter}:\\"))))
        .filter(|(_, path)| path.is_dir())
        .map(|(name, path)| Place {
            kind: PlaceKind::Volume,
            name,
            path,
        })
        .collect()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn volumes() -> Vec<Place> {
    vec![Place {
        kind: PlaceKind::Volume,
        name: "Computer".to_owned(),
        path: PathBuf::from("/"),
    }]
}

fn crumbs(dir: &Path) -> Vec<Crumb> {
    let mut out: Vec<Crumb> = dir
        .ancestors()
        .map(|step| Crumb {
            name: display_name(step),
            path: step.to_path_buf(),
        })
        .collect();
    out.reverse();
    out
}

pub fn list(dir: &Path) -> Result<Listing, Error> {
    let dir = absolute(dir)?;
    if !dir.is_dir() {
        return Err(err(format!("{} is not a folder", dir.display())));
    }
    Ok(Listing {
        path: dir.to_path_buf(),
        crumbs: crumbs(dir),
        entries: fsops::list_dir(dir)?,
    })
}

/// Makes an empty folder called `name` in `parent`. Never replaces anything.
pub fn make_dir(parent: &Path, name: &str) -> Result<PathBuf, Error> {
    let target = absolute(parent)?.join(fsops::valid_name(name)?);
    if target.symlink_metadata().is_ok() {
        return Err(err(format!("“{}” already exists", name.trim())));
    }
    std::fs::create_dir(&target)?;
    Ok(target)
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            IMAGE_EXTENSIONS
                .iter()
                .any(|known| extension.eq_ignore_ascii_case(known))
        })
}

/// The bytes of a JPEG or PNG the user picked for a cover.
pub fn read_image(path: &Path) -> Result<Vec<u8>, Error> {
    let path = absolute(path)?;
    if !is_image(path) {
        return Err(err("Use a JPEG or PNG picture"));
    }
    let size = std::fs::metadata(path)?.len();
    if size > MAX_IMAGE_BYTES {
        return Err(err(format!(
            "{} is too large for a cover",
            display_name(path)
        )));
    }
    Ok(std::fs::read(path)?)
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("manplay-pick-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir.canonicalize().expect("canon")
    }

    #[test]
    fn lists_a_folder_outside_the_library_with_the_way_down_to_it() {
        let root = tmp("list");
        std::fs::create_dir(root.join("Sets")).expect("mkdir");
        std::fs::write(root.join("a.mp3"), b"x").expect("write");
        std::fs::write(root.join(".hidden"), b"x").expect("write");

        let listing = list(&root).expect("list");

        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Sets", "a.mp3"]);
        assert_eq!(
            listing.crumbs.last().map(|c| c.path.as_path()),
            Some(root.as_path())
        );
        assert!(
            listing
                .crumbs
                .first()
                .is_some_and(|c| c.path.parent().is_none())
        );
        assert_eq!(listing.crumbs.len(), root.ancestors().count());
    }

    #[test]
    fn refuses_paths_that_are_not_a_folder_to_list() {
        let root = tmp("refuse");
        std::fs::write(root.join("a.mp3"), b"x").expect("write");
        let cases = [
            ("a relative path", PathBuf::from("Music")),
            ("a path that climbs", PathBuf::from("../Music")),
            ("an empty path", PathBuf::new()),
            ("a file", root.join("a.mp3")),
            ("a folder that is not there", root.join("gone")),
        ];
        for (what, path) in cases {
            assert!(list(&path).is_err(), "{what} should not list");
        }
    }

    #[test]
    fn makes_a_folder_only_under_a_safe_new_name() {
        let root = tmp("mkdir");
        std::fs::create_dir(root.join("Taken")).expect("mkdir");
        let refused = ["", "  ", ".", "..", "a/b", "a\\b", "../up", "Taken"];
        for name in refused {
            assert!(make_dir(&root, name).is_err(), "{name:?} should be refused");
        }
        assert!(make_dir(Path::new("relative"), "New").is_err());

        let made = make_dir(&root, " New set ").expect("mkdir");

        assert_eq!(made, root.join("New set"));
        assert!(made.is_dir());
    }

    #[test]
    fn reads_only_pictures_a_cover_can_be_made_from() {
        let root = tmp("image");
        let accepted = ["cover.jpg", "cover.JPEG", "cover.png"];
        let refused = ["cover.gif", "cover.webp", "song.mp3", "cover", "png"];
        for name in accepted.iter().chain(&refused) {
            std::fs::write(root.join(name), b"picture").expect("write");
        }
        for name in accepted {
            assert_eq!(read_image(&root.join(name)).expect(name), b"picture");
        }
        for name in refused {
            assert!(
                read_image(&root.join(name)).is_err(),
                "{name} should be refused"
            );
        }
        assert!(read_image(Path::new("cover.png")).is_err());
        assert!(read_image(&root.join("missing.png")).is_err());
    }

    #[test]
    fn offers_only_the_personal_folders_that_exist() {
        let root = tmp("places");
        let found = places(vec![
            (PlaceKind::Music, root.clone()),
            (PlaceKind::Downloads, root.join("gone")),
        ]);
        assert_eq!(found.first().map(|p| p.kind), Some(PlaceKind::Music));
        assert!(found.iter().skip(1).all(|p| p.kind == PlaceKind::Volume));
    }
}
