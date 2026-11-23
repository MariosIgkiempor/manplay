//! Reproductions of the ways a sync can leave duplicate songs. Everything runs in throwaway temp
//! folders: a library folder, its own database, and a folder standing in for the destination.
#![allow(clippy::expect_used)]

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::{Remote, diff, in_library, is_audio_name, pair};
use crate::sync_scans::{KnownLibrary, missing_files};
use crate::{SETTING_ROOT, collect_items, collect_known, db, detect_moves, reconcile_missing};

struct World {
    tmp: PathBuf,
    root: PathBuf,
    dest: PathBuf,
    conn: Connection,
}

impl World {
    fn new(name: &str) -> Self {
        let tmp = std::env::temp_dir().join(format!("manplay-dup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("library")).expect("mkdir");
        std::fs::create_dir_all(tmp.join("dest")).expect("mkdir");
        let tmp = tmp.canonicalize().expect("canon");
        let root = tmp.join("library");
        let conn = db::open(&tmp.join("library.db")).expect("db");
        db::set_setting(&conn, SETTING_ROOT, root.to_str()).expect("root");
        Self {
            dest: tmp.join("dest"),
            root,
            tmp,
            conn,
        }
    }

    /// The same steps as `scan_and_store`.
    fn scan(&mut self) {
        let known = db::scanned_tracks(&self.conn).expect("known");
        let result = crate::scan::scan(&self.root, known);
        detect_moves(&mut self.conn, &self.tmp, &self.root, &result).expect("moves");
        db::upsert(&mut self.conn, &result.tracks).expect("upsert");
        reconcile_missing(&mut self.conn, &self.tmp, &result).expect("missing");
    }

    /// Copies the library onto the destination as a finished sync would leave it.
    fn sync_everything(&self) {
        for file in files_under(&self.root) {
            let rel = file.strip_prefix(&self.root).expect("rel");
            let to = self.dest.join(rel);
            std::fs::create_dir_all(to.parent().expect("parent")).expect("mkdir");
            std::fs::copy(&file, &to).expect("copy");
        }
    }

    fn listing(&self) -> Vec<Remote> {
        files_under(&self.dest)
            .into_iter()
            .map(|f| Remote {
                rel: rel_of(&self.dest, &f),
                size: std::fs::metadata(&f).expect("meta").len(),
                version: None,
            })
            .collect()
    }

    /// The pull and push decisions of a destination read: `plan_target`'s extras handling
    /// (sync.rs, "Files of tracks that went missing only recently are kept" onwards) and the
    /// `pull.missing` filter in `lib.rs`. `unreadable` destination files fail their range reads.
    fn read(&self, unreadable: &[&str]) -> Read {
        let items = collect_items(&self.conn).expect("items");
        let known = collect_known(&self.conn).expect("known");
        let remote = self.listing();
        let d = diff(&items, &remote);
        let (held, candidates): (Vec<&Remote>, Vec<&Remote>) = d
            .extras
            .iter()
            .partition(|r| known.get(&r.rel).is_some_and(|k| k.in_grace));
        let printed = |list: &[&Remote]| -> Vec<(Remote, Option<String>)> {
            list.iter()
                .map(|r| {
                    let readable = !unreadable.contains(&r.rel.join("/").as_str());
                    let print = (is_audio_name(&r.rel) && readable)
                        .then(|| self.remote_identity(r))
                        .flatten();
                    ((*r).clone(), print)
                })
                .collect()
        };
        let owned = printed(&candidates);
        let extras: Vec<(&Remote, Option<String>)> =
            owned.iter().map(|(r, p)| (r, p.clone())).collect();
        let held_owned = printed(&held);
        let all: Vec<(&Remote, Option<String>)> = extras
            .iter()
            .cloned()
            .chain(held_owned.iter().map(|(r, p)| (r, p.clone())))
            .collect();
        let found = in_library(&items, &all);
        let matched = pair(&items, &d.uploads, &extras);
        let present = db::present_sizes(&self.conn).expect("present");
        let pull: Vec<String> = missing_files(&remote, &self.root, &KnownLibrary::of(&present))
            .into_iter()
            .filter(|m| !found.contains(&m.file.rel))
            .map(|m| m.file.rel.join("/"))
            .collect();
        Read {
            replaces: d.replaces.iter().map(|(i, _)| i.rel.join("/")).collect(),
            held: held.iter().map(|r| r.rel.join("/")).collect(),
            pull,
            uploads: matched.uploads.iter().map(|i| i.rel.join("/")).collect(),
            moves: matched
                .moves
                .iter()
                .map(|(r, i)| (r.rel.join("/"), i.rel.join("/")))
                .collect(),
        }
    }

    /// `fingerprint_one`, reading the destination file directly instead of by range requests.
    fn remote_identity(&self, r: &Remote) -> Option<String> {
        let path = r.rel.iter().fold(self.dest.clone(), |p, s| p.join(s));
        if let Some(audio) = crate::audioprint::audio_print_path(&path) {
            return Some(audio);
        }
        crate::sync::library_identity(None, crate::scan::fingerprint(&path, r.size))
    }

    /// `pull_file` for each path: downloads unless a file is already there.
    fn pull(&self, rels: &[String]) {
        for rel in rels {
            let to = self.root.join(rel);
            if to.exists() {
                continue;
            }
            std::fs::create_dir_all(to.parent().expect("parent")).expect("mkdir");
            std::fs::copy(self.dest.join(rel), &to).expect("pull");
        }
    }

    fn duplicate_groups(&self) -> usize {
        db::duplicate_groups(&self.conn).expect("dups").len()
    }

    fn present_paths(&self) -> Vec<String> {
        let mut v: Vec<String> = db::present_sizes(&self.conn)
            .expect("present")
            .into_iter()
            .map(|(p, _)| rel_of(&self.root, Path::new(&p)).join("/"))
            .collect();
        v.sort();
        v
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.tmp);
    }
}

#[derive(Debug)]
struct Read {
    /// Same path on both sides, different size: planned as an update one way or the other.
    replaces: Vec<String>,
    held: Vec<String>,
    pull: Vec<String>,
    uploads: Vec<String>,
    moves: Vec<(String, String)>,
}

fn files_under(dir: &Path) -> Vec<PathBuf> {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(walkdir::DirEntry::into_path)
        .collect()
}

fn rel_of(base: &Path, p: &Path) -> Vec<String> {
    p.strip_prefix(base)
        .expect("under base")
        .iter()
        .map(|s| s.to_string_lossy().into_owned())
        .collect()
}

/// A real MP3 made by ffmpeg with artist and album tags in ID3 version 2.`id3v2`.
fn real_mp3(path: &Path, id3v2: u8) {
    let ffmpeg = crate::convert::find_ffmpeg().expect("ffmpeg");
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    let out = std::process::Command::new(ffmpeg)
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=3",
        ])
        .args(["-metadata", "artist=Artist", "-metadata", "album=Album"])
        .args([
            "-metadata",
            "title=Song",
            "-id3v2_version",
            &id3v2.to_string(),
        ])
        .args(["-c:a", "libmp3lame", "-b:a", "128k"])
        .arg(path)
        .output()
        .expect("run ffmpeg");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Fix issues on an MP3 with ID3v2.4 tags in a one-folder layout: the tags are rewritten as
