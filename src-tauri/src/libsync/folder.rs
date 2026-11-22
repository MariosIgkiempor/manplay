//! A shared library kept in the library folder itself (`<library folder>/.manplay/`), for a
//! folder that several computers reach: a network share, or a folder a sync app copies around.
//! The layout is the same as on a destination (`remote.rs`, `membership.rs`), so the same rules
//! hold: a device writes only its own files, and every file appears whole (written under a
//! temporary name, then renamed).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use super::compact;
use super::remote::{self, ChunkInfo, ChunkRef, ChunkStore};
use super::waveforms::{self, WaveformRef};
use crate::error::Error;

/// The `.manplay/` folder inside a library folder, as a place for chunks and member files.
pub struct FolderStore {
    /// `<library folder>/.manplay`.
    dir: PathBuf,
}

/// A name from a listing that is safe as one path segment (no dot files, no separators).
fn plain_segment(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('.') && !s.contains(['/', '\\'])
}

/// Names of the entries directly inside `dir` that are files (or folders, with `folders`).
/// A folder that is missing has none.
async fn entries(dir: &Path, folders: bool) -> Result<Vec<String>, Error> {
    let mut read = match tokio::fs::read_dir(dir).await {
        Ok(read) => read,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut names = Vec::new();
    while let Some(entry) = read.next_entry().await? {
        let is_dir = entry.file_type().await?.is_dir();
        if is_dir != folders {
            continue;
        }
        if let Some(name) = entry.file_name().to_str()
            && plain_segment(name)
        {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}

async fn read_if_there(path: &Path) -> Result<Option<Vec<u8>>, Error> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

async fn remove_if_there(path: &Path) -> Result<(), Error> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Writes `bytes` next to `dest` under a temporary name (a dot file, so listings skip it), then
/// renames it into place: a reader on another computer never sees half a file.
pub(crate) async fn write_whole(dest: &Path, bytes: &[u8]) -> Result<(), Error> {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = dest
        .parent()
        .ok_or_else(|| Error::Msg(format!("{} has no folder", dest.display())))?;
    tokio::fs::create_dir_all(dir).await?;
    let name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Error::Msg(format!("{} has no name", dest.display())))?;
    let tmp = dir.join(format!(
        ".{name}.{}-{}.tmp",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    tokio::fs::write(&tmp, bytes).await?;
    let renamed = tokio::fs::rename(&tmp, dest).await;
    if renamed.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    Ok(renamed?)
}

impl FolderStore {
    /// The store of the library folder `root`.
    pub fn new(root: &Path) -> Self {
        Self {
            dir: root.join(remote::DIR),
        }
    }

    fn chunk_path(&self, chunk: &ChunkRef) -> Result<PathBuf, Error> {
        if !plain_segment(&chunk.dev) {
            return Err(Error::Msg(format!("unsafe device id: {}", chunk.dev)));
        }
        Ok(self
            .dir
            .join(remote::LOG_DIR)
            .join(&chunk.dev)
            .join(remote::chunk_name(chunk.seq)))
    }

    fn waveform_path(&self, w: &WaveformRef) -> Result<PathBuf, Error> {
        let (sub, name) = w
            .rel()
            .ok_or_else(|| Error::Msg("this song's audio print cannot name a file".into()))?;
        Ok(self.dir.join(waveforms::DIR).join(sub).join(name))
    }

    /// Full path of a small file under `.manplay/`, from its `/`-separated path there.
    fn meta_path(&self, path: &str) -> Result<PathBuf, Error> {
        let mut full = self.dir.clone();
        for seg in path.split('/') {
            if seg.is_empty() || seg == "." || seg == ".." || seg.contains(['\\', ':']) {
                return Err(Error::Msg(format!("unsafe path under .manplay: {path}")));
            }
            full.push(seg);
        }
        Ok(full)
    }
}

impl ChunkStore for FolderStore {
    async fn list_chunks(&self) -> Result<Vec<ChunkInfo>, Error> {
        let log = self.dir.join(remote::LOG_DIR);
        let mut out = Vec::new();
        for dev in entries(&log, true).await? {
            for name in entries(&log.join(&dev), false).await? {
                let Some(seq) = remote::parse_chunk_name(&name) else {
                    continue;
                };
                let size = tokio::fs::metadata(log.join(&dev).join(&name))
                    .await
                    .map_or(0, |m| m.len());
                out.push(ChunkInfo {
                    chunk: ChunkRef {
                        dev: dev.clone(),
                        seq,
                    },
                    size,
                });
            }
        }
        Ok(out)
    }

    async fn delete_chunk(&self, chunk: &ChunkRef) -> Result<(), Error> {
        remove_if_there(&self.chunk_path(chunk)?).await
    }

    async fn list_waveforms(&self) -> Result<Vec<WaveformRef>, Error> {
        let dir = self.dir.join(waveforms::DIR);
        let mut out = Vec::new();
        for sub in entries(&dir, true).await? {
            for name in entries(&dir.join(&sub), false).await? {
                if let Some(w) = compact::parse_waveform_name(&name)
                    && w.rel() == Some((sub.clone(), name.clone()))
                {
                    out.push(w);
                }
            }
        }
        Ok(out)
    }

    async fn delete_waveform(&self, w: &WaveformRef) -> Result<(), Error> {
        remove_if_there(&self.waveform_path(w)?).await
    }

    async fn read_chunk(&self, chunk: &ChunkRef) -> Result<Vec<u8>, Error> {
        Ok(tokio::fs::read(self.chunk_path(chunk)?).await?)
    }

    async fn write_chunk(&self, chunk: &ChunkRef, bytes: Vec<u8>) -> Result<(), Error> {
        let dest = self.chunk_path(chunk)?;
        if tokio::fs::try_exists(&dest).await? {
            return Err(Error::Msg(format!(
                "chunk {} of this device already exists in the library folder",
                remote::chunk_name(chunk.seq)
            )));
        }
        write_whole(&dest, &bytes).await
    }

    async fn waveform_exists(&self, w: &WaveformRef) -> Result<bool, Error> {
        Ok(tokio::fs::try_exists(self.waveform_path(w)?).await?)
    }

    async fn read_waveform(&self, w: &WaveformRef) -> Result<Option<Vec<u8>>, Error> {
        let path = self.waveform_path(w)?;
        match tokio::fs::metadata(&path).await {
            Ok(m) if m.len() > waveforms::MAX_BYTES as u64 => return Ok(None),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        }
        read_if_there(&path).await
    }

    async fn write_waveform(&self, w: &WaveformRef, bytes: Vec<u8>) -> Result<(), Error> {
        let dest = self.waveform_path(w)?;
        // First writer wins: a file that is already there is the same waveform.
        if tokio::fs::try_exists(&dest).await? {
            return Ok(());
        }
        write_whole(&dest, &bytes).await
    }

    async fn read_meta(&self, path: &str) -> Result<Option<Vec<u8>>, Error> {
        read_if_there(&self.meta_path(path)?).await
    }

    async fn write_meta(&self, path: &str, bytes: Vec<u8>) -> Result<(), Error> {
        write_whole(&self.meta_path(path)?, &bytes).await
    }

    async fn delete_meta(&self, path: &str) -> Result<(), Error> {
        remove_if_there(&self.meta_path(path)?).await
    }

    async fn list_meta(&self, dir: &str) -> Result<Vec<String>, Error> {
        entries(&self.meta_path(dir)?, false).await
    }
}
