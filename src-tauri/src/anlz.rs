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
use std::path::{Path, PathBuf};

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

/// Hot cues (list type 1) or memory cues (type 0) of `cues`, in time order.
fn listed(cues: &[Cue], hot: bool) -> Vec<&Cue> {
    let mut out: Vec<&Cue> = cues.iter().filter(|c| c.slot.is_some() == hot).collect();
    out.sort_by(|a, b| a.slot.cmp(&b.slot).then(a.start.total_cmp(&b.start)));
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
        // A linked list by position: the first has no previous, the last no next.
        put16(&mut e, if i == 0 { 0xffff } else { (i - 1) as u16 });
        put16(
            &mut e,
            if i + 1 == list.len() {
                0xffff
            } else {
                (i + 1) as u16
            },
        );
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
        let len = 48 + comment.len();
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
        e.extend_from_slice(&[0; 7]);
        put16(&mut e, 0);
        put16(&mut e, 0);
        put(&mut e, comment.len() as u32);
        e.extend_from_slice(&comment);
        let [r, g, b] = rgb(&c.color).unwrap_or([0, 0, 0]);
        e.extend_from_slice(&[0, r, g, b]);
        body.extend(e);
    }
    let mut header = Vec::new();
    put(&mut header, u32::from(hot));
    put16(&mut header, list.len() as u16);
    put16(&mut header, 0);
    section(*b"PCO2", &header, &body)
}

/// Hot cues then memory cues, as rekordbox orders them.
fn cue_sections(cues: &[Cue]) -> Vec<Vec<u8>> {
    vec![cue_list(cues, true), cue_list(cues, false)]
}

fn extended_cue_sections(cues: &[Cue]) -> Vec<Vec<u8>> {
    vec![cue_list_ext(cues, true), cue_list_ext(cues, false)]
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
    let mut out: Vec<Vec<u8>> = Vec::with_capacity(old.len() + 1);
    let mut placed = false;
    for s in old {
        match (s.get(..4)?, grid, cues) {
            (b"PQTZ", Some(_), _) => {
                out.extend(new_grid.clone());
                placed = true;
            }
            (b"PQT2", Some(_), _) => {}
            (b"PCOB", _, Some(c)) => out.push(cue_list(c, list_kind(s)?)),
            (b"PCO2", _, Some(c)) => out.push(cue_list_ext(c, list_kind(s)?)),
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

const MAGIC: &[u8; 4] = b"MPA1";

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

    pub fn encode(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(36 + self.detail.len());
        v.extend_from_slice(MAGIC);
        v.extend_from_slice(&self.grid_bpm.unwrap_or(0.0).to_le_bytes());
        v.extend_from_slice(&self.first_beat.to_le_bytes());
        v.extend_from_slice(&self.duration.to_le_bytes());
        v.push(self.bar_offset);
        v.extend_from_slice(&(self.detail.len() as u32).to_le_bytes());
        v.extend_from_slice(&self.detail);
        v
    }

    pub fn decode(b: &[u8]) -> Option<Self> {
        let f = |o: usize| -> Option<f64> {
            Some(f64::from_le_bytes(b.get(o..o + 8)?.try_into().ok()?))
        };
        if b.get(..4)? != MAGIC {
            return None;
        }
        let len = u32::from_le_bytes(b.get(29..33)?.try_into().ok()?) as usize;
        let detail = b.get(33..33 + len)?.to_vec();
        let bpm = f(4)?;
        Some(Self {
            grid_bpm: (bpm > 0.0).then_some(bpm),
            first_beat: f(12)?,
            duration: f(20)?,
            bar_offset: *b.get(28)? % 4,
            detail,
        })
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

/// Copies a kept analysis to a new fingerprint (the file's tags changed, not its audio), unless
/// the new one already has its own.
pub fn carry(data_dir: &Path, from: &str, to: &str) {
    let target = store_path(data_dir, to);
    if target.exists() {
        return;
    }
    if let Some(stored) = load(data_dir, from) {
        let _ = save(data_dir, to, &stored);
    }
}

/// Where manplay keeps a track's analysis, by audio fingerprint.
pub fn store_path(data_dir: &Path, fingerprint: &str) -> PathBuf {
    let shard = fingerprint.get(..2).unwrap_or("00");
    data_dir
        .join("analysis")
        .join(shard)
        .join(format!("{fingerprint}.mpa"))
}

pub fn save(data_dir: &Path, fingerprint: &str, stored: &Stored) -> std::io::Result<()> {
    let path = store_path(data_dir, fingerprint);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, stored.encode())?;
    std::fs::rename(&tmp, &path)
}

pub fn load(data_dir: &Path, fingerprint: &str) -> Option<Stored> {
    Stored::decode(&std::fs::read(store_path(data_dir, fingerprint)).ok()?)
}

/// The `.DAT` and `.EXT` files for a track at `path` on the drive. Without a tempo the grid is
/// left out, as rekordbox does for beatless audio.
pub fn files(path: &str, d: &Stored, cues: &[Cue]) -> (Vec<u8>, Vec<u8>) {
    let cols = d.cols();
    let preview: Vec<u8> = summary(&cols, PREVIEW).into_iter().map(byte).collect();
    let tiny: Vec<u8> = summary(&cols, TINY)
        .into_iter()
        .map(|(h, _)| h / 2)
        .collect();

    let mut dat = vec![path_section(path)];
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
    ext.extend(cue_sections(cues));
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
        let (dat, ext) = files("/Contents/a.mp3", &d, &[]);
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
            files("/Contents/a.mp3", &d, &[]).0,
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
            },
            Cue {
                slot: None,
                start: 0.25,
                name: String::new(),
                color: String::new(),
            },
        ];
        let (with_cues_dat, with_cues_ext) = files("/Contents/a.mp3", &d, &cues);
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
        assert_eq!(&e[len - 3..], &[0x30, 0x5a, 0xff]);
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
        let (dat, ext) = files("/Contents/A/B/x.mp3", &Stored::from_detail(&detail()), &[]);
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
        let (dat, _) = files("/x.mp3", &Stored::from_detail(&d), &[]);
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
        let stored = Stored::from_detail(&detail());
        assert_eq!(Stored::decode(&stored.encode()), Some(stored.clone()));
        assert_eq!(Stored::decode(b"nope"), None);
        let mut none = stored;
        none.grid_bpm = None;
        assert_eq!(
            Stored::decode(&none.encode()).and_then(|s| s.grid_bpm),
            None
        );

        let dir = std::env::temp_dir().join(format!("manplay-anlz-{}", std::process::id()));
        save(&dir, "abcdef", &none).expect("saves");
        assert_eq!(load(&dir, "abcdef"), Some(none));
        assert!(store_path(&dir, "abcdef").ends_with("analysis/ab/abcdef.mpa"));
        assert_eq!(load(&dir, "missing"), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
