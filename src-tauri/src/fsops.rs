//! File-system operations for the file browser. Everything is confined to the library folder,
//! never overwrites, and never deletes. Batches are all-or-nothing: if a step fails, the steps
//! already done are undone (see [`Undo`]).

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::error::Error;

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// Unix seconds.
    pub modified: Option<i64>,
}

fn err(msg: impl Into<String>) -> Error {
    Error::Msg(msg.into())
}

/// Resolves `path` and checks it is `root` or inside it. Symlinks are resolved first, so a link
/// pointing out of the library cannot be used to escape it.
pub fn inside(root: &Path, path: &Path) -> Result<PathBuf, Error> {
    let root = root
        .canonicalize()
        .map_err(|e| err(format!("library folder not readable: {e}")))?;
    let resolved = path
        .canonicalize()
        .map_err(|e| err(format!("{}: {e}", path.display())))?;
    if resolved.starts_with(&root) {
        Ok(resolved)
    } else {
        Err(err(format!(
            "{} is outside the library folder",
            path.display()
        )))
    }
}

/// A single path segment that is safe to create: no separators, not `.`/`..`, not empty.
pub fn valid_name(name: &str) -> Result<&str, Error> {
    let name = name.trim();
    let mut parts = Path::new(name).components();
    let single = matches!(
        (parts.next(), parts.next()),
        (Some(Component::Normal(_)), None)
    );
    if name.is_empty() || !single || name.contains(['/', '\\', '\0']) {
        return Err(err(format!("invalid name: {name:?}")));
    }
    Ok(name)
}

/// First audio file in `dir`, or one folder level below it (so an artist folder finds an album).
/// Used to pick artwork for a folder.
pub fn first_audio(dir: &Path) -> Option<PathBuf> {
    let mut subdirs = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for e in entries {
        let p = e.path();
        if p.is_dir() {
            subdirs.push(p);
        } else if crate::scan::is_audio(&p) {
            return Some(p);
        }
    }
    subdirs.into_iter().find_map(|d| {
        let mut inner: Vec<_> = std::fs::read_dir(d).ok()?.filter_map(Result::ok).collect();
        inner.sort_by_key(std::fs::DirEntry::file_name);
        inner
            .into_iter()
            .map(|e| e.path())
            .find(|p| p.is_file() && crate::scan::is_audio(p))
    })
}

/// Renames done so far in a batch, so a failure part-way can put everything back.
#[derive(Default)]
pub struct Undo {
    renames: Vec<(PathBuf, PathBuf)>,
    made_dirs: Vec<PathBuf>,
}

impl Undo {
    pub fn rename(&mut self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::rename(from, to)?;
        self.renames.push((from.to_owned(), to.to_owned()));
        Ok(())
    }

    /// Creates `dir` and any missing parents, remembering which ones are new.
    pub fn create_dir_all(&mut self, dir: &Path) -> std::io::Result<()> {
        let mut missing: Vec<&Path> = dir
            .ancestors()
            .take_while(|a| a.symlink_metadata().is_err())
            .collect();
        missing.reverse();
        for d in missing {
            std::fs::create_dir(d)?;
            self.made_dirs.push(d.to_owned());
        }
        Ok(())
    }

    /// Reverts everything, newest first. Returns what could not be restored.
    pub fn rollback(self) -> Vec<PathBuf> {
        let mut stuck = Vec::new();
        for (from, to) in self.renames.into_iter().rev() {
            if let Err(e) = std::fs::rename(&to, &from) {
                log::error!("rollback: could not move {} back: {e}", to.display());
                stuck.push(to);
            }
        }
        for d in self.made_dirs.into_iter().rev() {
            let _ = std::fs::remove_dir(d); // only succeeds while empty
        }
        stuck
    }
}

/// The error for a failed batch, after rolling back.
pub fn rolled_back(cause: &dyn std::fmt::Display, undo: Undo) -> Error {
    let stuck = undo.rollback();
    if stuck.is_empty() {
        err(format!("{cause}. Nothing was changed."))
    } else {
        let names: Vec<_> = stuck.iter().map(|p| p.display().to_string()).collect();
        err(format!("{cause}. Undo failed for: {}", names.join(", ")))
    }
}

/// Removes empty folders from `dir` upwards, stopping at `root` or the first non-empty one.
pub fn prune_empty(root: &Path, dir: &Path) {
    let mut cur = dir.to_owned();
    while cur != root && cur.starts_with(root) {
        if std::fs::remove_dir(&cur).is_err() {
            break;
        }
        match cur.parent() {
            Some(p) => cur = p.to_owned(),
            None => break,
        }
    }
}

