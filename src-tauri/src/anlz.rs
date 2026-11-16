//! Pioneer analysis files (`PIONEER/USBANLZ/…/ANLZ0000.DAT` and `.EXT`): the beat grid and
//! waveforms a CDJ shows for a track.
//!
//! Layout per Deep Symmetry's research
//! (<https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/anlz.html>), with header
//! values copied from a rekordbox 7 export. Everything is big-endian. A file is a `PMAI` header
//! followed by tagged sections, each with its own four-letter code, header length and length.
//!
//! - `.DAT`: path, beat grid, 400-column and 100-column previews, (empty) cue lists.
//! - `.EXT`: path, detail waveform at 150 columns per second, (empty) cue lists.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss
)]

use crate::analysis::{Detail, WAVEFORM_RATE};
use crate::db::Cue;
use crate::error::Error;
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

/// Columns of the waveform shown across the whole track.
const PREVIEW: usize = 400;
/// Columns of the small overview older players (CDJ-900) show.
const TINY: usize = 100;

fn put(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_be_bytes());
}

/// A tagged section: code, header length, total length, then the rest of the header and body.
fn section(code: [u8; 4], header: &[u8], body: &[u8]) -> Vec<u8> {
    let header_len = 12 + header.len();
    let mut v = Vec::with_capacity(header_len + body.len());
    v.extend_from_slice(&code);
    put(&mut v, header_len as u32);
    put(&mut v, (header_len + body.len()) as u32);
    v.extend_from_slice(header);
    v.extend_from_slice(body);
    v
}

fn file(sections: &[Vec<u8>]) -> Vec<u8> {
    let body: usize = sections.iter().map(Vec::len).sum();
    let mut v = Vec::with_capacity(28 + body);
    v.extend_from_slice(b"PMAI");
    put(&mut v, 28);
    put(&mut v, (28 + body) as u32);
    for x in [1, 0x0001_0000, 0x0001_0000, 0] {
        put(&mut v, x);
    }
    for s in sections {
        v.extend_from_slice(s);
    }
    v
}

/// The track's path on the drive, UTF-16BE with a terminating zero.
fn path_section(path: &str) -> Vec<u8> {
    let mut body = Vec::new();
    for u in path.encode_utf16().chain([0]) {
        body.extend_from_slice(&u.to_be_bytes());
    }
    let mut header = Vec::new();
    put(&mut header, body.len() as u32);
    section(*b"PPTH", &header, &body)
}

fn put16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_be_bytes());
}

/// Hot cues (list type 1) or memory cues (type 0) of `cues`, in the order rekordbox writes
/// them: hot cues from the last pad back to A, memory cues in time order.
fn listed(cues: &[Cue], hot: bool) -> Vec<&Cue> {
    let mut out: Vec<&Cue> = cues.iter().filter(|c| c.slot.is_some() == hot).collect();
    out.sort_by(|a, b| b.slot.cmp(&a.slot).then(a.start.total_cmp(&b.start)));
    out
}

fn ms(seconds: f64) -> u32 {
    (seconds.max(0.0) * 1000.0).round() as u32
}

/// `#rrggbb` as bytes.
fn rgb(color: &str) -> Option<[u8; 3]> {
    let hex = color.strip_prefix('#')?;
    let n = u32::from_str_radix(hex, 16)
        .ok()
        .filter(|_| hex.len() == 6)?;
    Some([(n >> 16) as u8, (n >> 8) as u8, n as u8])
}

/// A cue list in the original format every player reads (`PCOB` of `PCPT` entries).
fn cue_list(cues: &[Cue], hot: bool) -> Vec<u8> {
    let list = listed(cues, hot);
    let mut body = Vec::new();
    for (i, c) in list.iter().enumerate() {
        let mut e = Vec::new();
        e.extend_from_slice(b"PCPT");
        put(&mut e, 0x1c);
        put(&mut e, 0x38);
        put(&mut e, c.slot.map_or(0, |s| u32::from(s) + 1));
        put(&mut e, 0);
        put(&mut e, 0x0001_0000);
        // Memory cues form a linked list by position (the first has no previous, the last no
        // next); rekordbox leaves hot cues unlinked.
        let linked = |j: Option<usize>| match j {
            Some(j) if !hot && j < list.len() => j as u16,
            _ => 0xffff,
        };
        put16(&mut e, linked(i.checked_sub(1)));
        put16(&mut e, linked(Some(i + 1)));
        e.push(1); // a cue point, not a loop
        e.push(0);
        put16(&mut e, 1000);
        put(&mut e, ms(c.start));
        put(&mut e, 0xffff_ffff);
        e.extend_from_slice(&[0; 16]);
        body.extend(e);
    }
    let mut header = Vec::new();
    put(&mut header, u32::from(hot));
    put16(&mut header, 0);
    put16(&mut header, list.len() as u16);
    put(&mut header, 0xffff_ffff);
    section(*b"PCOB", &header, &body)
}

