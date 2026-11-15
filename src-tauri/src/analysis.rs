//! BPM and key detection, in the spirit of rekordbox's track analysis.
//!
//! The file is decoded once, mixed to mono and resampled to about 11 kHz. Two features are
//! taken while decoding, so the audio itself is never held in memory:
//!
//! - an onset envelope (how much the spectrum rises at each 12 ms step). Its strongest
//!   periodicity in the DJ range is the tempo. The search scores each candidate tempo by how
//!   strongly the envelope repeats at that rate and its first harmonics, over the whole track,
//!   which pins constant-tempo music to within a few hundredths of a BPM.
//! - a chromagram (energy per pitch class). Correlated with the Krumhansl-Kessler key profiles
//!   it gives the most likely of the 24 major and minor keys.

// Signal processing converts between sample counts and real-valued time all the time; the
// values involved (sample rates, frame counts of at most a few million) are far inside the
// range where these casts are exact.
#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]

use std::f64::consts::PI;
use std::fs::File;
use std::path::Path;
use std::sync::Arc;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CODEC_TYPE_NULL, DecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Bump when the algorithm changes in a way that makes old results worth redoing.
pub const VERSION: i64 = 1;

/// Results outside this range are halved or doubled into it (rekordbox's default is similar).
pub const BPM_MIN: f64 = 80.0;
pub const BPM_MAX: f64 = 180.0;

const TARGET_RATE: f64 = 11_025.0;
const ONSET_N: usize = 1024;
const HOP: usize = 128;
const CHROMA_N: usize = 8192;
/// A chroma frame every this many hops (~190 ms).
const CHROMA_EVERY: usize = 16;
/// Long mixes are cut off here to bound the time one file takes.
const MAX_SECS: f64 = 30.0 * 60.0;
/// How far the best tempo's strength must stand above the median of all tempos tried.
const MIN_PEAK: f64 = 3.0;

/// Pitch names in rekordbox's spelling, by pitch class (C = 0).
const MAJOR: [&str; 12] = [
    "C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B",
];
const MINOR: [&str; 12] = [
    "Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm",
];

