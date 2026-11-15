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

/// Hot cues (type 1) and memory cues (type 0), both empty.
fn cue_sections() -> Vec<Vec<u8>> {
    [1u32, 0]
        .iter()
        .map(|kind| {
            let mut header = Vec::new();
            put(&mut header, *kind);
            put(&mut header, 0);
            put(&mut header, 0xffff_ffff);
            section(*b"PCOB", &header, &[])
        })
        .collect()
}

fn extended_cue_sections() -> Vec<Vec<u8>> {
    [1u32, 0]
        .iter()
        .map(|kind| {
            let mut header = Vec::new();
            put(&mut header, *kind);
            put(&mut header, 0);
            section(*b"PCO2", &header, &[])
        })
        .collect()
}

/// Beat grid: every beat from the first to the end, numbered 1–4 within its bar.
fn beat_grid(d: &Detail, bpm: f64) -> Vec<u8> {
    let period = 60.0 / bpm;
    let tempo = (bpm * 100.0).round() as u16;
    let mut body = Vec::new();
    let mut count = 0u32;
    let mut t = d.first_beat;
    while t < d.duration {
        let number = ((d.bar_offset + count as usize) % 4 + 1) as u16;
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

/// The `.DAT` and `.EXT` files for a track at `path` on the drive. Without a tempo the grid is
/// left out, as rekordbox does for beatless audio.
pub fn files(path: &str, d: &Detail) -> (Vec<u8>, Vec<u8>) {
    let cols = columns(d);
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
    dat.extend(cue_sections());

    let detail: Vec<u8> = cols.iter().copied().map(byte).collect();
    let mut header = Vec::new();
    put(&mut header, 1);
    put(&mut header, detail.len() as u32);
    put(&mut header, (WAVEFORM_RATE as u32) << 16);
    let mut ext = vec![path_section(path), section(*b"PWV3", &header, &detail)];
    ext.extend(cue_sections());
    ext.extend(extended_cue_sections());
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
        let (dat, ext) = files("/Contents/A/B/x.mp3", &detail());
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
        let (dat, _) = files("/x.mp3", &d);
        assert!(tags(&dat).iter().all(|t| t.0 != "PQTZ"));
    }

    #[test]
    fn analysis_paths_are_unique_per_track() {
        let a = dat_path(1, "/Contents/a.mp3");
        let b = dat_path(2, "/Contents/a.mp3");
        assert_ne!(a, b);
        assert!(a.starts_with("/PIONEER/USBANLZ/P") && a.ends_with("/ANLZ0000.DAT"));
    }
}
