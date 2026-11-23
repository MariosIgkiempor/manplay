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

/// FLAC: the decoded-audio MD5 from STREAMINFO when set, and the frames after the metadata.
fn flac<R: Read + Seek>(r: &mut R, size: u64) -> Option<(Option<String>, (u64, u64))> {
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
                md5 = Some(format!("flac:{hex}"));
            }
        }
        at += 4 + len;
        if last || at >= size {
            break;
        }
    }
    Some((md5, (at, size)))
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

/// Where a file's audio is, and FLAC's own checksum of it when the file carries one.
struct Audio {
    region: (u64, u64),
    flac_md5: Option<String>,
}

/// The audio of a source of `size` bytes, or `None` for formats it does not know.
fn audio<R: Read + Seek>(r: &mut R, size: u64) -> Option<Audio> {
    let head = read_at(r, 0, 12.min(usize::try_from(size).ok()?))?;
    let plain = |region| Audio {
        region,
        flac_md5: None,
    };
    if head.starts_with(b"fLaC") {
        let (flac_md5, region) = flac(r, size)?;
        Some(Audio { region, flac_md5 })
    } else if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WAVE") {
        chunk_region(r, size, *b"data", false).map(plain)
    } else if head.starts_with(b"FORM") && matches!(head.get(8..12), Some(b"AIFF" | b"AIFC")) {
        chunk_region(r, size, *b"SSND", true).map(plain)
    } else if head.get(4..8) == Some(b"ftyp") {
        mdat_region(r, size).map(plain)
    } else if head.starts_with(b"ID3")
        || (head.len() > 1 && head[0] == 0xff && head[1] & 0xe0 == 0xe0)
    {
        mp3_region(r, size).map(plain)
    } else {
        None
    }
}

/// The audio fingerprint of a source of `size` bytes, or `None` for formats it does not know or
/// files it cannot make sense of.
pub fn audio_print<R: Read + Seek>(r: &mut R, size: u64) -> Option<String> {
    let found = audio(r, size)?;
    match found.flac_md5 {
        Some(md5) => Some(md5),
        None => region_print(r, found.region),
    }
}

/// Start and end of the audio in a file on disk: everything outside it is tags and other
/// metadata. `None` for formats [`audio_print`] does not know.
pub fn audio_region_path(path: &std::path::Path) -> Option<(u64, u64)> {
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    audio(&mut f, size).map(|a| a.region)
}

/// Whether two files hold exactly the same audio bytes, whatever their tags. Unlike
/// [`audio_print`], which samples, this reads all of both, so it is the check to make before a
/// copy is thrown away.
pub fn same_audio(a: &std::path::Path, b: &std::path::Path) -> std::io::Result<bool> {
    const CHUNK: usize = 1024 * 1024;
    let (Some((a_start, a_end)), Some((b_start, b_end))) =
        (audio_region_path(a), audio_region_path(b))
    else {
        return Ok(false);
    };
    if a_end - a_start != b_end - b_start {
        return Ok(false);
    }
    let mut fa = std::fs::File::open(a)?;
    let mut fb = std::fs::File::open(b)?;
    fa.seek(SeekFrom::Start(a_start))?;
    fb.seek(SeekFrom::Start(b_start))?;
    let mut left = a_end - a_start;
    let (mut ba, mut bb) = (vec![0_u8; CHUNK], vec![0_u8; CHUNK]);
    while left > 0 {
        let n = usize::try_from(left.min(CHUNK as u64)).unwrap_or(CHUNK);
        fa.read_exact(&mut ba[..n])?;
        fb.read_exact(&mut bb[..n])?;
        if ba[..n] != bb[..n] {
            return Ok(false);
        }
        left -= n as u64;
    }
    Ok(true)
}

/// [`audio_print`] of a file on disk.
pub fn audio_print_path(path: &std::path::Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    audio_print(&mut f, size)
}

/// Smallest range fetched at once by [`audio_print_fetching`], so a run of small header reads
/// costs one request.
const FETCH_AT_LEAST: u64 = 64 * 1024;
/// Fetches allowed for one print; real files need a handful.
const MAX_FETCHES: usize = 16;