/// Krumhansl-Kessler probe-tone profiles, tonic first.
const KK_MAJOR: [f64; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const KK_MINOR: [f64; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

#[derive(Debug, Clone, PartialEq)]
pub struct Analysis {
    /// Beats per minute, two decimals; `None` when no steady beat was found.
    pub bpm: Option<f64>,
    /// Key in rekordbox spelling (`Am`, `F#`, ...); `None` for silence or unpitched audio.
    pub key: Option<String>,
}

/// Decodes `path` and detects its tempo and key.
pub fn analyze(path: &Path) -> Result<Analysis, String> {
    let features = extract(path)?;
    Ok(Analysis {
        bpm: detect_bpm(&features.onset, features.rate / HOP as f64),
        key: detect_key(&features.chroma),
    })
}

// ---- decoding --------------------------------------------------------------------------------

struct Features {
    /// Rate of the resampled signal, in Hz.
    rate: f64,
    onset: Vec<f32>,
    chroma: [f64; 12],
}

fn extract(path: &Path) -> Result<Features, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(
        Box::new(file),
        symphonia::core::io::MediaSourceStreamOptions::default(),
    );
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("unsupported audio: {e}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("no audio track")?;
    let track_id = track.id;
    let rate = track
        .codec_params
        .sample_rate
        .ok_or("unknown sample rate")?;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("unsupported codec: {e}"))?;

    let mut resampler = Decimator::new(f64::from(rate));
    let mut extractor = Extractor::new(resampler.out_rate);
    let limit = (MAX_SECS * f64::from(rate)) as usize;
    let mut seen = 0_usize;
    let mut mono: Vec<f32> = Vec::new();
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(e.to_string()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let audio = match decoder.decode(&packet) {
            Ok(d) => d,
            // A damaged frame: skip it, as players do.
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(e.to_string()),
        };
        let spec = *audio.spec();
        let channels = spec.channels.count().max(1);
        let capacity = audio.capacity() as u64;
        let sb = match &mut buf {
            Some(b) if b.capacity() as u64 >= capacity => b,
            _ => buf.insert(SampleBuffer::new(capacity, spec)),
        };
        sb.copy_interleaved_ref(audio);
        mono.clear();
        let scale = 1.0 / channels as f32;
        mono.extend(
            sb.samples()
                .chunks_exact(channels)
                .map(|frame| frame.iter().sum::<f32>() * scale),
        );
        resampler.push(&mono, |s| extractor.push(s));
        seen += mono.len();
        if seen >= limit {
            break;
        }
    }
    if extractor.frames == 0 {
        return Err("too short to analyze".to_owned());
    }
    Ok(extractor.finish())
}

/// Low-pass filter and downsample by a whole factor, streaming.
struct Decimator {
    factor: usize,
    taps: Vec<f32>,
    buf: Vec<f32>,
    /// Index in `buf` of the next output sample's centre.
    pos: usize,
    out_rate: f64,
}

impl Decimator {
    fn new(rate: f64) -> Self {
        let factor = ((rate / TARGET_RATE).round() as usize).max(1);
        let out_rate = rate / factor as f64;
        let taps = if factor == 1 {
            vec![1.0]
        } else {
            // Windowed sinc with the cut-off a little below the new Nyquist frequency.
            let len = 16 * factor + 1;
            let cutoff = 0.45 / factor as f64;
            let mid = (len / 2) as f64;
            let raw: Vec<f64> = (0..len)
                .map(|i| {
                    let x = i as f64 - mid;
                    let sinc = if x == 0.0 {
                        2.0 * cutoff
                    } else {
                        (2.0 * PI * cutoff * x).sin() / (PI * x)
                    };
                    let w = 0.5 - 0.5 * (2.0 * PI * i as f64 / (len - 1) as f64).cos();
                    sinc * w
                })
                .collect();
            let sum: f64 = raw.iter().sum();
            raw.iter().map(|t| (t / sum) as f32).collect()
        };
        let pos = taps.len() / 2;
        Self {
            factor,
            taps,
            buf: Vec::new(),
            pos,
            out_rate,
        }
    }

    fn push(&mut self, input: &[f32], mut out: impl FnMut(f32)) {
        self.buf.extend_from_slice(input);
        let half = self.taps.len() / 2;
        while self.pos + half < self.buf.len() {
            let start = self.pos - half;
            let window = &self.buf[start..start + self.taps.len()];
            out(window.iter().zip(&self.taps).map(|(a, b)| a * b).sum());
            self.pos += self.factor;
        }
        let drop = self.pos - half;
        self.buf.drain(..drop);
        self.pos -= drop;
    }
}

fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| (0.5 - 0.5 * (2.0 * PI * i as f64 / n as f64).cos()) as f32)
        .collect()
}

/// Turns the resampled signal into the onset envelope and the chroma sum.
struct Extractor {
    rate: f64,
    buf: Vec<f32>,
    /// Samples of the stream dropped from the front of `buf`.
    dropped: usize,
    /// Stream index one past the next frame's last sample.
    next_end: usize,
    frames: usize,
    onset_fft: Arc<dyn Fft<f32>>,
    chroma_fft: Arc<dyn Fft<f32>>,
    onset_win: Vec<f32>,
    chroma_win: Vec<f32>,
    scratch: Vec<Complex<f32>>,
    prev: Vec<f32>,
    onset: Vec<f32>,
    chroma: [f64; 12],
    /// For each semitone used (MIDI 36..=95), its FFT bin range in a chroma frame.
    bands: Vec<(usize, usize, usize)>,
}

impl Extractor {
    fn new(rate: f64) -> Self {
        let mut planner = FftPlanner::new();
        let bin_hz = rate / CHROMA_N as f64;
        let bands = (36..96)
            .filter_map(|midi: i32| {
                let centre = 440.0 * 2_f64.powf(f64::from(midi - 69) / 12.0);
                let lo = centre * 2_f64.powf(-0.5 / 12.0) / bin_hz;
                let hi = centre * 2_f64.powf(0.5 / 12.0) / bin_hz;
                let (lo, hi) = (lo.ceil() as usize, hi.floor() as usize);
                (hi >= lo && hi < CHROMA_N / 2)
                    .then(|| (usize::try_from(midi.rem_euclid(12)).unwrap_or(0), lo, hi))
            })
            .collect();
        Self {
            rate,
            buf: Vec::new(),
            dropped: 0,
            next_end: ONSET_N,
            frames: 0,
            onset_fft: planner.plan_fft_forward(ONSET_N),
            chroma_fft: planner.plan_fft_forward(CHROMA_N),
            onset_win: hann(ONSET_N),
            chroma_win: hann(CHROMA_N),
            scratch: Vec::with_capacity(CHROMA_N),
            prev: vec![0.0; ONSET_N / 2],
            onset: Vec::new(),
            chroma: [0.0; 12],
            bands,
        }
    }