/// The same list in the newer format (`PCO2` of `PCP2` entries), which adds names and colours.
fn cue_list_ext(cues: &[Cue], hot: bool) -> Vec<u8> {
    let list = listed(cues, hot);
    let mut body = Vec::new();
    for c in &list {
        let mut comment = Vec::new();
        if !c.name.is_empty() {
            for u in c.name.encode_utf16().chain([0]) {
                comment.extend_from_slice(&u.to_be_bytes());
            }
        }
        // rekordbox pads every entry with 40 zero bytes after its colour.
        let len = 0x2c + comment.len() + 4 + 40;
        let mut e = Vec::with_capacity(len);
        e.extend_from_slice(b"PCP2");
        put(&mut e, 0x10);
        put(&mut e, len as u32);
        put(&mut e, c.slot.map_or(0, |s| u32::from(s) + 1));
        e.push(1);
        e.extend_from_slice(&[0, 0x03, 0xe8]);
        put(&mut e, ms(c.start));
        put(&mut e, 0xffff_ffff);
        e.push(0); // memory cue colour: none
        e.push(1); // as rekordbox writes it; meaning unknown
        e.extend_from_slice(&[0; 6]);
        put16(&mut e, 0);
        put16(&mut e, 0);
        put(&mut e, comment.len() as u32);
        e.extend_from_slice(&comment);
        let [r, g, b] = rgb(&c.color).unwrap_or([0, 0, 0]);
        e.extend_from_slice(&[0, r, g, b]);
        e.extend_from_slice(&[0; 40]);
        body.extend(e);
    }
    let mut header = Vec::new();
    put(&mut header, u32::from(hot));
    put16(&mut header, list.len() as u16);
    put16(&mut header, 0);
    section(*b"PCO2", &header, &body)
}

/// Hot cues then memory cues, as rekordbox orders them. Memory cues (and the start cue, which
/// goes out as one) are left out: rekordbox 7 throws away a whole analysis file whose memory
/// list manplay wrote, grid and hot cues included, and no rekordbox-written example of a
/// memory cue entry has been seen to copy.
fn cue_sections(cues: &[Cue]) -> Vec<Vec<u8>> {
    vec![cue_list(cues, true), cue_list(&[], false)]
}

/// The `.EXT`'s copies of the original lists, which rekordbox leaves empty there: its cues are
/// in the `.DAT`'s lists and the `.EXT`'s extended ones.
fn empty_cue_sections() -> Vec<Vec<u8>> {
    cue_sections(&[])
}

/// rekordbox's `PVBR` (seek index) for an MP3 of `samples` samples: a zero word, 400 entries
/// (zero for the constant-bitrate files it has been seen with) and the length in samples.
fn vbr_index(samples: u32) -> Vec<u8> {
    let mut header = Vec::new();
    put(&mut header, 0);
    let mut body = vec![0; 400 * 4];
    put(&mut body, samples);
    section(*b"PVBR", &header, &body)
}

/// Samples in an MP3 as rekordbox counts them: every MPEG audio frame after the `ID3v2` tag,
/// 1152 samples each (576 for MPEG-2 and 2.5). `None` for files that are not MP3 or unreadable.
pub fn mp3_samples(path: &Path) -> Option<u32> {
    if !path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mp3"))
    {
        return None;
    }
    let data = std::fs::read(path).ok()?;
    mp3_samples_of(&data)
}

