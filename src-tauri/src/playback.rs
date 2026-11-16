//! Songs the webview cannot play itself. `WebView2` (Windows) has no AIFF or ALAC decoder, so the
//! player loads those through the `pcm://` scheme instead: it decodes just the part of the song
//! the player asks for and serves it as one long WAV file (32-bit float, so nothing is lost),
//! one range at a time. Playback starts at once and a seek only decodes from the new position.
//! macOS's webview plays both formats, so there the scheme goes unused.
//!
//! URLs look like `pcm://localhost/<percent-encoded absolute path>`.

use std::fs::File;
use std::path::{Path, PathBuf};

use lofty::config::ParseOptions;
use lofty::file::AudioFile;
use lofty::mp4::{Mp4Codec, Mp4File};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CODEC_TYPE_NULL, Decoder, DecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::TimeBase;
use tauri::http::Response;

use crate::stream::byte_range;

/// RIFF header, `fmt ` chunk and `data` chunk header.
const HEADER: u64 = 44;
/// Bytes per sample: 32-bit float.
const SAMPLE: u64 = 4;

/// Whether the player should load `path` through `pcm://`. Only on Windows, unless
/// `MANPLAY_PCM=1` is set (to try the scheme on a Mac).
pub fn needs_decoding(path: &Path) -> bool {
    (cfg!(windows) || std::env::var_os("MANPLAY_PCM").is_some_and(|v| v == "1")) && unplayable(path)
}

/// AIFF, or ALAC inside an MP4 container.
fn unplayable(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("aif" | "aiff" | "aifc") => true,
        Some("m4a" | "mp4" | "alac") => is_alac(path),
        _ => false,
    }
}

fn is_alac(path: &Path) -> bool {
    let Ok(mut f) = File::open(path) else {
        return false;
    };
    Mp4File::read_from(&mut f, ParseOptions::new().read_tags(false))
        .is_ok_and(|m| m.properties().codec() == Some(Mp4Codec::ALAC))
}

/// The frame count in an AIFF file's `COMM` chunk; `None` for other files.
fn aiff_frames(path: &Path) -> Option<u64> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = File::open(path).ok()?;
    let mut form = [0u8; 12];
    f.read_exact(&mut form).ok()?;
    if &form[..4] != b"FORM" || !matches!(&form[8..], b"AIFF" | b"AIFC") {
        return None;
    }
    loop {
        let mut head = [0u8; 8];
        f.read_exact(&mut head).ok()?;
        let size = u32::from_be_bytes([head[4], head[5], head[6], head[7]]);
        if &head[..4] == b"COMM" {
            let mut comm = [0u8; 6];
            f.read_exact(&mut comm).ok()?;
            return Some(u64::from(u32::from_be_bytes([
                comm[2], comm[3], comm[4], comm[5],
            ])));
        }
        // Chunks are padded to an even length.
        f.seek(SeekFrom::Current(i64::from(size + (size & 1))))
            .ok()?;
    }
}

fn mp4_channels(path: &Path) -> Option<u64> {
    let mut f = File::open(path).ok()?;
    let m = Mp4File::read_from(&mut f, ParseOptions::new().read_tags(false)).ok()?;
    m.properties().channels().map(u64::from)
}

/// An opened song, ready to decode.
struct Song {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    rate: u32,
    channels: u64,
    frames: u64,
    time_base: Option<TimeBase>,
}