    fn push(&mut self, sample: f32) {
        self.buf.push(sample);
        if self.dropped + self.buf.len() < self.next_end {
            return;
        }
        let end = self.next_end - self.dropped;
        self.onset_frame(end);
        if self.frames.is_multiple_of(CHROMA_EVERY) && end >= CHROMA_N {
            self.chroma_frame(end);
        }
        self.frames += 1;
        self.next_end += HOP;
        // Keep just what the longest frame looks back on.
        let keep_from = (self.next_end - self.dropped).saturating_sub(CHROMA_N);
        if keep_from > 4 * CHROMA_N {
            self.buf.drain(..keep_from);
            self.dropped += keep_from;
        }
    }

    fn spectrum(&mut self, end: usize, n: usize) -> &[Complex<f32>] {
        let win = if n == ONSET_N {
            &self.onset_win
        } else {
            &self.chroma_win
        };
        self.scratch.clear();
        self.scratch.extend(
            self.buf[end - n..end]
                .iter()
                .zip(win)
                .map(|(s, w)| Complex::new(s * w, 0.0)),
        );
        let fft = if n == ONSET_N {
            &self.onset_fft
        } else {
            &self.chroma_fft
        };
        fft.process(&mut self.scratch);
        &self.scratch[..n / 2]
    }

    fn onset_frame(&mut self, end: usize) {
        let spectrum: Vec<f32> = self
            .spectrum(end, ONSET_N)
            .iter()
            .map(|c| (1.0 + 100.0 * c.norm()).ln())
            .collect();
        let flux: f32 = spectrum
            .iter()
            .zip(&self.prev)
            .skip(1)
            .map(|(now, before)| (now - before).max(0.0))
            .sum();
        self.prev = spectrum;
        self.onset.push(flux);
    }

    fn chroma_frame(&mut self, end: usize) {
        let mags: Vec<f32> = self
            .spectrum(end, CHROMA_N)
            .iter()
            .map(|c| c.norm())
            .collect();
        let mut frame = [0.0_f64; 12];
        for &(pc, lo, hi) in &self.bands {
            let peak = mags[lo..=hi].iter().copied().fold(0.0_f32, f32::max);
            frame[pc] += f64::from(peak);
        }
        let total: f64 = frame.iter().sum();
        // Each frame counts the same however loud it is; near-silence is left out.
        if total > 1e-3 {
            for (sum, v) in self.chroma.iter_mut().zip(frame) {
                *sum += v / total;
            }
        }
    }

    fn finish(self) -> Features {
        Features {
            rate: self.rate,
            onset: self.onset,
            chroma: self.chroma,
        }
    }
}

// ---- tempo -----------------------------------------------------------------------------------

/// Envelope with its local average removed, so only rises above the surrounding level count.
fn detrend(env: &[f32], fps: f64) -> Vec<f64> {
    let half = ((fps * 0.25) as usize).max(1);
    let mut prefix = Vec::with_capacity(env.len() + 1);
    prefix.push(0.0_f64);
    for v in env {
        let last = prefix.last().copied().unwrap_or(0.0);
        prefix.push(last + f64::from(*v));
    }
    (0..env.len())
        .map(|i| {
            let lo = i.saturating_sub(half);
            let hi = (i + half + 1).min(env.len());
            let mean = (prefix[hi] - prefix[lo]) / (hi - lo) as f64;
            (f64::from(env[i]) - mean).max(0.0)
        })
        .collect()
}

