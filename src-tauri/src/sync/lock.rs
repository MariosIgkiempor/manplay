//! One device at a time writes to a destination. The writer holds `.manplay/sync.lock`, created
//! in one step on the server so two devices racing for it cannot both win, and renews it every
//! minute. A device that crashed or lost its connection stops renewing, so its lock lapses after
//! [`LEASE_SECS`] and the next device takes it over.

use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};

use super::{Backend, base_of};
use crate::db::SyncTarget;
use crate::error::Error;
use crate::libsync;

type UnixSeconds = i64;

/// A device's id in the shared library (`libsync::write::device_id`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DeviceId(pub String);

/// The device asking for a lock: its id, and the name other devices show for it.
#[derive(Debug, Clone)]
pub struct Owner {
    pub device: DeviceId,
    pub name: String,
}

const LOCK_FILE: &str = "sync.lock";
/// How long a lock holds without being renewed. Renewed every [`RENEW_EVERY`], so it also absorbs
/// a few minutes of clock difference between devices.
const LEASE_SECS: UnixSeconds = 5 * 60;
const RENEW_EVERY: Duration = Duration::from_secs(60);

/// What `sync.lock` holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockFile {
    device: DeviceId,
    name: String,
    expires_at: UnixSeconds,
}

/// What the lock found on the destination means for this device.
#[derive(Debug, PartialEq, Eq)]
enum Standing {
    Free,
    /// Left by this device, e.g. by a run that crashed.
    Ours,
    /// Lapsed, or unreadable: nobody is renewing it.
    Stale,
    Busy {
        name: String,
        expires_at: UnixSeconds,
    },
}

/// What is at the lock's path on the destination.
#[derive(Debug)]
enum Found {
    Absent,
    /// There, but not a lock file this version can read.
    Unreadable,
    Lock(LockFile),
}

fn standing(found: &Found, me: &DeviceId, now: UnixSeconds) -> Standing {
    match found {
        Found::Absent => Standing::Free,
        Found::Unreadable => Standing::Stale,
        Found::Lock(lock) if lock.device == *me => Standing::Ours,
        Found::Lock(lock) if lock.expires_at <= now => Standing::Stale,
        Found::Lock(lock) => Standing::Busy {
            name: lock.name.clone(),
            expires_at: lock.expires_at,
        },
    }
}

/// `place` is what is locked, as a sentence names it ("this destination").
fn busy_message(name: &str, expires_at: UnixSeconds, now: UnixSeconds, place: &str) -> String {
    let minutes = ((expires_at - now).max(0) + 59) / 60;
    let minutes = minutes.max(1);
    format!(
        "{name} is syncing with {place}. Try again when it finishes; if it stopped, \
         {place} frees up within {minutes} min."
    )
}

fn lock_path(target: &SyncTarget) -> Vec<String> {
    let mut path = base_of(target);
    path.extend([libsync::remote::DIR.to_owned(), LOCK_FILE.to_owned()]);
    path
}

fn scratch(target: &SyncTarget, what: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "manplay-lock-{}-{}-{what}.json",
        std::process::id(),
        target.id
    ))
}

async fn read(backend: &Backend<'_>, path: &[String], tmp: &Path) -> Result<Found, Error> {
    if backend.remote_size(path).await?.is_none() {
        return Ok(Found::Absent);
    }
    backend.get(path, tmp).await?;
    let bytes = tokio::fs::read(tmp).await;
    let _ = tokio::fs::remove_file(tmp).await;
    Ok(serde_json::from_slice(&bytes?).map_or(Found::Unreadable, Found::Lock))
}

async fn write_scratch(tmp: &Path, owner: &Owner, now: UnixSeconds) -> Result<(), Error> {
    let lock = LockFile {
        device: owner.device.clone(),
        name: owner.name.clone(),
        expires_at: now + LEASE_SECS,
    };
    let bytes = serde_json::to_vec(&lock).map_err(|e| Error::Msg(e.to_string()))?;
    tokio::fs::write(tmp, bytes).await?;
    Ok(())
}

/// A lock this device holds on a destination, renewed in the background until released.
pub struct Held {
    renewer: tauri::async_runtime::JoinHandle<()>,
    client: Client,
    target: SyncTarget,
    device: DeviceId,
}