impl Song {
    fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| e.to_string())?;
        let mss = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        let format = symphonia::default::get_probe()
            .format(
                &hint,
                mss,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )
            .map_err(|e| format!("unsupported audio: {e}"))?
            .format;
        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or("no audio track")?;
        let p = &track.codec_params;
        let rate = p.sample_rate.ok_or("unknown sample rate")?;

        // symphonia counts AIFF's 8-byte SSND header as audio, one frame too many; the COMM
        // chunk has the real count.
        let frames = aiff_frames(path).or(p.n_frames).ok_or("unknown length")?;
        let decoder = symphonia::default::get_codecs()
            .make(p, &DecoderOptions::default())
            .map_err(|e| format!("unsupported codec: {e}"))?;
        // symphonia leaves an MP4 track's channels unset for ALAC; lofty reads them.
        let channels = p
            .channels
            .map(|c| c.count() as u64)
            .or_else(|| mp4_channels(path))
            .unwrap_or(0);
        if channels == 0 || rate == 0 {
            return Err("unknown channel layout".to_owned());
        }
        Ok(Self {
            track_id: track.id,
            time_base: p.time_base,
            format,
            decoder,
            rate,
            channels,
            frames,
        })
    }

    fn frame_bytes(&self) -> u64 {
        self.channels * SAMPLE
    }

    fn wav_size(&self) -> u64 {
        HEADER + self.frames * self.frame_bytes()
    }

    /// Frame number → the track's timestamp units (the sample rate for AIFF; the MP4 track's
    /// timescale for ALAC, which is usually but not always the same).
    fn ts_of(&self, frame: u64) -> u64 {
        match self.time_base {
            Some(tb) if tb.numer > 0 => {
                let ts = u128::from(frame) * u128::from(tb.denom)
                    / (u128::from(tb.numer) * u128::from(self.rate));
                u64::try_from(ts).unwrap_or(u64::MAX)
            }
            _ => frame,
        }
    }

    fn frame_of(&self, ts: u64) -> u64 {
        match self.time_base {
            Some(tb) if tb.denom > 0 => {
                let f = u128::from(ts) * u128::from(tb.numer) * u128::from(self.rate)
                    / u128::from(tb.denom);
                u64::try_from(f).unwrap_or(u64::MAX)
            }
            _ => ts,
        }
    }

    /// Interleaved little-endian float samples for frames `first..first + count`, padded with
    /// silence if the file ends early (so every response matches the advertised size).
    fn pcm(&mut self, first: u64, count: u64) -> Result<Vec<u8>, String> {
        let want = usize::try_from(count * self.frame_bytes()).map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(want);
        if first > 0 {
            let to = SeekTo::TimeStamp {
                ts: self.ts_of(first),
                track_id: self.track_id,
            };
            // A song that cannot seek is read from the start instead; frames before `first`
            // are dropped below either way.
            if self.format.seek(SeekMode::Accurate, to).is_ok() {
                self.decoder.reset();
            }
        }
        let mut buf: Option<SampleBuffer<f32>> = None;
        while out.len() < want {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    break;
                }
                Err(SymError::ResetRequired) => break,
                Err(e) => return Err(e.to_string()),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            let at = self.frame_of(packet.ts());
            let audio = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(SymError::DecodeError(_)) => continue,
                Err(e) => return Err(e.to_string()),
            };
            let spec = *audio.spec();
            let capacity = audio.capacity() as u64;
            let sb = match &mut buf {
                Some(b) if b.capacity() as u64 >= capacity => b,
                _ => buf.insert(SampleBuffer::new(capacity, spec)),
            };
            sb.copy_interleaved_ref(audio);
            let samples = sb.samples();
            let decoded = samples.len() as u64 / self.channels;
            if at + decoded <= first {
                continue;
            }
            let skip = usize::try_from(first.saturating_sub(at) * self.channels)
                .map_err(|e| e.to_string())?;
            for s in &samples[skip..] {
                out.extend_from_slice(&s.to_le_bytes());
            }
        }
        out.resize(want, 0);
        Ok(out)
    }
}

/// A canonical WAV header for 32-bit float samples.
fn wav_header(rate: u32, channels: u64, data_len: u64) -> Vec<u8> {
    let channels16 = u16::try_from(channels).unwrap_or(u16::MAX);
    let block = channels16.saturating_mul(4);
    let data32 = u32::try_from(data_len).unwrap_or(u32::MAX);
    let mut h = Vec::with_capacity(44);
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&data32.saturating_add(36).to_le_bytes());
    h.extend_from_slice(b"WAVEfmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&3u16.to_le_bytes()); // WAVE_FORMAT_IEEE_FLOAT
    h.extend_from_slice(&channels16.to_le_bytes());
    h.extend_from_slice(&rate.to_le_bytes());
    h.extend_from_slice(&rate.saturating_mul(u32::from(block)).to_le_bytes());
    h.extend_from_slice(&block.to_le_bytes());
    h.extend_from_slice(&32u16.to_le_bytes());
    h.extend_from_slice(b"data");
    h.extend_from_slice(&data32.to_le_bytes());
    h
}