/// v2.3 (the file changes size) and the file moves to `Artist/Album/`. The scan follows the
/// song by its audio, so the destination copy is moved rather than pulled back.
#[test]
fn h1_fix_issues_retag_and_move_is_followed() {
    let mut w = World::new("h1");
    real_mp3(&w.root.join("Loose/song.mp3"), 4);
    w.scan();
    let id_before = collect_items(&w.conn).expect("items")[0].track_id;
    w.sync_everything();
    let before = w.read(&[]);
    assert!(
        before.pull.is_empty() && before.uploads.is_empty(),
        "{before:?}"
    );

    let fixed = crate::audit::fix_file(&w.root, &w.root.join("Loose/song.mp3"), None).expect("fix");
    assert_eq!(rel_of(&w.root, &fixed).join("/"), "Loose/Album/song.mp3");
    w.scan();

    let items = collect_items(&w.conn).expect("items");
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0].track_id, id_before,
        "same track row, tags and playlists kept"
    );
    assert_eq!(db::missing_count(&w.conn).expect("missing"), 0);

    let after = w.read(&[]);
    println!("H1 after fix: {after:?}");
    assert!(after.held.is_empty() && after.pull.is_empty(), "{after:?}");
    assert!(after.uploads.is_empty(), "{after:?}");
    assert_eq!(
        after.moves,
        [(
            "Loose/song.mp3".to_owned(),
            "Loose/Album/song.mp3".to_owned()
        )]
    );
    assert_eq!(w.duplicate_groups(), 0);
}