/// Takes the destination's lock, or fails with who holds it.
pub async fn acquire(client: &Client, target: &SyncTarget, owner: &Owner) -> Result<Held, Error> {
    let backend = Backend::for_target(client, target)?;
    let path = lock_path(target);
    backend.mkdir(&path[..path.len() - 1]).await?;
    let tmp = scratch(target, "acquire");
    // A second pass covers losing a race for a stale lock: the winner then shows as busy.
    for _ in 0..2 {
        let now = crate::unix_now();
        let found = read(&backend, &path, &tmp).await?;
        match standing(&found, &owner.device, now) {
            Standing::Busy { name, expires_at } => {
                return Err(Error::Msg(busy_message(
                    &name,
                    expires_at,
                    now,
                    "this destination",
                )));
            }
            Standing::Ours | Standing::Stale => backend.delete(&path).await?,
            Standing::Free => {}
        }
        write_scratch(&tmp, owner, now).await?;
        let created = backend.put_new(&path, &tmp, &owner.device.0).await;
        let _ = tokio::fs::remove_file(&tmp).await;
        if created? {
            return Ok(Held {
                renewer: tauri::async_runtime::spawn(renew(
                    client.clone(),
                    target.clone(),
                    owner.clone(),
                )),
                client: client.clone(),
                target: target.clone(),
                device: owner.device.clone(),
            });
        }
    }
    Err(Error::Msg(
        "Another device is syncing with this destination. Try again when it finishes.".to_owned(),
    ))
}

/// Pushes the lock's expiry forward every minute while it is still this device's.
async fn renew(client: Client, target: SyncTarget, owner: Owner) {
    let path = lock_path(&target);
    let tmp = scratch(&target, "renew");
    loop {
        tokio::time::sleep(RENEW_EVERY).await;
        let Ok(backend) = Backend::for_target(&client, &target) else {
            continue;
        };
        let still_ours = matches!(
            read(&backend, &path, &tmp).await,
            Ok(Found::Lock(lock)) if lock.device == owner.device
        );
        if !still_ours {
            eprintln!("sync lock on target {} was taken over", target.id);
            return;
        }
        if write_scratch(&tmp, &owner, crate::unix_now()).await.is_ok() {
            if let Err(e) = backend.put_whole(&path, &tmp, true).await {
                eprintln!("sync lock on target {} not renewed: {e}", target.id);
            }
            let _ = tokio::fs::remove_file(&tmp).await;
        }
    }
}

impl Held {
    /// Gives the lock back, if it is still this device's.
    pub async fn release(self) {
        self.renewer.abort();
        let Ok(backend) = Backend::for_target(&self.client, &self.target) else {
            return;
        };
        let path = lock_path(&self.target);
        let tmp = scratch(&self.target, "release");
        if let Ok(Found::Lock(lock)) = read(&backend, &path, &tmp).await
            && lock.device == self.device
        {
            let _ = backend.delete(&path).await;
        }
    }
}

impl Drop for Held {
    /// Without a release (e.g. a panic) the lock stops being renewed and lapses on its own.
    fn drop(&mut self) {
        self.renewer.abort();
    }
}

// ---- the library folder -------------------------------------------------------------

/// What a lock file in the library folder holds, read from disk.
async fn read_file(path: &Path) -> Result<Found, Error> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).map_or(Found::Unreadable, Found::Lock)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Found::Absent),
        Err(e) => Err(e.into()),
    }
}

fn lock_json(owner: &Owner, now: UnixSeconds) -> Result<Vec<u8>, Error> {
    serde_json::to_vec(&LockFile {
        device: owner.device.clone(),
        name: owner.name.clone(),
        expires_at: now + LEASE_SECS,
    })
    .map_err(|e| Error::Msg(e.to_string()))
}