/// Magnitude of the envelope's Fourier component at `cycles` per frame.
fn component(env: &[f64], cycles: f64) -> f64 {
    let step = Complex::from_polar(1.0, -2.0 * PI * cycles);
    let mut phasor = Complex::new(1.0_f64, 0.0);
    let mut sum = Complex::new(0.0_f64, 0.0);
    for (i, v) in env.iter().enumerate() {
        sum += phasor * *v;
        phasor *= step;
        // Renormalise now and then so rounding never lets the phasor drift.
        if i % 1024 == 1023 {
            phasor /= phasor.norm();
        }
    }
    sum.norm()
}

/// How strongly the envelope pulses at `bpm`: the beat rate plus its first harmonics, so a
/// tempo whose beats line up with sharp onsets beats one that only matches every other hit.
fn strength(env: &[f64], fps: f64, bpm: f64) -> f64 {
    const WEIGHTS: [f64; 4] = [1.0, 0.75, 0.5, 0.5];
    let base = bpm / 60.0 / fps;
    WEIGHTS
        .iter()
        .zip(1..)
        .map(|(w, h)| w * component(env, base * f64::from(h)))
        .sum()
}

/// The strongest tempo between `lo` and `hi` in steps of `step`, its strength, and the median
/// strength of all tempos tried.
fn best_in(env: &[f64], fps: f64, lo: f64, hi: f64, step: f64) -> (f64, f64, f64) {
    let mut scores = Vec::new();
    let mut best = (lo, f64::MIN);
    let mut bpm = lo;
    while bpm <= hi {
        let s = strength(env, fps, bpm);
        scores.push(s);
        if s > best.1 {
            best = (bpm, s);
        }
        bpm += step;
    }
    scores.sort_by(f64::total_cmp);
    let median = scores.get(scores.len() / 2).copied().unwrap_or(0.0);
    (best.0, best.1, median)
}

/// Tempo of an onset envelope sampled at `fps` frames per second.
fn detect_bpm(onset: &[f32], fps: f64) -> Option<f64> {
    let secs = onset.len() as f64 / fps;
    if secs < 5.0 {
        return None;
    }
    let env = detrend(onset, fps);
    let energy: f64 = env.iter().sum();
    let mean = energy / env.len() as f64;
    if mean < 1e-6 {
        return None;
    }
    // The main lobe of a component is about 60 / secs BPM wide: step well inside it, then
    // narrow down around the peak.
    let coarse_step = (30.0 / secs).clamp(0.05, 0.5);
    let (mut bpm, best, median) = best_in(&env, fps, BPM_MIN, BPM_MAX, coarse_step);
    // A real beat stands far above the typical rate; noise peaks barely do.
    if best < MIN_PEAK * median {
        return None;
    }
    let mut step = coarse_step;
    while step > 0.005 {
        let next = step / 5.0;
        bpm = best_in(&env, fps, bpm - step, bpm + step, next).0;
        step = next;
    }
    // Most music is made at a whole BPM; report that when the estimate is within error.
    let rounded = bpm.round();
    let bpm = if (bpm - rounded).abs() < 0.05 {
        rounded
    } else {
        (bpm * 100.0).round() / 100.0
    };
    Some(bpm)
}

// ---- key -------------------------------------------------------------------------------------

fn pearson(a: &[f64; 12], b: &[f64; 12]) -> f64 {
    let ma = a.iter().sum::<f64>() / 12.0;
    let mb = b.iter().sum::<f64>() / 12.0;
    let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        num += (x - ma) * (y - mb);
        da += (x - ma).powi(2);
        db += (y - mb).powi(2);
    }
    if da == 0.0 || db == 0.0 {
        0.0
    } else {
        num / (da * db).sqrt()
    }
}

fn detect_key(chroma: &[f64; 12]) -> Option<String> {
    if chroma.iter().sum::<f64>() <= 0.0 {
        return None;
    }
    let mut best: Option<(f64, &str)> = None;
    for tonic in 0..12 {
        for (profile, names) in [(&KK_MAJOR, &MAJOR), (&KK_MINOR, &MINOR)] {
            let rotated: [f64; 12] = std::array::from_fn(|pc| profile[(pc + 12 - tonic) % 12]);
            let r = pearson(chroma, &rotated);
            if best.is_none_or(|(b, _)| r > b) {
                best = Some((r, names[tonic]));
            }
        }
    }
    best.filter(|(r, _)| *r > 0.2)
        .map(|(_, name)| name.to_owned())
}