fn mp3_samples_of(data: &[u8]) -> Option<u32> {
    const KBPS: [[u32; 16]; 2] = [
        // MPEG-1 layer III
        [
            0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
        ],
        // MPEG-2 and 2.5 layer III
        [
            0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
        ],
    ];
    let mut pos = 0usize;
    if data.get(..3) == Some(b"ID3") {
        let s = data.get(6..10)?;
        let size = s
            .iter()
            .fold(0usize, |n, b| (n << 7) | usize::from(b & 0x7f));
        pos = 10 + size;
    }
    let mut samples = 0u64;
    while let Some(h) = data.get(pos..pos + 4) {
        let h = u32::from_be_bytes(h.try_into().ok()?);
        let version = (h >> 19) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
        let layer = (h >> 17) & 3; // 1 = layer III
        let rate_index = ((h >> 10) & 3) as usize;
        let kbps = KBPS[usize::from(version != 3)][((h >> 12) & 0xf) as usize];
        if h >> 21 != 0x7ff || version == 1 || layer != 1 || rate_index == 3 || kbps == 0 {
            pos += 1;
            continue;
        }
        let rate = [44_100, 48_000, 32_000][rate_index]
            >> match version {
                3 => 0,
                2 => 1,
                _ => 2,
            };
        let per_frame = if version == 3 { 1152 } else { 576 };
        let bytes = (per_frame / 8) * kbps * 1000 / rate + ((h >> 9) & 1);
        samples += u64::from(per_frame);
        pos += bytes as usize;
    }
    u32::try_from(samples).ok().filter(|n| *n > 0)
}

fn extended_cue_sections(cues: &[Cue]) -> Vec<Vec<u8>> {
    vec![cue_list_ext(cues, true), cue_list_ext(&[], false)]
}

/// Beat grid: every beat from the first to the end, numbered 1–4 within its bar.
fn beat_grid(d: &Stored, bpm: f64) -> Vec<u8> {
    let period = 60.0 / bpm;
    let tempo = (bpm * 100.0).round() as u16;
    let mut body = Vec::new();
    let mut count = 0u32;
    let mut t = d.first_beat;
    while t < d.duration {
        let number = ((usize::from(d.bar_offset) + count as usize) % 4 + 1) as u16;
        body.extend_from_slice(&number.to_be_bytes());
        body.extend_from_slice(&tempo.to_be_bytes());
        put(&mut body, (t * 1000.0).round() as u32);
        count += 1;
        t = d.first_beat + f64::from(count) * period;
    }
    let mut header = Vec::new();
    put(&mut header, 0);
    put(&mut header, 0x0008_0000);
    put(&mut header, count);
    section(*b"PQTZ", &header, &body)
}

/// The sections of an analysis file, after its `PMAI` header.
fn sections(b: &[u8]) -> Option<(&[u8], Vec<&[u8]>)> {
    let u32_at = |o: usize| Some(u32::from_be_bytes(b.get(o..o + 4)?.try_into().ok()?) as usize);
    if b.get(..4)? != b"PMAI" {
        return None;
    }
    let header_len = u32_at(4)?;
    let mut out = Vec::new();
    let mut o = header_len;
    while o < b.len() {
        let len = u32_at(o + 8)?;
        if len < 12 {
            return None;
        }
        out.push(b.get(o..o + len)?);
        o += len;
    }
    Some((b.get(..header_len)?, out))
}

/// An analysis file written by someone else (rekordbox) with its beat grid replaced by `grid`'s
/// and its cue lists by `cues`, each only when given, and everything else (waveforms, the other
/// of the two) as it was. Replacing the grid drops the extended grid (`PQT2`) newer players
/// prefer, so they read the replaced one. `None` when `b` is not an analysis file.
pub fn patch(b: &[u8], grid: Option<&Stored>, cues: Option<&[Cue]>) -> Option<Vec<u8>> {
    let (header, old) = sections(b)?;
    let new_grid = grid.and_then(|d| d.grid_bpm.map(|bpm| beat_grid(d, bpm)));
    let list_kind = |s: &[u8]| s.get(12..16).map(|k| k != [0, 0, 0, 0]);
    let is_ext = old.iter().any(|s| s.get(..4) == Some(b"PCO2"));
    let mut out: Vec<Vec<u8>> = Vec::with_capacity(old.len() + 1);
    let mut placed = false;
    for s in old {
        match (s.get(..4)?, grid, cues) {
            (b"PQTZ", Some(_), _) => {
                out.extend(new_grid.clone());
                placed = true;
            }
            (b"PQT2", Some(_), _) => {}
            // Memory cue lists stay as rekordbox wrote them (see `cue_sections`).
            (b"PCOB" | b"PCO2", _, Some(_)) if list_kind(s) == Some(false) => out.push(s.to_vec()),
            // The `.EXT` (the file with extended lists) keeps its original lists empty.
            (b"PCOB", _, Some(_)) if is_ext => out.push(cue_list(&[], true)),
            (b"PCOB", _, Some(c)) => out.push(cue_list(c, true)),
            (b"PCO2", _, Some(c)) => out.push(cue_list_ext(c, true)),
            _ => out.push(s.to_vec()),
        }
    }
    // A `.DAT` with no grid yet gets one after its path and VBR index, where rekordbox puts it.
    if let (false, Some(g)) = (placed, new_grid)
        && out.iter().any(|s| s.get(..4) == Some(b"PWAV"))
    {
        let at = out
            .iter()
            .take_while(|s| matches!(s.get(..4), Some(b"PPTH" | b"PVBR")))
            .count();
        out.insert(at, g);
    }
    let total: usize = header.len() + out.iter().map(Vec::len).sum::<usize>();
    let mut v = header.to_vec();
    v[8..12].copy_from_slice(&(total as u32).to_be_bytes());
    for s in out {
        v.extend_from_slice(&s);
    }
    Some(v)
}