/// Puts a whole lock file at `path` only if there is none: written aside, then hard-linked into
/// place, which fails when the name is taken. A folder that cannot hold hard links (some network
/// shares) gets it created-if-new and then written. False when another device's is there.
async fn create_file(path: &Path, bytes: &[u8]) -> Result<bool, Error> {
    let tmp = path.with_extension(format!("{}.new", std::process::id()));
    tokio::fs::write(&tmp, bytes).await?;
    let linked = tokio::fs::hard_link(&tmp, path).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    match linked {
        Ok(()) => return Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(_) => {}
    }
    let opened = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await;
    match opened {
        Ok(mut file) => {
            use tokio::io::AsyncWriteExt;
            file.write_all(bytes).await?;
            file.flush().await?;
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// A lock this device holds on the library folder's shared library, renewed until released.
pub struct HeldFolder {
    renewer: tauri::async_runtime::JoinHandle<()>,
    path: PathBuf,
    device: DeviceId,
}

/// Takes the lock of the shared library in the library folder `root`, or fails with who holds
/// it. Same file and rules as on a destination.
pub async fn acquire_folder(root: &Path, owner: &Owner) -> Result<HeldFolder, Error> {
    let path = root.join(libsync::remote::DIR).join(LOCK_FILE);
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    for _ in 0..2 {
        let now = crate::unix_now();
        match standing(&read_file(&path).await?, &owner.device, now) {
            Standing::Busy { name, expires_at } => {
                return Err(Error::Msg(busy_message(
                    &name,
                    expires_at,
                    now,
                    "the library folder",
                )));
            }
            Standing::Ours | Standing::Stale => match tokio::fs::remove_file(&path).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            },
            Standing::Free => {}
        }
        if create_file(&path, &lock_json(owner, now)?).await? {
            return Ok(HeldFolder {
                renewer: tauri::async_runtime::spawn(renew_file(path.clone(), owner.clone())),
                path,
                device: owner.device.clone(),
            });
        }
    }
    Err(Error::Msg(
        "Another device is syncing with the library folder. Try again when it finishes.".to_owned(),
    ))
}

/// Pushes the folder lock's expiry forward every minute while it is still this device's.
async fn renew_file(path: PathBuf, owner: Owner) {
    loop {
        tokio::time::sleep(RENEW_EVERY).await;
        let still_ours = matches!(
            read_file(&path).await,
            Ok(Found::Lock(lock)) if lock.device == owner.device
        );
        if !still_ours {
            log::warn!("the library folder's sync lock was taken over");
            return;
        }
        let renewed = match lock_json(&owner, crate::unix_now()) {
            Ok(bytes) => libsync::folder::write_whole(&path, &bytes).await,
            Err(e) => Err(e),
        };
        if let Err(e) = renewed {
            log::warn!("the library folder's sync lock was not renewed: {e}");
        }
    }
}

impl HeldFolder {
    /// Gives the lock back, if it is still this device's.
    pub async fn release(self) {
        self.renewer.abort();
        if let Ok(Found::Lock(lock)) = read_file(&self.path).await
            && lock.device == self.device
        {
            let _ = tokio::fs::remove_file(&self.path).await;
        }
    }
}

impl Drop for HeldFolder {
    /// Without a release the lock stops being renewed and lapses on its own.
    fn drop(&mut self) {
        self.renewer.abort();
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    fn lock(device: &str, expires_at: UnixSeconds) -> LockFile {
        LockFile {
            device: DeviceId(device.to_owned()),
            name: format!("{device}'s Mac"),
            expires_at,
        }
    }

    #[test]
    fn who_may_take_the_lock() {
        let me = DeviceId("me".to_owned());
        let now = 1_000;
        let busy = Standing::Busy {
            name: "other's Mac".to_owned(),
            expires_at: 1_001,
        };
        let cases = [
            ("no lock file", Found::Absent, Standing::Free),
            ("unreadable lock file", Found::Unreadable, Standing::Stale),
            (
                "left by this device",
                Found::Lock(lock("me", 5_000)),
                Standing::Ours,
            ),
            (
                "another device, lapsed",
                Found::Lock(lock("other", 1_000)),
                Standing::Stale,
            ),
            (
                "another device, live",
                Found::Lock(lock("other", 1_001)),
                busy,
            ),
        ];
        for (case, found, expected) in cases {
            assert_eq!(standing(&found, &me, now), expected, "{case}");
        }
    }

    #[test]
    fn lock_file_round_trips_and_rejects_bad_input() {
        let parsed: LockFile =
            serde_json::from_str(r#"{"device":"d1","name":"Studio","expiresAt":42}"#)
                .expect("valid lock file");
        assert_eq!(
            parsed,
            LockFile {
                device: DeviceId("d1".to_owned()),
                name: "Studio".to_owned(),
                expires_at: 42,
            }
        );
        for bad in [
            "",
            "{}",
            r#"{"device":"d1","name":"Studio"}"#,
            r#"{"device":"d1","name":"Studio","expiresAt":"soon"}"#,
            "half a fi",
        ] {
            assert!(serde_json::from_str::<LockFile>(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn busy_message_rounds_up_to_whole_minutes() {
        for (left, minutes) in [(0, 1), (1, 1), (60, 1), (61, 2), (300, 5)] {
            let msg = busy_message("Studio", 1_000 + left, 1_000, "this destination");
            assert!(
                msg.contains(&format!("within {minutes} min")),
                "{left}s: {msg}"
            );
        }
    }
}
