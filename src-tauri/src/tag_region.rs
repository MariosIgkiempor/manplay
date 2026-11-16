//! Reads the tags of a destination file without downloading its audio. Only the start of the
//! file (where `ID3v2` and FLAC keep their tags) and its end (`ID3v1`, APE, trailing MP4 `moov`
//! and AIFF/WAV chunks) are fetched; everything in between reads as zeros.

use std::io::{Cursor, Read, Seek, SeekFrom};

use lofty::config::ParseOptions;
use lofty::file::TaggedFileExt;
use lofty::probe::Probe;
use lofty::tag::Tag;

/// First request: enough for most tags, including a typical cover picture.
pub const FIRST_HEAD: u64 = 256 * 1024;
/// Bytes past the tags so the parser finds the first audio frame.
const AUDIO_MARGIN: u64 = 64 * 1024;
/// Where the tags' position can't be told from the header, this much of the start is read.
const UNKNOWN_HEAD: u64 = 1024 * 1024;
pub const TAIL: u64 = 512 * 1024;
/// Never read more than this from the start of one file.
pub const MAX_HEAD: u64 = 16 * 1024 * 1024;

/// How much of the file's start is needed to cover all its tags, judging by what `head` (the
/// first bytes of the file) already shows. Larger than `head.len()` means read more and ask again.
pub fn head_needed(head: &[u8]) -> u64 {
    let mut at = 0_usize;
    // ID3v2 (MP3, and sometimes in front of FLAC): the header gives the tag's exact size.
    if head.len() >= 10 && &head[..3] == b"ID3" {
        let size = head[6..10]
            .iter()
            .fold(0_usize, |n, b| (n << 7) | usize::from(b & 0x7f));
        let footer = if head[5] & 0x10 == 0 { 0 } else { 10 };
        at = 10 + size + footer;
        if head.len() < at + 4 {
            return (at + 4) as u64 + AUDIO_MARGIN;
        }
    } else if head.len() < 10 {
        return FIRST_HEAD;
    }
    if head.get(at..at + 4) == Some(b"fLaC") {
        // FLAC metadata blocks follow one another, each with a 4-byte header giving its length.
        let mut pos = at + 4;
        loop {
            let Some(h) = head.get(pos..pos + 4) else {
                return (pos + 4) as u64 + AUDIO_MARGIN;
            };
            let len = (usize::from(h[1]) << 16) | (usize::from(h[2]) << 8) | usize::from(h[3]);
            pos += 4 + len;
            if h[0] & 0x80 != 0 {
                return pos as u64 + AUDIO_MARGIN;
            }
        }
    }
    if at > 0 {
        return at as u64 + AUDIO_MARGIN;
    }
    UNKNOWN_HEAD
}

/// A file of `size` bytes of which only the start and the end are known.
struct Sparse {
    size: u64,
    pos: u64,
    head: Vec<u8>,
    tail_start: u64,
    tail: Vec<u8>,
}

impl Read for Sparse {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // Bytes from `pos` up to `end`, at most `buf.len()`.
        let span =
            |pos: u64, end: u64| usize::try_from(end - pos).map_or(buf.len(), |n| n.min(buf.len()));
        let head_len = self.head.len() as u64;
        let n = if self.pos >= self.size || buf.is_empty() {
            0
        } else if self.pos < head_len {
            let n = span(self.pos, head_len);
            let at = usize::try_from(self.pos).unwrap_or_default();
            buf[..n].copy_from_slice(&self.head[at..at + n]);
            n
        } else if self.pos >= self.tail_start {
            let n = span(self.pos, self.size);
            let at = usize::try_from(self.pos - self.tail_start).unwrap_or_default();
            buf[..n].copy_from_slice(&self.tail[at..at + n]);
            n
        } else {
            let n = span(self.pos, self.tail_start);
            buf[..n].fill(0);
            n
        };
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for Sparse {
    fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
        let next = match to {
            SeekFrom::Start(n) => i128::from(n),
            SeekFrom::End(n) => i128::from(self.size) + i128::from(n),
            SeekFrom::Current(n) => i128::from(self.pos) + i128::from(n),
        };
        self.pos = u64::try_from(next).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "seek before start")
        })?;
        Ok(self.pos)
    }
}

/// The primary tag of a file of `size` bytes, from its first bytes and its last `tail` bytes.
/// `None` when the format can't be told or the tags reach past what was read.
pub fn read(size: u64, head: Vec<u8>, tail: Vec<u8>) -> Option<Tag> {
    let options = ParseOptions::new().read_properties(false);
    let file = if head.len() as u64 >= size {
        Probe::new(Cursor::new(head))
            .options(options)
            .guess_file_type()
            .ok()?
            .read()
            .ok()?
    } else {
        let tail_start = size - tail.len() as u64;
        let sparse = Sparse {
            size,
            pos: 0,
            head,
            tail_start,
            tail,
        };
        Probe::new(sparse)
            .options(options)
            .guess_file_type()
            .ok()?
            .read()
            .ok()?
    };
    file.primary_tag().cloned()
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn id3_size_comes_from_the_header() {
        // Syncsafe size 0x01 0x00 = 128 bytes.
        let mut head = b"ID3\x04\x00\x00\x00\x00\x01\x00".to_vec();
        head.resize(300, 0);
        assert_eq!(head_needed(&head), 10 + 128 + AUDIO_MARGIN);
    }

    #[test]
    fn flac_blocks_are_walked_until_the_last_one() {
        let mut head = b"fLaC".to_vec();
        head.extend([0x00, 0, 0, 34]);
        head.extend([0; 34]);
        head.extend([0x84, 0, 1, 0]); // last block, 256 bytes
        head.resize(1000, 0);
        assert_eq!(head_needed(&head), 4 + 4 + 34 + 4 + 256 + AUDIO_MARGIN);
        // A header that is not read yet asks for more.
        assert_eq!(head_needed(&head[..20]), 4 + 4 + 34 + 4 + AUDIO_MARGIN);
    }

    #[test]
    fn sparse_reads_zeros_between_head_and_tail() {
        let mut s = Sparse {
            size: 10,
            pos: 0,
            head: vec![1, 2],
            tail_start: 8,
            tail: vec![9, 9],
        };
        let mut all = Vec::new();
        s.read_to_end(&mut all).expect("read");
        assert_eq!(all, [1, 2, 0, 0, 0, 0, 0, 0, 9, 9]);
    }
}