/// Two new copies of a song whose old file vanished: the scan cannot tell which one is the move,
/// so it links neither and the old destination copy is held. It is still recognised as in the
/// library, so it is not offered for pull.
#[test]
fn h1_held_copy_with_the_same_audio_is_not_offered_for_pull() {
    let mut w = World::new("h1held");
    real_mp3(&w.root.join("Artist/Album/song.mp3"), 4);
    w.scan();
    w.sync_everything();
    let edits = [(
        "title".to_owned(),
        "Retagged with a longer title".to_owned(),
    )]
    .into_iter()
    .collect();
    for to in ["Artist/Other/song.mp3", "Artist/Third/song.mp3"] {
        let to = w.root.join(to);
        std::fs::create_dir_all(to.parent().expect("parent")).expect("mkdir");
        std::fs::copy(w.root.join("Artist/Album/song.mp3"), &to).expect("copy");
        crate::tags::write_file(&to, &edits).expect("tag");
    }
    std::fs::remove_file(w.root.join("Artist/Album/song.mp3")).expect("remove");
    w.scan();
    assert_eq!(
        db::missing_count(&w.conn).expect("missing"),
        1,
        "ambiguous: not linked"
    );

    let read = w.read(&[]);
    println!("H1 held: {read:?}");
    assert_eq!(read.held, ["Artist/Album/song.mp3"]);
    assert!(read.pull.is_empty(), "{read:?}");
}

/// Control for H1: the same move without changing any bytes is recognised.
#[test]
fn h1_control_move_without_retag_is_recognised() {
    let mut w = World::new("h1c");
    real_mp3(&w.root.join("Loose/song.mp3"), 3);
    w.scan();
    w.sync_everything();
    crate::audit::fix_file(&w.root, &w.root.join("Loose/song.mp3"), None).expect("fix");
    w.scan();
    let after = w.read(&[]);
    println!("H1 control: {after:?}");
    assert!(after.held.is_empty() && after.pull.is_empty(), "{after:?}");
    assert_eq!(after.moves.len(), 1, "planned as a move on the destination");
}

/// Your hypothesis: a tag edit in place (same path, new size) never duplicates, whichever side
/// was edited.
#[test]
fn metadata_only_change_at_the_same_path_does_not_duplicate() {
    struct Case {
        name: &'static str,
        edit_destination: bool,
        edit_library: bool,
    }
    let cases = [
        Case {
            name: "destination only",
            edit_destination: true,
            edit_library: false,
        },
        Case {
            name: "library only",
            edit_destination: false,
            edit_library: true,
        },
        Case {
            name: "both sides",
            edit_destination: true,
            edit_library: true,
        },
    ];
    for case in cases {
        let mut w = World::new(&format!("meta-{}", case.name.replace(' ', "-")));
        let rel = "Artist/Album/song.mp3";
        real_mp3(&w.root.join(rel), 3);
        w.scan();
        w.sync_everything();
        let edits = [(
            "title".to_owned(),
            "A much longer title than before".to_owned(),
        )]
        .into_iter()
        .collect();
        for (edit, file) in [
            (case.edit_destination, w.dest.join(rel)),
            (case.edit_library, w.root.join(rel)),
        ] {
            if edit {
                let before = std::fs::metadata(&file).expect("meta").len();
                crate::tags::write_file(&file, &edits).expect("tag");
                let after = std::fs::metadata(&file).expect("meta").len();
                assert_ne!(before, after, "{}: the edit changes the size", case.name);
            }
        }
        w.scan();
        let read = w.read(&[]);
        println!("metadata only, {}: {read:?}", case.name);
        assert!(read.pull.is_empty(), "{}: {read:?}", case.name);
        assert!(
            read.uploads.is_empty() && read.moves.is_empty(),
            "{}: {read:?}",
            case.name
        );
        let updated: &[&str] = if case.edit_destination == case.edit_library {
            &[]
        } else {
            &[rel]
        };
        assert_eq!(read.replaces, updated, "{}: updated in place", case.name);
        w.pull(&read.pull);
        w.scan();
        assert_eq!(w.duplicate_groups(), 0, "{}", case.name);
        assert_eq!(w.present_paths(), [rel], "{}", case.name);
    }
}