/// Height 0–31 and whiteness 0–7 per detail column. Heights follow the square of the level,
/// scaled so the loudest passages (ignoring the odd stray peak) fill the display; that matches
/// how rekordbox draws the same audio.
fn columns(d: &Detail) -> Vec<(u8, u8)> {
    let mut peaks: Vec<f32> = d.waveform.iter().map(|c| c.0).collect();
    peaks.sort_by(f32::total_cmp);
    let top = peaks
        .get(peaks.len().saturating_sub(1) * 995 / 1000)
        .copied()
        .unwrap_or(0.0)
        .max(1e-6);
    d.waveform
        .iter()
        .map(|(peak, bright)| {
            let level = (peak / top).min(1.0);
            let height = (level * level * 31.0).round() as u8;
            let white = ((bright * 1.85).min(1.0) * 7.0).round() as u8;
            (height, white)
        })
        .collect()
}

fn byte((height, white): (u8, u8)) -> u8 {
    (white << 5) | (height & 0x1f)
}

/// `n` columns summarising the whole track: the root mean square of the heights and the
/// average whiteness in each slice.
fn summary(cols: &[(u8, u8)], n: usize) -> Vec<(u8, u8)> {
    if cols.is_empty() {
        return vec![(0, 0); n];
    }
    (0..n)
        .map(|i| {
            let lo = i * cols.len() / n;
            let hi = ((i + 1) * cols.len() / n).max(lo + 1).min(cols.len());
            let slice = cols.get(lo..hi).unwrap_or(&[]);
            if slice.is_empty() {
                return (0, 0);
            }
            let len = slice.len() as f64;
            let squares: f64 = slice.iter().map(|c| f64::from(c.0).powi(2)).sum();
            let height = (squares / len).sqrt().round() as u8;
            let white = slice.iter().map(|c| f64::from(c.1)).sum::<f64>() / len;
            (height, white.round() as u8)
        })
        .collect()
}

fn preview_section(code: [u8; 4], bytes: &[u8]) -> Vec<u8> {
    let mut header = Vec::new();
    put(&mut header, bytes.len() as u32);
    put(&mut header, 0x0001_0000);
    section(code, &header, bytes)
}

/// A track's analysis as manplay keeps it: everything the drive's files are built from, so the
/// library shows exactly what a CDJ will.
#[derive(Debug, Clone, PartialEq)]
pub struct Stored {
    pub grid_bpm: Option<f64>,
    /// Seconds.
    pub first_beat: f64,
    /// Position in the bar of the first beat (0 = downbeat).
    pub bar_offset: u8,
    /// Seconds.
    pub duration: f64,
    /// Detail waveform, `WAVEFORM_RATE` columns per second, each whiteness << 5 | height.
    pub detail: Vec<u8>,
}

impl Stored {
    pub fn from_detail(d: &Detail) -> Self {
        Self {
            grid_bpm: d.grid_bpm,
            first_beat: d.first_beat,
            bar_offset: d.bar_offset as u8,
            duration: d.duration,
            detail: columns(d).into_iter().map(byte).collect(),
        }
    }

    fn cols(&self) -> Vec<(u8, u8)> {
        self.detail.iter().map(|b| (b & 0x1f, b >> 5)).collect()
    }
}

