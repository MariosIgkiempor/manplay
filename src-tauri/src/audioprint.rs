//! A fingerprint of a file's audio alone, ignoring its tags, so the same recording is recognised
//! after it was retagged, renamed or moved: the length of the audio stream plus 64 KiB from its
//! middle (and FLAC's own checksum of the decoded audio when it has one). Re-encoded copies are
//! different audio and are not matched.

use std::fmt::Write;
use std::io::{Read, Seek, SeekFrom};

const SAMPLE: u64 = 64 * 1024;

/// Version of this algorithm, kept in the `audio_fp_version` setting. Changing how prints are
/// made means bumping it and remapping every stored `audio_fp` (tracks, analysis, cues).
pub const VERSION: u32 = 1;

fn read_at<R: Read + Seek>(r: &mut R, at: u64, len: usize) -> Option<Vec<u8>> {
    r.seek(SeekFrom::Start(at)).ok()?;
    let mut buf = vec![0_u8; len];
    r.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn be32(b: &[u8]) -> u64 {
    u64::from(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

fn le32(b: &[u8]) -> u64 {
    u64::from(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// Where the MP3 frames are: after any `ID3v2` tags, before `ID3v1` and APE tags.
fn mp3_region<R: Read + Seek>(r: &mut R, size: u64) -> Option<(u64, u64)> {
    let mut start = 0;
    while let Some(h) = read_at(r, start, 10) {
        if &h[..3] != b"ID3" {
            break;
        }
        let body = h[6..10]
            .iter()
            .fold(0_u64, |n, &b| (n << 7) | u64::from(b & 0x7f));
        let footer = if h[5] & 0x10 != 0 { 10 } else { 0 };
        start += 10 + body + footer;
    }
    let mut end = size;
    if end >= start + 128 && read_at(r, end - 128, 3)?.as_slice() == b"TAG" {
        end -= 128;
    }
    if end >= start + 32 {
        let foot = read_at(r, end - 32, 32)?;
        if &foot[..8] == b"APETAGEX" {
            let tag = le32(&foot[12..16]);
            let header = if le32(&foot[20..24]) & 0x8000_0000 != 0 {
                32
            } else {
                0
            };
            end = end.saturating_sub(tag + header);
        }
    }
    (end > start).then_some((start, end))
}

/// FLAC: the decoded-audio MD5 from STREAMINFO when set, else the frames after the metadata.
fn flac<R: Read + Seek>(r: &mut R, size: u64) -> Option<Result<String, (u64, u64)>> {
    let mut at = 4;
    let mut md5 = None;
    loop {
        let h = read_at(r, at, 4)?;
        let last = h[0] & 0x80 != 0;
        let len = u64::from(u32::from_be_bytes([0, h[1], h[2], h[3]]));
        let block = h[0] & 0x7f;
        if block == 0 && len >= 34 {
            let info = read_at(r, at + 4, 34)?;
            if info[18..34].iter().any(|&b| b != 0) {
                let mut hex = String::with_capacity(32);
                for b in &info[18..34] {
                    let _ = write!(hex, "{b:02x}");
                }
                md5 = Some(hex);
            }
        }
        at += 4 + len;
        if last || at >= size {
            break;
        }
    }
    Some(match md5 {
        Some(m) => Ok(format!("flac:{m}")),
        None => Err((at, size)),
    })
}

/// RIFF/WAVE `data` or AIFF `SSND` chunk.
fn chunk_region<R: Read + Seek>(
    r: &mut R,
    size: u64,
    want: [u8; 4],
    big: bool,
) -> Option<(u64, u64)> {
    let mut at = 12;
    while at + 8 <= size {
        let h = read_at(r, at, 8)?;
        let len = if big { be32(&h[4..8]) } else { le32(&h[4..8]) };
        if h[..4] == want {
            return Some((at + 8, (at + 8 + len).min(size)));
        }
        at += 8 + len + (len & 1);
    }
    None
}

/// MP4 / M4A `mdat` box at the top level.
fn mdat_region<R: Read + Seek>(r: &mut R, size: u64) -> Option<(u64, u64)> {
    let mut at = 0;
    while at + 8 <= size {
        let h = read_at(r, at, 8)?;
        let mut len = be32(&h[..4]);
        let mut head = 8;
        if len == 1 {
            let ext = read_at(r, at + 8, 8)?;
            len = u64::from_be_bytes(ext.try_into().ok()?);
            head = 16;
        } else if len == 0 {
            len = size - at;
        }
        if &h[4..8] == b"mdat" {
            return Some((at + head, (at + len).min(size)));
        }
        if len < 8 {
            return None;
        }
        at += len;
    }
    None
}

/// Hash of the region's length and a sample from its middle.
fn region_print<R: Read + Seek>(r: &mut R, (start, end): (u64, u64)) -> Option<String> {
    let len = end.checked_sub(start)?;
    let take = len.min(SAMPLE);
    let from = start + (len - take) / 2;
    let sample = read_at(r, from, usize::try_from(take).ok()?)?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(&len.to_le_bytes());
    hasher.update(&sample);
    Some(format!("a1:{}", hasher.finalize().to_hex()))
}

/// The audio fingerprint of a source of `size` bytes, or `None` for formats it does not know or
/// files it cannot make sense of.
pub fn audio_print<R: Read + Seek>(r: &mut R, size: u64) -> Option<String> {
    let head = read_at(r, 0, 12.min(usize::try_from(size).ok()?))?;
    let region = if head.starts_with(b"fLaC") {
        match flac(r, size)? {
            Ok(md5) => return Some(md5),
            Err(region) => region,
        }
    } else if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WAVE") {
        chunk_region(r, size, *b"data", false)?
    } else if head.starts_with(b"FORM") && matches!(head.get(8..12), Some(b"AIFF" | b"AIFC")) {
        chunk_region(r, size, *b"SSND", true)?
    } else if head.get(4..8) == Some(b"ftyp") {
        mdat_region(r, size)?
    } else if head.starts_with(b"ID3")
        || (head.len() > 1 && head[0] == 0xff && head[1] & 0xe0 == 0xe0)
    {
        mp3_region(r, size)?
    } else {
        return None;
    };
    region_print(r, region)
}

/// [`audio_print`] of a file on disk.
pub fn audio_print_path(path: &std::path::Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    audio_print(&mut f, size)
}

#[cfg(test)]
#[allow(clippy::cast_possible_truncation)]
mod tests {
    use super::audio_print;
    use std::io::Cursor;

    fn id3(body: &[u8]) -> Vec<u8> {
        let n = body.len();
        let mut v = b"ID3\x04\x00\x00".to_vec();
        v.extend([
            (n >> 21) as u8 & 0x7f,
            (n >> 14) as u8 & 0x7f,
            (n >> 7) as u8 & 0x7f,
            n as u8 & 0x7f,
        ]);
        v.extend(body);
        v
    }

    fn print(bytes: &[u8]) -> Option<String> {
        audio_print(&mut Cursor::new(bytes), bytes.len() as u64)
    }

    #[test]
    fn mp3_retagged_matches_but_other_audio_does_not() {
        let frames: Vec<u8> = [0xff, 0xfb]
            .iter()
            .copied()
            .chain((0..200_000).map(|i| (i % 251) as u8))
            .collect();
        let mut a = id3(b"short tag");
        a.extend(&frames);
        let mut b = id3(&vec![7_u8; 5000]);
        b.extend(&frames);
        b.extend(b"TAG");
        b.extend(vec![0_u8; 125]);
        assert_eq!(print(&a), print(&b));
        let mut c = id3(b"short tag");
        c.extend(frames.iter().map(|x| x.wrapping_add(1)));
        assert_ne!(print(&a), print(&c));
    }

    #[test]
    fn wav_ignores_extra_chunks() {
        let data: Vec<u8> = (0..1000_u32).map(|i| (i % 13) as u8).collect();
        let wav = |extra: &[u8]| {
            let mut v = b"RIFF\0\0\0\0WAVE".to_vec();
            if !extra.is_empty() {
                v.extend(b"LIST");
                v.extend((extra.len() as u32).to_le_bytes());
                v.extend(extra);
            }
            v.extend(b"data");
            v.extend((data.len() as u32).to_le_bytes());
            v.extend(&data);
            v
        };
        assert!(print(&wav(b"")).is_some());
        assert_eq!(print(&wav(b"")), print(&wav(b"artist")));
    }

    #[test]
    fn unknown_formats_have_none() {
        assert_eq!(print(b"hello world, not audio"), None);
    }
}
