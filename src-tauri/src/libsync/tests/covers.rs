//! Cover pictures: named in the log, moved as files (`covers.rs`), written into real song files.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, params};

use super::{Memory, open, run_both, share};
use crate::libsync::covers::{self, Transfer};
use crate::libsync::song_tags::{self, COVER, TagWrite};
use crate::libsync::{clock, journal};
use crate::tags;
use crate::tags::tests::{picture, silent_wav};

/// A device whose library is a real folder with one song in it.
struct Device {
    db: Mutex<Connection>,
    dir: PathBuf,
}

impl Device {
    fn new(test: &str, name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "manplay-covers-{}-{test}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("music")).expect("dirs");
        let device = Self {
            db: Mutex::new(open()),
            dir,
        };
        std::fs::write(device.song(), silent_wav()).expect("song");
        {
            let mut conn = device.db.lock().expect("lock");
            conn.execute(
                "INSERT INTO tracks (path, artist, album, title, size, audio_fp, mtime_ms, added_at)
                 VALUES (?1, 'a', 'b', 's', 1, 'fp1', 0, 0)",
                params![device.song().to_str()],
            )
            .expect("track");
            share(&mut conn);
        }
        device
    }

    fn root(&self) -> PathBuf {
        self.dir.join("music")
    }

    fn song(&self) -> PathBuf {
        self.root().join("1.wav")
    }

    fn cache(&self) -> PathBuf {
        self.dir.join("covers")
    }

    fn set_cover(&self, picture: Option<&[u8]>) {
        tags::set_cover(&self.song(), picture).expect("cover");
    }

    fn cover(&self) -> Option<Vec<u8>> {
        tags::front_cover(&self.song()).map(|(_, bytes)| bytes)
    }

    /// The file changed (or is new): its tags are read again and what changed is written down.
    fn look(&self) {
        let conn = self.db.lock().expect("lock");
        conn.execute("UPDATE tracks SET mtime_ms = mtime_ms + 1", [])
            .expect("touch");
        let read: Vec<_> = song_tags::unread(&conn, 10)
            .expect("unread")
            .into_iter()
            .map(|file| {
                let fields = song_tags::read_file(Path::new(&file.path));
                (file, fields)
            })
            .collect();
        song_tags::store(&conn, &read).expect("store");
        song_tags::record(&conn, &self.root()).expect("record");
    }

    fn wanted(&self) -> Vec<TagWrite> {
        song_tags::wanted(&self.db.lock().expect("lock"), &self.root()).expect("wanted")
    }