impl Stored {
    /// Replaces the beat grid. The first beat is moved to the earliest beat at or after the
    /// start of the track, with its place in the bar following, so the grid itself is unchanged.
    pub fn set_grid(&mut self, bpm: Option<f64>, first_beat: f64, bar_offset: u8) {
        let bpm = bpm.filter(|b| b.is_finite() && *b > 0.0);
        self.grid_bpm = bpm;
        let Some(bpm) = bpm else {
            self.first_beat = 0.0;
            self.bar_offset = 0;
            return;
        };
        let period = 60.0 / bpm;
        let steps = (-first_beat / period).ceil();
        let first = first_beat + steps * period;
        self.first_beat = if first < 0.0 { first + period } else { first };
        let moved = steps as i64 + i64::from(first < 0.0);
        self.bar_offset = (i64::from(bar_offset) + moved).rem_euclid(4) as u8;
    }
}

/// The kept beat grid and waveform of the audio with this `audio_fp`; `None` until it has
/// been analysed.
pub fn load(conn: &Connection, audio_fp: &str) -> Option<Stored> {
    conn.query_row(
        "SELECT grid_bpm, first_beat, bar_offset, duration, waveform FROM analysis
         WHERE audio_fp = ?1 AND waveform IS NOT NULL",
        params![audio_fp],
        |r| {
            Ok(Stored {
                grid_bpm: r.get::<_, Option<f64>>(0)?.filter(|b| *b > 0.0),
                first_beat: r.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
                bar_offset: (r.get::<_, Option<i64>>(2)?.unwrap_or(0).rem_euclid(4)) as u8,
                duration: r.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
                detail: r.get(4)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// Keeps a beat grid and waveform for the audio with this `audio_fp`. Audio never analysed
/// gets a row of version 0, so the library analysis still detects its BPM and key later.
pub fn save(conn: &Connection, audio_fp: &str, stored: &Stored) -> Result<(), Error> {
    conn.execute(
        "INSERT OR IGNORE INTO analysis (audio_fp, version, analyzed_at) VALUES (?1, 0, 0)",
        params![audio_fp],
    )?;
    conn.execute(
        "UPDATE analysis SET grid_bpm = ?2, first_beat = ?3, bar_offset = ?4, duration = ?5,
             waveform = ?6, wf_pushed = 0
         WHERE audio_fp = ?1",
        params![
            audio_fp,
            stored.grid_bpm,
            stored.first_beat,
            stored.bar_offset,
            stored.duration,
            stored.detail
        ],
    )?;
    Ok(())
}

/// The `.DAT` and `.EXT` files for a track at `path` on the drive. Without a tempo the grid is
/// left out, as rekordbox does for beatless audio.
/// `samples` is the MP3's length in samples (see [`mp3_samples`]), for rekordbox's `PVBR`;
/// rekordbox ignores analysis files without one.
pub fn files(path: &str, d: &Stored, cues: &[Cue], samples: Option<u32>) -> (Vec<u8>, Vec<u8>) {
    let cols = d.cols();
    let preview: Vec<u8> = summary(&cols, PREVIEW).into_iter().map(byte).collect();
    let tiny: Vec<u8> = summary(&cols, TINY)
        .into_iter()
        .map(|(h, _)| h / 2)
        .collect();

    let mut dat = vec![path_section(path)];
    dat.extend(samples.map(vbr_index));
    if let Some(bpm) = d.grid_bpm {
        dat.push(beat_grid(d, bpm));
    }
    dat.push(preview_section(*b"PWAV", &preview));
    dat.push(preview_section(*b"PWV2", &tiny));
    dat.extend(cue_sections(cues));

    let mut header = Vec::new();
    put(&mut header, 1);
    put(&mut header, d.detail.len() as u32);
    put(&mut header, (WAVEFORM_RATE as u32) << 16);
    let mut ext = vec![path_section(path), section(*b"PWV3", &header, &d.detail)];
    ext.extend(empty_cue_sections());
    ext.extend(extended_cue_sections(cues));
    (file(&dat), file(&ext))
}

/// Where a track's analysis lives on the drive, unique per track id, in rekordbox's layout.
pub fn dat_path(track_id: u32, path: &str) -> String {
    let hash = path.bytes().fold(0x811c_9dc5_u32, |h, c| {
        (h ^ u32::from(c)).wrapping_mul(0x0100_0193)
    });
    format!(
        "/PIONEER/USBANLZ/P{:03X}/{:08X}/ANLZ0000.DAT",
        hash >> 20,
        (hash & 0xfff0_0000) | track_id
    )
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    #[test]
    fn a_grid_swaps_into_someone_elses_file_keeping_the_rest() {
        let mut d = Stored {
            grid_bpm: Some(120.0),
            first_beat: 0.5,
            bar_offset: 0,
            duration: 3.0,
            detail: vec![0x5f; 450],
        };
        let (dat, ext) = files("/Contents/a.mp3", &d, &[], None);
        // Pretend rekordbox wrote these, with an extended grid in the .EXT.
        let mut theirs_ext = ext.clone();
        let pqt2 = section(*b"PQT2", &[0; 44], &[7; 16]);
        theirs_ext.extend_from_slice(&pqt2);
        let total = theirs_ext.len() as u32;
        theirs_ext[8..12].copy_from_slice(&total.to_be_bytes());

        d.set_grid(Some(100.0), 0.2, 2);
        let new_dat = patch(&dat, Some(&d), None).expect("dat");
        assert_eq!(
            new_dat,
            files("/Contents/a.mp3", &d, &[], None).0,
            "only the grid changed"
        );
        let new_ext = patch(&theirs_ext, Some(&d), None).expect("ext");
        assert_eq!(new_ext, ext, "extended grid dropped, the rest kept");
        assert!(patch(b"nope", Some(&d), None).is_none());

        let cues = [
            Cue {
                slot: Some(0),
                start: 1.5,
                name: "Drop".into(),
                color: "#28e214".into(),
                main: false,
            },
            Cue {
                slot: None,
                start: 0.25,
                name: String::new(),
                color: String::new(),
                main: false,
            },
        ];
        let (with_cues_dat, with_cues_ext) = files("/Contents/a.mp3", &d, &cues, None);
        assert_eq!(
            patch(&new_dat, None, Some(&cues)).expect("cues"),
            with_cues_dat
        );
        assert_eq!(patch(&ext, None, Some(&cues)).expect("cues"), with_cues_ext);
    }

    #[test]
    fn cue_entries_follow_the_published_layout() {
        let cues = [Cue {
            slot: Some(2),
            start: 1.5,
            name: "Hi".into(),
            color: "#305aff".into(),
            main: false,
        }];
        let pcob = cue_list(&cues, true);
        assert_eq!(&pcob[..4], b"PCOB");
        assert_eq!(&pcob[12..16], &[0, 0, 0, 1], "hot cue list");
        assert_eq!(&pcob[18..20], &[0, 1], "one cue");
        let e = &pcob[24..];
        assert_eq!(&e[..4], b"PCPT");
        assert_eq!(&e[12..16], &[0, 0, 0, 3], "hot cue C");
        assert_eq!(&e[32..36], &1500u32.to_be_bytes());
        assert_eq!(e.len(), 0x38);

        let extended = cue_list_ext(&cues, true);
        let e = &extended[20..];
        assert_eq!(&e[..4], b"PCP2");
        let len = u32::from_be_bytes(e[8..12].try_into().expect("len")) as usize;
        assert_eq!(len, e.len());
        assert_eq!(&e[20..24], &1500u32.to_be_bytes());
        assert_eq!(&e[40..44], &6u32.to_be_bytes(), "Hi and a NUL in UTF-16");
        assert_eq!(&e[44 + 6 + 1..44 + 6 + 4], &[0x30, 0x5a, 0xff]);
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
            .collect()
    }

    /// Hot cues A and B as rekordbox 7 exported them for a song on a USB drive (BODYSHOT).
    fn rekordbox_ab() -> [Cue; 2] {
        let hot = |slot, ms: u32, color: &str| Cue {
            slot: Some(slot),
            start: f64::from(ms) / 1000.0,
            name: String::new(),
            color: color.into(),
            main: false,
        };
        [hot(0, 0x129c, "#ff0017"), hot(1, 0x2895, "#00c4ff")]
    }

    #[test]
    fn hot_cues_match_rekordbox_byte_for_byte() {
        let cues = rekordbox_ab();
        assert_eq!(
            cue_list(&cues, true),
            unhex(
                "50434f4200000018000000880000000100000002ffffffff\
                 504350540000001c00000038000000020000000000010000ffffffff010003e800002895ffffffff00000000000000000000000000000000\
                 504350540000001c00000038000000010000000000010000ffffffff010003e80000129cffffffff00000000000000000000000000000000"
            )
        );
        assert_eq!(
            cue_list_ext(&cues, true),
            unhex(
                "50434f3200000014000000c40000000100020000\
                 50435032000000100000005800000002010003e800002895ffffffff000100000000000000000000000000000000c4ff00000000000000000000000000000000000000000000000000000000000000000000000000000000\
                 50435032000000100000005800000001010003e80000129cffffffff0001000000000000000000000000000000ff001700000000000000000000000000000000000000000000000000000000000000000000000000000000"
            )
        );
        // The .EXT's original lists stay empty, as rekordbox leaves them.
        let (_, ext) = files("/x.mp3", &Stored::from_detail(&detail()), &cues, None);
        let pcob: Vec<u32> = tags(&ext)
            .into_iter()
            .filter(|t| t.0 == "PCOB")
            .map(|t| be(&ext, t.1 + 8))
            .collect();
        assert_eq!(pcob, [24, 24]);
    }

    #[test]
    fn memory_cues_stay_off_the_drive() {
        let mut cues = rekordbox_ab().to_vec();
        cues.push(Cue {
            slot: None,
            start: 91.2,
            name: "Foobarbaz".into(),
            color: String::new(),
            main: true,
        });
        let (dat, ext) = files("/x.mp3", &Stored::from_detail(&detail()), &cues, None);
        let (plain_dat, plain_ext) = files(
            "/x.mp3",
            &Stored::from_detail(&detail()),
            &rekordbox_ab(),
            None,
        );
        assert_eq!((dat, ext), (plain_dat, plain_ext.clone()));
        // A rekordbox file's own memory list is left as it was.
        let mut theirs = plain_ext.clone();
        let at = theirs.len() - 20;
        assert_eq!(&theirs[at..at + 4], b"PCO2");
        theirs[at + 16..at + 20].copy_from_slice(&[0, 9, 0, 0]);
        let patched = patch(&theirs, None, Some(&cues)).expect("patch");
        assert_eq!(&patched[patched.len() - 4..], &[0, 9, 0, 0]);
    }

    #[test]
    fn mp3s_get_rekordboxs_vbr_index() {
        let (dat, _) = files(
            "/x.mp3",
            &Stored::from_detail(&detail()),
            &[],
            Some(15_979_392),
        );
        let found = tags(&dat);
        let names: Vec<&str> = found.iter().map(|t| t.0.as_str()).collect();
        assert_eq!(names[..3], ["PPTH", "PVBR", "PQTZ"]);
        let at = found[1].1;
        let pvbr = &dat[at..at + 1620];
        assert_eq!(be(pvbr, 4), 16);
        assert_eq!(be(pvbr, 8), 1620);
        assert!(pvbr[12..1616].iter().all(|b| *b == 0));
        assert_eq!(be(pvbr, 1616), 15_979_392);
    }

    #[test]
    fn counts_mp3_frames_like_rekordbox() {
        // Three 320 kbps 44.1 kHz frames (1044 bytes, then a padded 1045) after a 20-byte ID3 tag.
        let mut b = b"ID3\x03\x00\x00\x00\x00\x00\x0a".to_vec();
        b.extend([0; 10]);
        for padded in [false, true, false] {
            let header: u32 = 0xfffb_e000 | if padded { 0x200 } else { 0 };
            b.extend(header.to_be_bytes());
            b.extend(vec![0; if padded { 1041 } else { 1040 }]);
        }
        b.extend(b"TAG");
        assert_eq!(mp3_samples_of(&b), Some(3 * 1152));
        assert_eq!(mp3_samples_of(b"not audio"), None);
    }

    #[test]
    fn grids_start_at_the_first_beat_in_the_track() {
        let mut s = Stored {
            grid_bpm: None,
            first_beat: 0.0,
            bar_offset: 0,
            duration: 10.0,
            detail: Vec::new(),
        };
        // 120 BPM: a beat every 0.5 s. Nudged 0.2 s early from 0.1 s, the grid's first beat is
        // now at -0.1 s, so the next one, 0.4 s, is the first in the track and one place later.
        s.set_grid(Some(120.0), -0.1, 3);
        assert!((s.first_beat - 0.4).abs() < 1e-9, "{}", s.first_beat);
        assert_eq!(s.bar_offset, 0);
        s.set_grid(Some(120.0), 1.3, 1);
        assert!((s.first_beat - 0.3).abs() < 1e-9, "{}", s.first_beat);
        assert_eq!(s.bar_offset, 3);
        s.set_grid(None, 1.0, 2);
        assert_eq!((s.grid_bpm, s.bar_offset), (None, 0));
    }
    use crate::analysis::Analysis;

    fn be(b: &[u8], o: usize) -> u32 {
        u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
    }

    /// Tags in a file and their offsets, checking every length adds up.
    fn tags(b: &[u8]) -> Vec<(String, usize)> {
        assert_eq!(&b[..4], b"PMAI");
        assert_eq!(be(b, 8) as usize, b.len());
        let mut o = be(b, 4) as usize;
        let mut out = Vec::new();
        while o < b.len() {
            let len = be(b, o + 8) as usize;
            assert!(len >= be(b, o + 4) as usize && o + len <= b.len());
            out.push((String::from_utf8_lossy(&b[o..o + 4]).into_owned(), o));
            o += len;
        }
        assert_eq!(o, b.len());
        out
    }

    fn detail() -> Detail {
        Detail {
            analysis: Analysis {
                bpm: Some(128.0),
                key: None,
            },
            grid_bpm: Some(128.0),
            first_beat: 0.1,
            bar_offset: 3,
            duration: 10.0,
            waveform: (0..1500)
                .map(|i| (if i % 70 < 10 { 0.9 } else { 0.2 }, 0.4))
                .collect(),
        }
    }

    #[test]
    fn writes_rekordbox_shaped_files() {
        let (dat, ext) = files(
            "/Contents/A/B/x.mp3",
            &Stored::from_detail(&detail()),
            &[],
            None,
        );
        let names: Vec<String> = tags(&dat).into_iter().map(|t| t.0).collect();
        assert_eq!(names, ["PPTH", "PQTZ", "PWAV", "PWV2", "PCOB", "PCOB"]);
        let names: Vec<String> = tags(&ext).into_iter().map(|t| t.0).collect();
        assert_eq!(names, ["PPTH", "PWV3", "PCOB", "PCOB", "PCO2", "PCO2"]);

        // Path: length in bytes including the terminator, UTF-16BE.
        assert_eq!(be(&dat, 28 + 12), (19 + 1) * 2);
        assert_eq!(&dat[28 + 16..28 + 20], &[0, b'/', 0, b'C']);

        let (_, grid) = tags(&dat)[1].clone();
        let beats = be(&dat, grid + 20) as usize;
        // 128 BPM from 0.1 s over 10 s: beats at 0.1, 0.56875, … up to 9.94.
        assert_eq!(beats, 22);
        let first = grid + 24;
        assert_eq!(&dat[first..first + 4], &[0, 4, 0x32, 0x00]); // beat 4, 128.00 BPM
        assert_eq!(be(&dat, first + 4), 100);
        assert_eq!(dat[first + 9], 1); // then the downbeat

        let (_, wav) = tags(&dat)[2].clone();
        assert_eq!(be(&dat, wav + 12), 400);
        let (_, detail_at) = tags(&ext)[1].clone();
        assert_eq!(be(&ext, detail_at + 16), 1500);
        let loud = ext[detail_at + 24];
        assert_eq!(loud & 0x1f, 31);
        assert_eq!(loud >> 5, 5);
    }

    #[test]
    fn leaves_the_grid_out_without_a_tempo() {
        let mut d = detail();
        d.grid_bpm = None;
        let (dat, _) = files("/x.mp3", &Stored::from_detail(&d), &[], None);
        assert!(tags(&dat).iter().all(|t| t.0 != "PQTZ"));
    }

    #[test]
    fn analysis_paths_are_unique_per_track() {
        let a = dat_path(1, "/Contents/a.mp3");
        let b = dat_path(2, "/Contents/a.mp3");
        assert_ne!(a, b);
        assert!(a.starts_with("/PIONEER/USBANLZ/P") && a.ends_with("/ANLZ0000.DAT"));
    }

    #[test]
    fn stored_analysis_round_trips() {
        let mut none = Stored::from_detail(&detail());
        none.grid_bpm = None;

        let conn = crate::db::open(Path::new(":memory:")).expect("db");
        save(&conn, "abcdef", &none).expect("saves");
        assert_eq!(load(&conn, "abcdef"), Some(none.clone()));
        assert_eq!(load(&conn, "missing"), None);
        // A row with BPM and key only (set by hand) has no waveform to show yet.
        conn.execute(
            "INSERT INTO analysis (audio_fp, version, analyzed_at) VALUES ('bare', 0, 0)",
            [],
        )
        .expect("row");
        assert_eq!(load(&conn, "bare"), None);
    }
}