/// A file of `size` bytes of which only the fetched ranges are known. A read that reaches an
/// unknown byte fails and remembers where, so the caller can fetch it and try again.
struct Fetched {
    size: u64,
    pos: u64,
    ranges: Vec<(u64, Vec<u8>)>,
    missing: Option<u64>,
}

impl Read for Fetched {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.size || buf.is_empty() {
            return Ok(0);
        }
        let pos = self.pos;
        let Some((start, bytes)) = self
            .ranges
            .iter()
            .find(|(start, bytes)| *start <= pos && pos < start + bytes.len() as u64)
        else {
            self.missing = Some(pos);
            return Err(std::io::Error::other("not fetched"));
        };
        let at = usize::try_from(pos - start).map_err(std::io::Error::other)?;
        let n = (bytes.len() - at).min(buf.len());
        buf[..n].copy_from_slice(&bytes[at..at + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for Fetched {
    fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
        let next = match to {
            SeekFrom::Start(n) => i128::from(n),
            SeekFrom::End(n) => i128::from(self.size) + i128::from(n),
            SeekFrom::Current(n) => i128::from(self.pos) + i128::from(n),
        };
        self.pos = u64::try_from(next).map_err(std::io::Error::other)?;
        Ok(self.pos)
    }
}

/// [`audio_print`] of a file that is read through `fetch(start, len)`, e.g. range requests to a
/// destination: only the bytes the print looks at are fetched, a few small ranges per file.
pub async fn audio_print_fetching<F, Fut>(size: u64, mut fetch: F) -> Option<String>
where
    F: FnMut(u64, u64) -> Fut,
    Fut: std::future::Future<Output = Option<Vec<u8>>>,
{
    let mut file = Fetched {
        size,
        pos: 0,
        ranges: Vec::new(),
        missing: None,
    };
    for _ in 0..MAX_FETCHES {
        file.pos = 0;
        file.missing = None;
        if let Some(print) = audio_print(&mut file, size) {
            return Some(print);
        }
        let at = file.missing?;
        let len = FETCH_AT_LEAST.min(size - at);
        let bytes = fetch(at, len).await?;
        if bytes.is_empty() {
            return None;
        }
        file.ranges.push((at, bytes));
    }
    None
}

#[cfg(test)]
#[allow(clippy::cast_possible_truncation)]
mod tests {
    use super::{audio_print, audio_print_fetching};
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

    #[tokio::test]
    async fn fetching_only_some_ranges_gives_the_same_print() {
        let frames: Vec<u8> = [0xff, 0xfb]
            .iter()
            .copied()
            .chain((0..400_000_u32).map(|i| (i % 251) as u8))
            .collect();
        let mut mp3 = id3(&vec![7_u8; 300_000]);
        mp3.extend(&frames);
        mp3.extend(b"TAG");
        mp3.extend(vec![0_u8; 125]);
        let mut wav = b"RIFF\0\0\0\0WAVE".to_vec();
        wav.extend(b"LIST");
        wav.extend(200_000_u32.to_le_bytes());
        wav.extend(vec![1_u8; 200_000]);
        wav.extend(b"data");
        wav.extend(300_000_u32.to_le_bytes());
        wav.extend((0..300_000_u32).map(|i| (i % 13) as u8));
        let cases: [(&str, &[u8]); 4] = [
            ("mp3 with a large tag", &mp3),
            ("wav with a chunk before the audio", &wav),
            ("small file", b"RIFF\0\0\0\0WAVEdata\x04\0\0\0abcd"),
            ("not audio", b"hello world, not audio"),
        ];
        for (case, bytes) in cases {
            let mut fetched = 0_u64;
            let size = bytes.len() as u64;
            let ranged = audio_print_fetching(size, |at, len| {
                fetched += len;
                let (at, len) = (at as usize, len as usize);
                std::future::ready(Some(bytes[at..at + len].to_vec()))
            })
            .await;
            assert_eq!(ranged, print(bytes), "{case}");
            assert!(
                fetched <= size.max(4 * 64 * 1024),
                "{case}: fetched {fetched}"
            );
        }
    }

    #[test]
    fn unknown_formats_have_none() {
        assert_eq!(print(b"hello world, not audio"), None);
    }
}