/// Reads a key as written by DJ software or a tag editor: `Am`, `A minor`, `F#`, `Gbmaj`,
/// Camelot (`8A`) or Open Key (`1m`). Returns rekordbox spelling, or `None` if unreadable.
pub fn normalize_key(text: &str) -> Option<String> {
    let t: String = text.trim().chars().filter(|c| !c.is_whitespace()).collect();
    if t.is_empty() {
        return None;
    }
    let lower = t.to_ascii_lowercase();
    // Camelot 1A-12B / Open Key 1m-12d.
    let digits: String = lower.chars().take_while(char::is_ascii_digit).collect();
    if !digits.is_empty() {
        let n: usize = digits.parse().ok()?;
        let letter = &lower[digits.len()..];
        if !(1..=12).contains(&n) {
            return None;
        }
        // Camelot: nB is a major key, nA its relative minor (three semitones down).
        return match letter {
            "b" => Some(MAJOR[camelot_major_pc(n)].to_owned()),
            "a" => Some(MINOR[(camelot_major_pc(n) + 9) % 12].to_owned()),
            // Open Key: 1d = C major, each step a fifth up; 1m = A minor.
            "d" => Some(MAJOR[(n - 1) * 7 % 12].to_owned()),
            "m" => Some(MINOR[((n - 1) * 7 + 9) % 12].to_owned()),
            _ => None,
        };
    }
    let mut chars = lower.chars();
    let base = match chars.next()? {
        'c' => 0,
        'd' => 2,
        'e' => 4,
        'f' => 5,
        'g' => 7,
        'a' => 9,
        'b' => 11,
        _ => return None,
    };
    let mut rest: &str = chars.as_str();
    let mut pc: usize = base;
    if let Some(r) = rest.strip_prefix('#').or_else(|| rest.strip_prefix('♯')) {
        pc = (pc + 1) % 12;
        rest = r;
    } else if let Some(r) = rest.strip_prefix('♭') {
        pc = (pc + 11) % 12;
        rest = r;
    } else if let Some(r) = rest.strip_prefix('b') {
        pc = (pc + 11) % 12;
        rest = r;
    }
    let minor = match rest {
        "" | "maj" | "major" | "dur" => false,
        "m" | "min" | "minor" | "moll" => true,
        _ => return None,
    };
    Some(if minor { MINOR[pc] } else { MAJOR[pc] }.to_owned())
}

/// Camelot code (`8A`) of a key in rekordbox spelling (`Am`).
pub fn camelot(key: &str) -> Option<String> {
    let (minor, pc) = MINOR
        .iter()
        .position(|k| *k == key)
        .map(|pc| (true, pc))
        .or_else(|| MAJOR.iter().position(|k| *k == key).map(|pc| (false, pc)))?;
    // A minor key shares its number with its relative major, three semitones up.
    let major_pc = if minor { (pc + 3) % 12 } else { pc };
    let n = (1..=12).find(|n| camelot_major_pc(*n) == major_pc)?;
    Some(format!("{n}{}", if minor { 'A' } else { 'B' }))
}