/// Reads a folder, explaining the macOS privacy block (`EPERM`) instead of a bare "os error 1".
pub fn read_dir(dir: &Path) -> Result<std::fs::ReadDir, Error> {
    std::fs::read_dir(dir).map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(1) {
            err(format!(
                "macOS blocked access to {}. Allow manplay under System Settings → Privacy & \
                 Security → Files and Folders (or Full Disk Access), then reopen it.",
                dir.display()
            ))
        } else {
            e.into()
        }
    })
}

pub fn list(root: &Path, dir: &Path) -> Result<Vec<FsEntry>, Error> {
    let dir = inside(root, dir)?;
    let mut out = Vec::new();
    for entry in read_dir(&dir)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        // `metadata` follows symlinks; a broken link is simply skipped.
        let Ok(meta) = std::fs::metadata(entry.path()) else {
            continue;
        };
        out.push(FsEntry {
            name,
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified: meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .and_then(|d| i64::try_from(d.as_secs()).ok()),
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

pub fn make_dir(root: &Path, parent: &Path, name: &str) -> Result<PathBuf, Error> {
    let parent = inside(root, parent)?;
    let target = parent.join(valid_name(name)?);
    if target.symlink_metadata().is_ok() {
        return Err(err(format!("“{name}” already exists")));
    }
    std::fs::create_dir(&target)?;
    Ok(target)
}

/// Renames `path` within its own folder.
pub fn rename(root: &Path, path: &Path, new_name: &str) -> Result<PathBuf, Error> {
    let from = inside(root, path)?;
    let root = root.canonicalize()?;
    if from == root {
        return Err(err("the library folder itself cannot be renamed here"));
    }
    let parent = from.parent().ok_or_else(|| err("no parent folder"))?;
    let to = parent.join(valid_name(new_name)?);
    if to == from {
        return Ok(from);
    }
    // A case-only rename on a case-insensitive disk "exists" as itself; allow it.
    let case_only = to.to_string_lossy().to_lowercase() == from.to_string_lossy().to_lowercase();
    if to.symlink_metadata().is_ok() && !case_only {
        return Err(err(format!("“{new_name}” already exists")));
    }
    std::fs::rename(&from, &to)?;
    Ok(to)
}

/// Moves every path into `dest`. All checks run before anything moves, so a bad request
/// changes nothing. Returns the new locations.
pub fn move_into(root: &Path, paths: &[PathBuf], dest: &Path) -> Result<Vec<PathBuf>, Error> {
    let dest = inside(root, dest)?;
    if !dest.is_dir() {
        return Err(err("destination is not a folder"));
    }
    let root = root.canonicalize()?;
    let mut plan: Vec<(PathBuf, PathBuf)> = Vec::new();
    for p in paths {
        let from = inside(&root, p)?;
        if from == root {
            return Err(err("the library folder itself cannot be moved"));
        }
        let name = from.file_name().ok_or_else(|| err("no file name"))?;
        let to = dest.join(name);
        if from == to {
            continue; // already there
        }
        if from.is_dir() && dest.starts_with(&from) {
            return Err(err(format!(
                "cannot move “{}” into itself",
                name.to_string_lossy()
            )));
        }
        if to.symlink_metadata().is_ok() || plan.iter().any(|(_, t)| *t == to) {
            return Err(err(format!(
                "“{}” already exists in the destination",
                name.to_string_lossy()
            )));
        }
        plan.push((from, to));
    }
    let mut undo = Undo::default();
    let mut done = Vec::new();
    for (from, to) in plan {
        if let Err(e) = undo.rename(&from, &to) {
            return Err(rolled_back(&e, undo));
        }
        done.push(to);
    }
    Ok(done)
}

/// "name copy.ext", "name copy 2.ext", ... : the first sibling name not taken in `dir`.
fn copy_name(dir: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let direct = dir.join(name);
    if direct.symlink_metadata().is_err() {
        return direct;
    }
    let as_path = Path::new(name);
    let stem = as_path
        .file_stem()
        .map_or_else(|| name.to_string_lossy(), |s| s.to_string_lossy());
    let ext = as_path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (1..10_000)
        .map(|n| {
            let suffix = if n == 1 {
                " copy".to_owned()
            } else {
                format!(" copy {n}")
            };
            dir.join(format!("{stem}{suffix}{ext}"))
        })
        .find(|p| p.symlink_metadata().is_err())
        .unwrap_or(direct)
}

/// Recursively copies a file or folder. Symlinks inside are skipped so a copy can never
/// reach outside what was selected.
fn copy_tree(from: &Path, to: &Path) -> Result<(), Error> {
    if from.is_dir() {
        std::fs::create_dir(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            if entry.file_type()?.is_symlink() {
                continue;
            }
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else {
        std::fs::copy(from, to)?;
    }
    Ok(())
}

/// Copies every path into `dest`, never overwriting: a name already taken gets " copy" added.
/// Returns the new locations.
pub fn copy_into(root: &Path, paths: &[PathBuf], dest: &Path) -> Result<Vec<PathBuf>, Error> {
    let dest = inside(root, dest)?;
    if !dest.is_dir() {
        return Err(err("destination is not a folder"));
    }
    let root = root.canonicalize()?;
    let mut sources = Vec::new();
    for p in paths {
        let from = inside(&root, p)?;
        if from == root {
            return Err(err("the library folder itself cannot be copied"));
        }
        if from.is_dir() && dest.starts_with(&from) {
            return Err(err("cannot copy a folder into itself"));
        }
        sources.push(from);
    }
    let mut done: Vec<PathBuf> = Vec::new();
    for from in sources {
        let name = from.file_name().ok_or_else(|| err("no file name"))?;
        let to = copy_name(&dest, name);
        if let Err(e) = copy_tree(&from, &to) {
            // Every copy made by this call is new (names never collide), so removing is safe.
            for made in done.iter().chain(std::iter::once(&to)) {
                let _ = if made.is_dir() {
                    std::fs::remove_dir_all(made)
                } else {
                    std::fs::remove_file(made)
                };
            }
            return Err(err(format!("{e}. Nothing was changed.")));
        }
        done.push(to);
    }
    Ok(done)
}

/// Moves paths to the system Trash (recoverable). The library folder itself is protected.
pub fn trash(root: &Path, paths: &[PathBuf]) -> Result<(), Error> {
    let root = root.canonicalize()?;
    let mut resolved = Vec::new();
    for p in paths {
        let from = inside(&root, p)?;
        if from == root {
            return Err(err("the library folder itself cannot be deleted"));
        }
        resolved.push(from);
    }
    trash::delete_all(resolved).map_err(|e| err(format!("could not move to Trash: {e}")))
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("manplay-fs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("mkdir");
        d.canonicalize().expect("canon")
    }

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().expect("parent")).expect("mkdir");
        std::fs::write(p, b"x").expect("write");
    }

    #[test]
    fn lists_folders_first_and_hides_dotfiles() {
        let root = tmp("list");
        touch(&root.join("b.mp3"));
        touch(&root.join("a").join("t.mp3"));
        touch(&root.join(".hidden"));
        let names: Vec<String> = list(&root, &root)
            .expect("list")
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, vec!["a", "b.mp3"]);
    }

    #[test]
    fn refuses_paths_outside_the_root() {
        let root = tmp("outside").join("lib");
        std::fs::create_dir_all(&root).expect("mkdir");
        let other = root.parent().expect("parent").join("other");
        std::fs::create_dir_all(&other).expect("mkdir");
        assert!(list(&root, &other).is_err());
        assert!(list(&root, &root.join("..")).is_err());
        assert!(move_into(&root, &[other], &root).is_err());
    }

    #[test]
    fn names_must_be_single_segments() {
        for bad in ["", " ", ".", "..", "a/b", "a\\b", "../x"] {
            assert!(valid_name(bad).is_err(), "{bad:?}");
        }
        assert_eq!(valid_name("  ok name ").expect("ok"), "ok name");
    }

    #[test]
    fn make_dir_and_rename_never_overwrite() {
        let root = tmp("mk");
        let a = make_dir(&root, &root, "A").expect("mk");
        assert!(make_dir(&root, &root, "A").is_err());
        make_dir(&root, &root, "B").expect("mk");
        assert!(rename(&root, &a, "B").is_err());
        let renamed = rename(&root, &a, "C").expect("rename");
        assert!(renamed.is_dir() && !a.exists());
        assert!(rename(&root, &root, "X").is_err(), "root is protected");
    }

    #[test]
    fn move_is_all_or_nothing() {
        let root = tmp("mv");
        touch(&root.join("src").join("1.mp3"));
        touch(&root.join("src").join("2.mp3"));
        touch(&root.join("dst").join("2.mp3")); // collides
        let paths = [root.join("src/1.mp3"), root.join("src/2.mp3")];
        assert!(move_into(&root, &paths, &root.join("dst")).is_err());
        assert!(root.join("src/1.mp3").exists(), "nothing moved");

        std::fs::remove_file(root.join("dst/2.mp3")).expect("rm");
        let moved = move_into(&root, &paths, &root.join("dst")).expect("move");
        assert_eq!(moved.len(), 2);
        assert!(root.join("dst/1.mp3").exists() && !root.join("src/1.mp3").exists());
    }

    #[test]
    fn copy_never_overwrites_and_copies_folders() {
        let root = tmp("copy");
        touch(&root.join("a/song.mp3"));
        touch(&root.join("a/sub/deep.mp3"));
        let dest = root.join("a");
        let got = copy_into(&root, &[root.join("a/song.mp3")], &dest).expect("copy");
        assert_eq!(got, vec![root.join("a/song copy.mp3")]);
        let again = copy_into(&root, &[root.join("a/song.mp3")], &dest).expect("copy");
        assert_eq!(again, vec![root.join("a/song copy 2.mp3")]);

        std::fs::create_dir_all(root.join("b")).expect("mkdir");
        copy_into(&root, &[root.join("a/sub")], &root.join("b")).expect("copy dir");
        assert!(root.join("b/sub/deep.mp3").exists());
        assert!(root.join("a/sub/deep.mp3").exists(), "source untouched");
        assert!(copy_into(&root, &[root.join("a")], &root.join("a/sub")).is_err());
    }

    #[test]
    fn trash_refuses_the_root_and_outside_paths() {
        let root = tmp("trash").join("lib");
        std::fs::create_dir_all(&root).expect("mkdir");
        let outside = root.parent().expect("parent").join("x");
        touch(&outside);
        assert!(trash(&root, &[root.clone()]).is_err());
        assert!(trash(&root, &[outside.clone()]).is_err());
        assert!(outside.exists());
    }

    #[test]
    fn a_folder_cannot_move_into_itself_or_its_children() {
        let root = tmp("self");
        std::fs::create_dir_all(root.join("a/b")).expect("mkdir");
        assert!(move_into(&root, &[root.join("a")], &root.join("a")).is_err());
        assert!(move_into(&root, &[root.join("a")], &root.join("a/b")).is_err());
        assert!(move_into(&root, &[root.clone()], &root.join("a")).is_err());
    }

    #[test]
    fn undo_restores_renames_and_removes_new_folders() {
        let root = tmp("undo");
        touch(&root.join("a/1.mp3"));
        let mut undo = Undo::default();
        undo.create_dir_all(&root.join("x/y")).expect("dirs");
        undo.rename(&root.join("a/1.mp3"), &root.join("x/y/1.mp3"))
            .expect("rename");
        assert!(root.join("x/y/1.mp3").exists());
        assert_eq!(undo.rollback(), Vec::<PathBuf>::new());
        assert!(root.join("a/1.mp3").exists());
        assert!(!root.join("x").exists(), "new folders removed");
    }

    #[cfg(unix)]
    #[test]
    fn failed_copy_leaves_nothing_behind() {
        use std::os::unix::fs::PermissionsExt;
        let root = tmp("copyfail");
        touch(&root.join("ok.mp3"));
        touch(&root.join("dir/readable.mp3"));
        touch(&root.join("dir/locked.mp3"));
        let locked = root.join("dir/locked.mp3");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        if std::fs::File::open(&locked).is_ok() {
            return; // running as root: permissions do not apply
        }
        std::fs::create_dir_all(root.join("dest")).expect("mkdir");
        let paths = [root.join("ok.mp3"), root.join("dir")];
        assert!(copy_into(&root, &paths, &root.join("dest")).is_err());
        let left = std::fs::read_dir(root.join("dest")).expect("read").count();
        assert_eq!(left, 0, "partial copies removed");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).expect("chmod");
    }

    #[test]
    fn prune_empty_stops_at_root_and_non_empty() {
        let root = tmp("prune");
        std::fs::create_dir_all(root.join("a/b/c")).expect("mkdir");
        touch(&root.join("a/keep.mp3"));
        prune_empty(&root, &root.join("a/b/c"));
        assert!(!root.join("a/b").exists());
        assert!(root.join("a").exists(), "has a file");
        std::fs::remove_file(root.join("a/keep.mp3")).expect("rm");
        prune_empty(&root, &root.join("a"));
        assert!(root.exists() && !root.join("a").exists());
    }
}