/// What a range request gets: the bytes, which bytes they are, and the size of the whole WAV.
#[derive(Debug)]
struct Part {
    bytes: Vec<u8>,
    start: u64,
    end: u64,
    total: u64,
}

/// Bytes of the WAV version of `path` for a `Range` header; `Err(size)` inside when the range
/// cannot be satisfied.
fn wav_part(path: &Path, range: Option<&str>) -> Result<Result<Part, u64>, String> {
    let mut song = Song::open(path)?;
    let total = song.wav_size();
    let Some((start, end)) = byte_range(range, total) else {
        return Ok(Err(total));
    };
    let mut bytes = Vec::new();
    if start < HEADER {
        let header = wav_header(song.rate, song.channels, total - HEADER);
        let from = usize::try_from(start).map_err(|e| e.to_string())?;
        let to = usize::try_from((end + 1).min(HEADER)).map_err(|e| e.to_string())?;
        bytes.extend_from_slice(&header[from..to]);
    }
    if end >= HEADER {
        let fb = song.frame_bytes();
        let data_start = start.max(HEADER) - HEADER;
        let data_end = end - HEADER;
        let first = data_start / fb;
        let last = data_end / fb;
        let pcm = song.pcm(first, last - first + 1)?;
        let skip = usize::try_from(data_start - first * fb).map_err(|e| e.to_string())?;
        let len = usize::try_from(data_end - data_start + 1).map_err(|e| e.to_string())?;
        bytes.extend_from_slice(&pcm[skip..skip + len]);
    }
    Ok(Ok(Part {
        bytes,
        start,
        end,
        total,
    }))
}

fn status(code: u16) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .body(Vec::new())
        .unwrap_or_default()
}

/// Path from a request path: `/<percent-encoded absolute path>`.
fn parse_path(uri_path: &str) -> Option<PathBuf> {
    let raw = uri_path.strip_prefix('/').unwrap_or(uri_path);
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()?;
    let path = PathBuf::from(decoded.as_ref());
    path.is_absolute().then_some(path)
}