/// Pitch class of the major key at Camelot position `n` (1-12): 8B is C, each step a fifth.
fn camelot_major_pc(n: usize) -> usize {
    // 8B = C (0); moving +1 on the wheel goes up a fifth (+7 semitones).
    (n + 12 - 8) * 7 % 12
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    const RATE: f64 = 11_025.0;

    /// Runs `signal` through the same feature extraction a decoded file gets.
    fn features(signal: &[f32], rate: f64) -> Features {
        let mut dec = Decimator::new(rate);
        let mut ex = Extractor::new(dec.out_rate);
        for chunk in signal.chunks(4096) {
            dec.push(chunk, |s| ex.push(s));
        }
        ex.finish()
    }

    /// Decaying noise bursts on every beat, with a quieter hat on the off-beats.
    fn drums(bpm: f64, secs: f64, rate: f64) -> Vec<f32> {
        let n = (secs * rate) as usize;
        let period = 60.0 / bpm * rate;
        let mut seed = 12345_u32;
        let mut noise = move || {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            f32::from(u16::try_from(seed >> 16).unwrap_or(0)) / 32768.0 - 1.0
        };
        (0..n)
            .map(|i| {
                let t = i as f64;
                let beat = t % period;
                let off = (t + period / 2.0) % period;
                let kick = (-beat / (0.03 * rate)).exp() * (2.0 * PI * 60.0 * beat / rate).sin();
                let hat = 0.3 * (-off / (0.01 * rate)).exp();
                (kick as f32) + (hat as f32) * noise()
            })
            .collect()
    }

    fn tones(midis: &[i32], secs: f64, rate: f64) -> Vec<f32> {
        let n = (secs * rate) as usize;
        (0..n)
            .map(|i| {
                let t = i as f64 / rate;
                let v: f64 = midis
                    .iter()
                    .map(|m| {
                        let f = 440.0 * 2_f64.powf(f64::from(m - 69) / 12.0);
                        (2.0 * PI * f * t).sin() + 0.3 * (4.0 * PI * f * t).sin()
                    })
                    .sum();
                (v / midis.len() as f64 * 0.5) as f32
            })
            .collect()
    }

    fn bpm_of(signal: &[f32], rate: f64) -> Option<f64> {
        let f = features(signal, rate);
        detect_bpm(&f.onset, f.rate / HOP as f64)
    }

    #[test]
    fn finds_whole_tempos() {
        for bpm in [92.0, 124.0, 128.0, 140.0, 174.0] {
            assert_eq!(bpm_of(&drums(bpm, 60.0, RATE), RATE), Some(bpm), "{bpm}");
        }
    }

    #[test]
    fn finds_fractional_tempo_and_resamples_44k() {
        let got = bpm_of(&drums(126.4, 90.0, 44_100.0), 44_100.0).expect("a tempo");
        assert!((got - 126.4).abs() < 0.03, "got {got}");
    }

    #[test]
    fn folds_slow_and_fast_tempos_into_range() {
        assert_eq!(bpm_of(&drums(64.0, 60.0, RATE), RATE), Some(128.0));
        assert_eq!(bpm_of(&drums(250.0, 60.0, RATE), RATE), Some(125.0));
    }

    #[test]
    fn no_tempo_in_silence_or_a_drone() {
        assert_eq!(bpm_of(&vec![0.0; (20.0 * RATE) as usize], RATE), None);
        assert_eq!(bpm_of(&tones(&[57], 20.0, RATE), RATE), None);
    }

    fn key_of(midis: &[&[i32]]) -> Option<String> {
        let signal: Vec<f32> = midis
            .iter()
            .flat_map(|chord| tones(chord, 4.0, RATE))
            .collect();
        detect_key(&features(&signal, RATE).chroma)
    }

    #[test]
    fn finds_keys_from_chord_progressions() {
        // i-iv-v-i in A minor: Am, Dm, Em, Am.
        let a_minor: &[&[i32]] = &[&[57, 60, 64], &[62, 65, 69], &[64, 67, 71], &[57, 60, 64]];
        assert_eq!(key_of(a_minor).as_deref(), Some("Am"));
        // I-IV-V-I in G major: G, C, D, G.
        let g_major: &[&[i32]] = &[&[55, 59, 62], &[60, 64, 67], &[62, 66, 69], &[55, 59, 62]];
        assert_eq!(key_of(g_major).as_deref(), Some("G"));
        // i-VI-VII-i in F# minor: F#m, D, E, F#m.
        let fs_minor: &[&[i32]] = &[&[54, 57, 61], &[50, 54, 57], &[52, 56, 59], &[54, 57, 61]];
        assert_eq!(key_of(fs_minor).as_deref(), Some("F#m"));
    }

    #[test]
    fn no_key_in_silence() {
        assert_eq!(detect_key(&[0.0; 12]), None);
    }

    #[test]
    fn camelot_codes_round_trip() {
        for key in MAJOR.iter().chain(&MINOR) {
            let code = camelot(key).expect("code");
            assert_eq!(
                normalize_key(&code).as_deref(),
                Some(*key),
                "{key} → {code}"
            );
        }
        assert_eq!(camelot("Am").as_deref(), Some("8A"));
        assert_eq!(camelot("B").as_deref(), Some("1B"));
        assert_eq!(camelot("A#m"), None, "only rekordbox spelling");
    }

    #[test]
    fn reads_key_spellings() {
        let n = |s: &str| normalize_key(s);
        assert_eq!(n("Am").as_deref(), Some("Am"));
        assert_eq!(n("A minor").as_deref(), Some("Am"));
        assert_eq!(n("amin").as_deref(), Some("Am"));
        assert_eq!(n("Gb").as_deref(), Some("F#"));
        assert_eq!(n("F#").as_deref(), Some("F#"));
        assert_eq!(n("A#m").as_deref(), Some("Bbm"));
        assert_eq!(n("Bbm").as_deref(), Some("Bbm"));
        assert_eq!(n("Bm").as_deref(), Some("Bm"));
        assert_eq!(n("B").as_deref(), Some("B"));
        assert_eq!(n("Cmaj").as_deref(), Some("C"));
        assert_eq!(n("8A").as_deref(), Some("Am"));
        assert_eq!(n("8B").as_deref(), Some("C"));
        assert_eq!(n("08b").as_deref(), Some("C"));
        assert_eq!(n("1A").as_deref(), Some("G#m"));
        assert_eq!(n("12B").as_deref(), Some("E"));
        assert_eq!(n("1d").as_deref(), Some("C"));
        assert_eq!(n("1m").as_deref(), Some("Am"));
        assert_eq!(n("2m").as_deref(), Some("Em"));
        assert_eq!(n(""), None);
        assert_eq!(n("13A"), None);
        assert_eq!(n("H"), None);
        assert_eq!(n("Cx"), None);
    }

    /// 16-bit PCM WAV of `samples` at `rate` Hz, stereo with the same signal in both channels.
    fn wav(samples: &[f32], rate: u32) -> Vec<u8> {
        let data_len = u32::try_from(samples.len() * 4).unwrap_or(0);
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data_len).to_le_bytes());
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&16_u32.to_le_bytes());
        v.extend_from_slice(&1_u16.to_le_bytes());
        v.extend_from_slice(&2_u16.to_le_bytes());
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&(rate * 4).to_le_bytes());
        v.extend_from_slice(&4_u16.to_le_bytes());
        v.extend_from_slice(&16_u16.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data_len.to_le_bytes());
        for s in samples {
            let x = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            v.extend_from_slice(&x.to_le_bytes());
            v.extend_from_slice(&x.to_le_bytes());
        }
        v
    }

    #[test]
    fn analyses_a_wav_file() {
        let rate = 44_100;
        let beat = drums(128.0, 30.0, f64::from(rate));
        let chords: Vec<f32> = [[57, 60, 64], [62, 65, 69], [64, 67, 71], [57, 60, 64]]
            .iter()
            .cycle()
            .take(8)
            .flat_map(|c| tones(c, 3.75, f64::from(rate)))
            .collect();
        let mix: Vec<f32> = beat
            .iter()
            .zip(&chords)
            .map(|(a, b)| 0.6 * a + 0.4 * b)
            .collect();
        let dir = std::env::temp_dir().join(format!("manplay-analysis-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("loop.wav");
        std::fs::write(&path, wav(&mix, rate)).expect("write");

        let got = analyze(&path).expect("analysis");
        assert_eq!(got.bpm, Some(128.0));
        assert_eq!(got.key.as_deref(), Some("Am"));

        assert!(analyze(&dir.join("missing.wav")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Prints the analysis of real files: `MANPLAY_ANALYZE="a.mp3:b.flac" cargo test --release
    /// -- --ignored analyse_files --nocapture`.
    #[test]
    #[ignore = "needs audio files"]
    fn analyse_files() {
        let list = std::env::var("MANPLAY_ANALYZE").unwrap_or_default();
        for path in list.split(':').filter(|p| !p.is_empty()) {
            let start = std::time::Instant::now();
            let got = analyze(Path::new(path));
            println!("{:?}\t{:.2}s\t{path}", got, start.elapsed().as_secs_f64());
        }
    }
}
