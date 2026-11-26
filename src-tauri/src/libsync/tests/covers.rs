//! Cover pictures: named in the log, moved as files (`covers.rs`), written into real song files.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, params};

use super::{Memory, open, replace_library_file, run_both, share};
use crate::libsync::covers::{self, Transfer};
use crate::libsync::{clock, journal};
use crate::libsync::membership::{self, LIBRARY_FILE, LIBRARY_FORMAT, LibraryFile};
use crate::libsync::song_tags::{self, COVER, TagWrite};
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
                "INSERT INTO tracks (path, artist, album, title, size, audio_fp, mtime_ms)
                 VALUES (?1, 'a', 'b', 's', 1, 'fp1', 0)",
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

    assert_eq!(
        changes(&b),
        [("covers".to_owned(), 1)],
        "a line of its own"
    );
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
        ("nothing left to remove", now + 2 * covers::UNUSED_KEPT_MS, 0, 1),
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
async fn a_library_of_the_format_before_is_moved_to_this_one() {
    let store = Memory::default();
    let a = Device::new("format", "a");
    assert!(
        membership::run_joined(&a.db, &store, "x")
            .await
            .error
            .is_none()
    );
    let read = |store: &Memory| -> LibraryFile {
        let meta = store.meta.lock().expect("lock");
        serde_json::from_slice(meta.get(LIBRARY_FILE).expect("library.json")).expect("json")
    };
    let mine = read(&store);
    assert_eq!(mine.format, LIBRARY_FORMAT);
    store.meta.lock().expect("lock").insert(
        LIBRARY_FILE.to_owned(),
        serde_json::to_vec(&LibraryFile { format: 1, ..mine }).expect("json"),
    );
    assert!(
        membership::run_joined(&a.db, &store, "x")
            .await
            .error
            .is_none()
    );
    assert_eq!(read(&store).format, LIBRARY_FORMAT);
    // Another library altogether is still refused, whatever its format.
    replace_library_file(&store);
    assert!(
        membership::run_joined(&a.db, &store, "x")
            .await
            .error
            .is_some()
    );
}