/// Serves a `pcm://` request. `allowed` says whether the player may load a path at all (the
/// asset protocol's scope: the library folder and plugged-in drives).
pub fn respond(
    uri_path: &str,
    range: Option<&str>,
    allowed: impl Fn(&Path) -> bool,
) -> Response<Vec<u8>> {
    let Some(path) = parse_path(uri_path) else {
        return status(400);
    };
    if !crate::scan::is_audio(&path) || !allowed(&path) {
        return status(403);
    }
    match wav_part(&path, range) {
        Ok(Ok(p)) => Response::builder()
            .status(206)
            .header("Content-Type", "audio/wav")
            .header("Accept-Ranges", "bytes")
            .header(
                "Content-Range",
                format!("bytes {}-{}/{}", p.start, p.end, p.total),
            )
            .header("Access-Control-Allow-Origin", "*")
            .body(p.bytes)
            .unwrap_or_default(),
        Ok(Err(total)) => Response::builder()
            .status(416)
            .header("Content-Range", format!("bytes */{total}"))
            .body(Vec::new())
            .unwrap_or_default(),
        Err(e) => {
            log::warn!("pcm stream {}: {e}", path.display());
            status(500)
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    /// Makes a 7 s stereo song with ffmpeg; `None` when there is no ffmpeg (test skipped).
    fn make(dir: &Path, name: &str, codec: &[&str]) -> Option<PathBuf> {
        let ffmpeg = crate::itunes::find_ffmpeg()?;
        let out = dir.join(name);
        let ok = crate::process::command(&ffmpeg)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg("aevalsrc=0.5*sin(440*2*PI*t)|0.3*sin(660*2*PI*t):s=44100:d=7")
            .args(codec)
            .arg(&out)
            .status()
            .expect("ffmpeg")
            .success();
        assert!(ok);
        Some(out)
    }

    /// The whole song as floats, decoded by ffmpeg: what the WAV must hold.
    fn reference(path: &Path) -> Vec<u8> {
        let ffmpeg = crate::itunes::find_ffmpeg().expect("ffmpeg");
        crate::process::command(&ffmpeg)
            .args(["-v", "error", "-i"])
            .arg(path)
            .args(["-f", "f32le", "-"])
            .output()
            .expect("ffmpeg")
            .stdout
    }

    /// The WAV, fetched in the ranges a player asks for (`bytes=N-`, capped per response).
    fn fetch_all(path: &Path) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let header = format!("bytes={}-", out.len());
            let p = wav_part(path, Some(&header))
                .expect("reads")
                .expect("in range");
            assert_eq!(p.start, out.len() as u64);
            out.extend(p.bytes);
            if p.end + 1 == p.total {
                return out;
            }
        }
    }

    fn floats(b: &[u8]) -> Vec<f32> {
        b.as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c))
            .collect()
    }

    fn same_audio(path: &Path) {
        let wav = fetch_all(path);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[36..40], b"data");
        let want = floats(&reference(path));
        let got = floats(&wav[44..]);
        assert_eq!(got.len(), want.len(), "{}", path.display());
        let worst = got
            .iter()
            .zip(&want)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(worst < 1e-6, "{}: off by {worst}", path.display());

        // A seek: a range in the middle, starting mid-sample, matches the same bytes.
        let (a, b) = (1_000_003_usize, 1_200_000_usize);
        let part = wav_part(path, Some(&format!("bytes={a}-{b}")))
            .expect("reads")
            .expect("in range");
        assert_eq!(part.bytes, wav[a..=b]);
    }

    #[test]
    fn streams_aiff_and_alac_as_wav() {
        let dir = std::env::temp_dir().join(format!("manplay-pcm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let Some(aiff) = make(&dir, "a.aiff", &["-c:a", "pcm_s24be"]) else {
            return;
        };
        let alac = make(&dir, "a.m4a", &["-c:a", "alac"]).expect("alac");
        let lossy = make(&dir, "b.m4a", &["-c:a", "aac"]).expect("aac");
        assert!(unplayable(&aiff) && unplayable(&alac));
        assert!(!unplayable(&lossy) && !unplayable(Path::new("x.mp3")));
        same_audio(&aiff);
        same_audio(&alac);
        assert!(
            wav_part(&aiff, Some("bytes=999999999-"))
                .expect("reads")
                .is_err()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod timing {
    use super::*;

    /// How long the player waits: `cargo test --release timing -- --ignored --nocapture`.
    #[test]
    #[ignore = "timing, not a check"]
    fn six_minute_song() {
        let Some(ffmpeg) = crate::itunes::find_ffmpeg() else {
            return;
        };
        let dir = std::env::temp_dir().join("manplay-pcm-timing");
        std::fs::create_dir_all(&dir).expect("dir");
        for (name, codec) in [("long.aiff", "pcm_s24be"), ("long.m4a", "alac")] {
            let song = dir.join(name);
            if !song.exists() {
                crate::process::command(&ffmpeg)
                    .args([
                        "-v",
                        "error",
                        "-f",
                        "lavfi",
                        "-i",
                        "anoisesrc=d=360:r=44100",
                        "-ac",
                        "2",
                        "-c:a",
                        codec,
                    ])
                    .arg(&song)
                    .status()
                    .expect("ffmpeg");
            }
            for (what, range) in [("start", "bytes=0-"), ("seek to 4:00", "bytes=84672044-")] {
                let t = std::time::Instant::now();
                let p = wav_part(&song, Some(range))
                    .expect("reads")
                    .expect("in range");
                println!(
                    "{name} {what}: {} KB in {:?}",
                    p.bytes.len() / 1024,
                    t.elapsed()
                );
            }
        }
    }
}