    async fn transfer(&self, store: &Memory) -> Transfer {
        covers::transfer(&self.db, store, &self.root(), &self.cache(), 10)
            .await
            .expect("transfer")
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Two devices in one library that both looked at their song once.
async fn two(test: &str, store: &Memory) -> (Device, Device) {
    let (a, b) = (Device::new(test, "a"), Device::new(test, "b"));
    a.look();
    b.look();
    assert!(run_both(&a.db, &b.db, store).await);
    (a, b)
}

fn files_on(store: &Memory, folder: &str) -> Vec<String> {
    let prefix = format!("{folder}/");
    store
        .meta
        .lock()
        .expect("lock")
        .keys()
        .filter(|path| path.starts_with(&prefix))
        .cloned()
        .collect()
}

fn pictures_on(store: &Memory) -> Vec<String> {
    files_on(store, covers::DIR)
}

fn requests_on(store: &Memory) -> Vec<String> {
    files_on(store, covers::WANTED_DIR)
}

fn changes(device: &Device) -> Vec<(String, usize)> {
    journal::list(&device.db.lock().expect("lock"), clock::now_ms())
        .expect("list")
        .iter()
        .flat_map(|batch| &batch.changes)
        .map(|change| (change.kind.clone(), change.count))
        .collect()
}

#[tokio::test]
async fn a_cover_set_on_one_device_ends_up_in_the_other_devices_file() {
    let store = Memory::default();
    let (a, b) = two("set", &store).await;
    let art = picture(10);
    a.set_cover(Some(&art));
    a.look();
    assert!(run_both(&a.db, &b.db, &store).await);

    assert_eq!(
        a.transfer(&store).await,
        Transfer {
            sent: 1,
            ..Transfer::default()
        }
    );
    assert_eq!(pictures_on(&store).len(), 1);
    assert_eq!(a.transfer(&store).await, Transfer::default(), "sent once");

    let waiting = b.wanted();
    assert!(waiting[0].cover().is_some());
    assert_eq!(
        waiting[0].clone().without_cover(),
        None,
        "nothing else to write while the picture is not here"
    );
    assert_eq!(
        b.transfer(&store).await,
        Transfer {
            fetched: 1,
            ..Transfer::default()
        }
    );
    assert_eq!(
        b.transfer(&store).await,
        Transfer::default(),
        "fetched once"
    );

    let backups = b.dir.join("backups");
    waiting[0].carry_out(&backups, &b.cache()).expect("write");
    assert_eq!(b.cover(), Some(art));
    assert_eq!(
        tags::front_cover(&backups.join("1.wav")),
        None,
        "the copy saved first is the file as it was"
    );
    b.look();
    assert_eq!(b.wanted().len(), 0, "B only followed");
    assert_eq!(b.transfer(&store).await, Transfer::default());

    assert_eq!(changes(&b), [("covers".to_owned(), 1)], "a line of its own");
    let batch = journal::list(&b.db.lock().expect("lock"), clock::now_ms()).expect("list")[0].id;
    journal::undo(&mut b.db.lock().expect("lock"), batch, clock::now_ms()).expect("undo");
    let back = b.wanted();
    assert_eq!(
        back[0].edits.get(COVER).map(String::as_str),
        Some(""),
        "taking it back takes the cover out again"
    );
}

#[tokio::test]
async fn covers_that_differed_when_the_devices_joined_are_asked_for_and_sent() {
    let store = Memory::default();
    let (a, b) = (Device::new("differ", "a"), Device::new("differ", "b"));
    a.set_cover(Some(&picture(40)));
    b.set_cover(Some(&picture(41)));
    a.look();
    b.look();
    assert!(run_both(&a.db, &b.db, &store).await);
    // The log has one cover for the song: one device's file is to get the other's.
    let (has, lacks) = if a.wanted().is_empty() {
        (&a, &b)
    } else {
        (&b, &a)
    };
    assert_eq!(lacks.wanted().len(), 1);
    let (replaced, _) = tags::front_cover(&lacks.song()).expect("its own cover");
    assert_eq!(
        has.transfer(&store).await,
        Transfer::default(),
        "joining sends no picture nobody waits for"
    );
    let asked = Transfer {
        asked: 1,
        ..Transfer::default()
    };
    assert_eq!(lacks.transfer(&store).await, asked);
    assert_eq!(
        lacks.transfer(&store).await,
        Transfer::default(),
        "asked once"
    );
    assert_eq!(requests_on(&store).len(), 1);
    assert_eq!(
        has.transfer(&store).await,
        Transfer {
            sent: 1,
            ..Transfer::default()
        }
    );
    assert_eq!(requests_on(&store).len(), 0, "answered");
    assert_eq!(
        lacks.transfer(&store).await,
        Transfer {
            fetched: 1,
            ..Transfer::default()
        }
    );
    lacks.wanted()[0]
        .carry_out(&lacks.dir.join("backups"), &lacks.cache())
        .expect("write");
    assert!(lacks.cover().is_some());
    assert_eq!(lacks.cover(), has.cover());
    assert!(
        lacks.cache().join(replaced.as_str()).exists(),
        "the cover it had is kept, for taking the change back"
    );
}

#[tokio::test]
async fn a_picture_no_song_has_any_more_is_removed_after_thirty_days() {
    let store = Memory::default();
    let (a, b) = two("unused", &store).await;
    for seed in [50, 51] {
        a.set_cover(Some(&picture(seed)));
        a.look();
        assert!(run_both(&a.db, &b.db, &store).await);
        a.transfer(&store).await;
    }
    assert_eq!(pictures_on(&store).len(), 2);
    let (current, _) = tags::front_cover(&a.song()).expect("cover");
    let nobodys = format!("{}/{}.jpg", covers::WANTED_DIR, "0".repeat(64));
    let someones = format!("{}/{}", covers::WANTED_DIR, current.as_str());
    for request in [&nobodys, &someones] {
        store
            .meta
            .lock()
            .expect("lock")
            .insert(request.clone(), Vec::new());
    }
    let now = clock::now_ms();
    let cases = [
        ("first seen unused", now, 0, 2),
        ("a day short", now + covers::UNUSED_KEPT_MS - 1, 0, 2),
        ("thirty days on", now + covers::UNUSED_KEPT_MS, 1, 1),
        (
            "nothing left to remove",
            now + 2 * covers::UNUSED_KEPT_MS,
            0,
            1,
        ),
    ];
    for (what, at, removed, left) in cases {
        let did = covers::clean(&a.db, &store, at).await.expect("clean");
        assert_eq!((did, pictures_on(&store).len()), (removed, left), "{what}");
    }
    assert_eq!(
        pictures_on(&store),
        [format!("{}/{}", covers::DIR, current.as_str())],
        "the cover the song has stays"
    );
    assert_eq!(
        requests_on(&store),
        [someones],
        "a request for a picture no song has is dropped"
    );
}

#[tokio::test]
async fn a_cover_taken_out_on_one_device_is_taken_out_on_the_other() {
    let store = Memory::default();
    let (a, b) = (Device::new("out", "a"), Device::new("out", "b"));
    let art = picture(20);
    a.set_cover(Some(&art));
    b.set_cover(Some(&art));
    a.look();
    b.look();
    assert!(run_both(&a.db, &b.db, &store).await);
    assert_eq!(
        a.transfer(&store).await,
        Transfer::default(),
        "a cover the files simply had is in every copy already"
    );
    a.set_cover(None);
    a.look();
    assert!(run_both(&a.db, &b.db, &store).await);
    let waiting = b.wanted();
    assert_eq!(waiting[0].edits.get(COVER).map(String::as_str), Some(""));
    waiting[0]
        .carry_out(&b.dir.join("backups"), &b.cache())
        .expect("write");
    assert_eq!(b.cover(), None);
}

#[tokio::test]
async fn a_picture_that_is_not_what_its_name_says_is_not_fetched() {
    let cases: [(&str, Vec<u8>); 3] = [
        ("another picture", picture(99)),
        ("not a picture", b"hello".to_vec()),
        ("nothing", Vec::new()),
    ];
    for (what, planted) in cases {
        let store = Memory::default();
        let (a, b) = two("planted", &store).await;
        a.set_cover(Some(&picture(30)));
        a.look();
        assert!(run_both(&a.db, &b.db, &store).await);
        a.transfer(&store).await;
        for path in pictures_on(&store) {
            store
                .meta
                .lock()
                .expect("lock")
                .insert(path, planted.clone());
        }
        assert_eq!(b.transfer(&store).await, Transfer::default(), "{what}");
        assert!(!b.cache().exists(), "{what}");
    }
}

#[tokio::test]
async fn a_cover_change_taken_back_restores_the_picture_even_when_the_destination_lost_it() {
    let store = Memory::default();
    let (a, b) = two("lost", &store).await;
    let (first, second) = (picture(60), picture(61));
    let backups = b.dir.join("backups");
    for art in [&first, &second] {
        a.set_cover(Some(art));
        a.look();
        assert!(run_both(&a.db, &b.db, &store).await);
        a.transfer(&store).await;
        b.transfer(&store).await;
        b.wanted()[0]
            .carry_out(&backups, &b.cache())
            .expect("write");
        b.look();
    }
    assert_eq!(b.cover(), Some(second));
    assert_eq!(
        tags::front_cover(&backups.join("1.wav")),
        None,
        "the copy from before the first write is not replaced by a later one"
    );
    // The first picture is no longer on the destination, and no song file has it.
    let (now_on_song, _) = tags::front_cover(&a.song()).expect("cover");
    store
        .meta
        .lock()
        .expect("lock")
        .retain(|path, _| !path.starts_with("covers/") || path.ends_with(now_on_song.as_str()));

    let newest = journal::list(&b.db.lock().expect("lock"), clock::now_ms()).expect("list")[0].id;
    journal::undo(&mut b.db.lock().expect("lock"), newest, clock::now_ms()).expect("undo");
    assert_eq!(
        b.transfer(&store).await,
        Transfer {
            sent: 1,
            ..Transfer::default()
        },
        "sent from the pictures B kept"
    );
    b.wanted()[0]
        .carry_out(&backups, &b.cache())
        .expect("write");
    assert_eq!(b.cover(), Some(first.clone()));
    assert!(run_both(&a.db, &b.db, &store).await);
    a.transfer(&store).await;
    a.wanted()[0]
        .carry_out(&a.dir.join("backups"), &a.cache())
        .expect("write");
    assert_eq!(a.cover(), Some(first));
}

#[tokio::test]
async fn a_picture_used_again_is_kept_thirty_days_from_when_it_is_next_unused() {
    let store = Memory::default();
    let (a, b) = two("again", &store).await;
    let set = |seed: u8| {
        a.set_cover(Some(&picture(seed)));
        a.look();
    };
    let now = clock::now_ms();
    let kept = covers::UNUSED_KEPT_MS;
    for seed in [70, 71] {
        set(seed);
        assert!(run_both(&a.db, &b.db, &store).await);
        a.transfer(&store).await;
    }
    assert_eq!(covers::clean(&a.db, &store, now).await.expect("clean"), 0);
    // The first picture is a song's cover again for a while, then not.
    for seed in [70, 71] {
        set(seed);
        assert!(run_both(&a.db, &b.db, &store).await);
        a.transfer(&store).await;
    }
    let cases = [
        ("thirty days from the first time", now + kept, 0),
        ("thirty days from the second", now + 2 * kept, 1),
    ];
    for (what, at, removed) in cases {
        assert_eq!(
            covers::clean(&a.db, &store, at).await.expect("clean"),
            removed,
            "{what}"
        );
    }
}

#[test]
fn an_old_picture_is_removed_unless_the_log_names_it_and_it_is_not_sent() {
    let named_unsent = format!("{}.jpg", "a".repeat(64));
    let named_sent = format!("{}.jpg", "b".repeat(64));
    let unnamed = format!("{}.jpg", "c".repeat(64));
    let conn = open();
    for name in [&named_unsent, &named_sent] {
        conn.execute(
            "INSERT INTO op_state (e, id, f, clock, val) VALUES (?1, ?2, ?3, 'c', ?4)",
            params![
                song_tags::E_SONG_TAGS,
                name,
                COVER,
                serde_json::to_string(name).expect("json")
            ],
        )
        .expect("op");
    }
    conn.execute("INSERT INTO covers_pushed (name) VALUES (?1)", [&named_sent])
        .expect("pushed");
    let dir = std::env::temp_dir().join(format!("manplay-covers-prune-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("dir");
    let long_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(40 * 86_400);
    for name in [&named_unsent, &named_sent, &unnamed] {
        let file = dir.join(name);
        std::fs::write(&file, b"x").expect("picture");
        std::fs::File::options()
            .write(true)
            .open(&file)
            .expect("open")
            .set_modified(long_ago)
            .expect("age");
    }
    tags::prune_cover_backups_except(&dir, &covers::unsent_names(&conn).expect("unsent"));
    let cases = [
        (&named_unsent, true),
        (&named_sent, false),
        (&unnamed, false),
    ];
    for (name, kept) in cases {
        assert_eq!(dir.join(name).exists(), kept, "{name}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