/// A song whose audio cannot be fingerprinted gets identity `""` instead of its `file:` print,
/// so a renamed destination copy of it is never recognised.
#[test]
fn h2_unprintable_audio_is_never_matched() {
    let mut w = World::new("h2");
    let local = w.root.join("Artist/Album/odd.mp3");
    std::fs::create_dir_all(local.parent().expect("parent")).expect("mkdir");
    #[allow(clippy::cast_possible_truncation)]
    let junk: Vec<u8> = (0..400_000_u32).map(|i| (i * 7 % 253) as u8).collect();
    std::fs::write(&local, &junk).expect("write");
    w.scan();
    let identity = collect_items(&w.conn).expect("items")[0].identity.clone();
    println!("H2 local identity: {identity:?}");
    assert_eq!(identity.as_deref(), Some(""));

    // The same bytes on the destination under another name.
    std::fs::create_dir_all(w.dest.join("Artist/Album")).expect("mkdir");
    std::fs::write(w.dest.join("Artist/Album/odd (renamed).mp3"), &junk).expect("write");
    let read = w.read(&[]);
    println!("H2: {read:?}");
    assert_eq!(read.pull, ["Artist/Album/odd (renamed).mp3"]);
    assert_eq!(read.uploads, ["Artist/Album/odd.mp3"]);
    assert_eq!(read.moves.len(), 0, "{read:?}");
}

/// A destination file whose range reads fail is offered for pull even though the library has it.
#[test]
fn h3_unreadable_destination_file_is_offered_for_pull() {
    let mut w = World::new("h3");
    real_mp3(&w.root.join("Artist/Album/song.mp3"), 3);
    w.scan();
    std::fs::create_dir_all(w.dest.join("Old")).expect("mkdir");
    std::fs::copy(
        w.root.join("Artist/Album/song.mp3"),
        w.dest.join("Old/renamed.mp3"),
    )
    .expect("copy");
    assert!(w.read(&[]).pull.is_empty(), "recognised when readable");
    let read = w.read(&["Old/renamed.mp3"]);
    println!("H3: {read:?}");
    assert_eq!(read.pull, ["Old/renamed.mp3"]);
}

/// `remote_pull` with a folder chosen: every file under it is downloaded, including songs the
/// library already has under another path.
#[test]
fn h4_pulling_a_folder_ignores_the_plan() {
    let mut w = World::new("h4");
    real_mp3(&w.root.join("Artist/Album/song.mp3"), 3);
    w.scan();
    std::fs::create_dir_all(w.dest.join("Inbox")).expect("mkdir");
    std::fs::copy(
        w.root.join("Artist/Album/song.mp3"),
        w.dest.join("Inbox/song copy.mp3"),
    )
    .expect("copy");
    assert!(
        w.read(&[]).pull.is_empty(),
        "the plan knows it is in the library"
    );

    // The filter `remote_pull` applies to the listing.
    let wanted: HashSet<Vec<String>> = [vec!["Inbox".to_owned()]].into_iter().collect();
    let chosen: Vec<String> = w
        .listing()
        .into_iter()
        .filter(|r| (1..=r.rel.len()).any(|n| wanted.contains(&r.rel[..n])))
        .map(|r| r.rel.join("/"))
        .collect();
    w.pull(&chosen);
    w.scan();
    println!("H4 library: {:?}", w.present_paths());
    assert_eq!(w.duplicate_groups(), 1);
}
