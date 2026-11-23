//! Moving the extra copies of a duplicated song to the Trash, checked file by file first, and
//! spotting DJ-app cue points kept inside a copy's own tags (which the library does not share
//! between copies, unlike its own tags and cues).

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::audioprint;
use crate::error::Error;
use crate::fsops;

/// A DJ app that keeps cue points or a beat grid in the file's own tags.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum CueApp {
    Serato,
    Traktor,
}

/// What each app writes into a file's tags: ID3 `GEOB` descriptions, MP4 freeform atoms and FLAC
/// comment names for Serato; the ID3 `PRIV` owner for Traktor.
const CUE_SIGNS: [(CueApp, &[u8]); 5] = [
    (CueApp::Serato, b"Serato Markers"),
    (CueApp::Serato, b"SERATO_MARKERS"),
    (CueApp::Serato, b"com.serato.dj"),
    (CueApp::Serato, b"Serato BeatGrid"),
    (CueApp::Traktor, b"TRAKTOR4"),
];

/// Never read more than this of a file's tags on either side of the audio.
const MAX_TAG_BYTES: u64 = 16 * 1024 * 1024;

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

fn read_range(file: &mut std::fs::File, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    let len = end.saturating_sub(start).min(MAX_TAG_BYTES);
    let mut buf = vec![0_u8; usize::try_from(len).unwrap_or(0)];
    file.seek(SeekFrom::Start(start))?;
    file.read_exact(&mut buf)?;
    Ok(buf)
}

/// Apps whose cue points are stored in this file's tags. Only the bytes outside the audio are
/// read; an unreadable file or unknown format has none.
pub fn embedded_cues(path: &Path) -> Vec<CueApp> {
    let Some((start, end)) = audioprint::audio_region_path(path) else {
        return Vec::new();
    };
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let Ok(size) = file.metadata().map(|m| m.len()) else {
        return Vec::new();
    };
    let tail_start = end.max(size.saturating_sub(MAX_TAG_BYTES));
    let (Ok(head), Ok(tail)) = (
        read_range(&mut file, 0, start),
        read_range(&mut file, tail_start, size),
    ) else {
        return Vec::new();
    };
    let mut apps = Vec::new();
    for (app, sign) in CUE_SIGNS {
        if !apps.contains(&app) && (contains(&head, sign) || contains(&tail, sign)) {
            apps.push(app);
        }
    }
    apps
}

/// One song's copies: the one to keep and the ones to move to the Trash.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrashGroup {
    pub keep: PathBuf,
    pub trash: Vec<PathBuf>,
}

/// A copy left where it is, and why.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrashReport {
    pub trashed: Vec<String>,
    pub skipped: Vec<Skipped>,
}

/// The source file each library song was converted from on import, by the song's resolved path.
pub type ConvertedFrom = HashMap<PathBuf, String>;

/// The copies that are safe to throw away: each inside the library, not itself a kept file, and
/// holding exactly the kept copy's audio or converted from the same source file as the kept copy,
/// with the kept copy still on disk. Everything else is skipped with its reason, so a wrong match
/// or a file changed since the scan never loses a song.
pub fn verify(
    root: &Path,
    groups: &[TrashGroup],
    converted_from: &ConvertedFrom,
) -> (Vec<PathBuf>, Vec<Skipped>) {
    let same_source = |a: &Path, b: &Path| {
        converted_from
            .get(a)
            .is_some_and(|source| converted_from.get(b) == Some(source))
    };
    let skip = |path: &Path, reason: &str| Skipped {
        path: path.display().to_string(),
        reason: reason.to_owned(),
    };
    let kept: HashSet<PathBuf> = groups
        .iter()
        .filter_map(|g| fsops::inside(root, &g.keep).ok())
        .collect();
    let mut ok = Vec::new();
    let mut skipped = Vec::new();
    for group in groups {
        let keep = match fsops::inside(root, &group.keep) {
            Ok(keep) if keep.is_file() => keep,
            _ => {
                skipped.extend(
                    group
                        .trash
                        .iter()
                        .map(|p| skip(p, "the copy to keep is no longer there")),
                );
                continue;
            }
        };
        for path in &group.trash {
            let Ok(resolved) = fsops::inside(root, path) else {
                skipped.push(skip(path, "not found in the library folder"));
                continue;
            };
            if ok.contains(&resolved) {
                // Listed twice: it is already going.
            } else if kept.contains(&resolved) {
                skipped.push(skip(path, "it is the copy being kept"));
            } else if !same_source(&keep, &resolved)
                && !audioprint::same_audio(&keep, &resolved).unwrap_or(false)
            {
                skipped.push(skip(path, "its audio differs from the copy being kept"));
            } else {
                ok.push(resolved);
            }
        }
    }
    (ok, skipped)
}

/// Moves the verified copies to the Trash (the Recycle Bin on Windows) in one go.
pub fn trash_copies(
    root: &Path,
    groups: &[TrashGroup],
    converted_from: &ConvertedFrom,
) -> Result<TrashReport, Error> {
    let (ok, skipped) = verify(root, groups, converted_from);
    if !ok.is_empty() {
        trash::delete_all(&ok).map_err(|e| Error::Msg(format!("could not move to Trash: {e}")))?;
    }
    Ok(TrashReport {
        trashed: ok.iter().map(|p| p.display().to_string()).collect(),
        skipped,
    })
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("manplay-dup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("mkdir");
        d.canonicalize().expect("canon")
    }

    fn id3(body: &[u8]) -> Vec<u8> {
        let n = body.len();
        let mut v = b"ID3\x04\x00\x00".to_vec();
        #[allow(clippy::cast_possible_truncation)]
        v.extend([
            (n >> 21) as u8 & 0x7f,
            (n >> 14) as u8 & 0x7f,
            (n >> 7) as u8 & 0x7f,
            n as u8 & 0x7f,
        ]);
        v.extend(body);
        v
    }

    /// An MP3-shaped file: an ID3 tag of `tag`, then audio bytes made from `seed`.
    fn mp3(dir: &Path, name: &str, tag: &[u8], seed: u8) -> PathBuf {
        let mut bytes = id3(tag);
        bytes.extend([0xff, 0xfb]);
        #[allow(clippy::cast_possible_truncation)]
        bytes.extend((0..300_000_u32).map(|i| (i % 251) as u8 ^ seed));
        let path = dir.join(name);
        std::fs::write(&path, bytes).expect("write");
        path
    }

    #[test]
    fn same_audio_ignores_tags_and_sees_any_difference() {
        let dir = tmp("same");
        let a = mp3(&dir, "a.mp3", b"short", 0);
        let b = mp3(&dir, "b.mp3", &[9_u8; 4000], 0);
        let c = mp3(&dir, "c.mp3", b"short", 0);
        // One changed byte at the very end, which a sample from the middle would miss.
        let mut bytes = std::fs::read(&c).expect("read");
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        std::fs::write(&c, bytes).expect("write");
        assert!(audioprint::same_audio(&a, &b).expect("compare"));
        assert!(!audioprint::same_audio(&a, &c).expect("compare"));
    }

    #[test]
    fn verify_keeps_back_anything_unsafe() {
        let dir = tmp("verify");
        let keep = mp3(&dir, "Song.mp3", b"tag", 0);
        let copy = mp3(&dir, "Song (1).mp3", b"other tag", 0);
        let other = mp3(&dir, "Song (2).mp3", b"tag", 7);
        let gone = dir.join("Gone.mp3");
        let groups = [
            TrashGroup {
                keep: keep.clone(),
                trash: vec![copy.clone(), other.clone(), keep.clone()],
            },
            TrashGroup {
                keep: gone,
                trash: vec![copy.clone()],
            },
        ];
        let (ok, skipped) = verify(&dir, &groups, &ConvertedFrom::new());
        assert_eq!(ok, vec![copy.clone()]);
        let reasons: Vec<(&str, &str)> = skipped
            .iter()
            .map(|s| (s.path.as_str(), s.reason.as_str()))
            .collect();
        assert_eq!(
            reasons,
            vec![
                (
                    other.to_str().expect("utf8"),
                    "its audio differs from the copy being kept"
                ),
                (keep.to_str().expect("utf8"), "it is the copy being kept"),
                (
                    copy.to_str().expect("utf8"),
                    "the copy to keep is no longer there"
                ),
            ]
        );
    }

    /// Two encodes of one source never have the same audio; the import's record says they are
    /// one song. Only that record lets them through.
    #[test]
    fn verify_lets_encodes_of_one_source_through() {
        let dir = tmp("encodes");
        let keep = mp3(&dir, "Song.mp3", b"tag", 0);
        let encode = mp3(&dir, "Song (2).mp3", b"tag", 9);
        let stranger = mp3(&dir, "Other.mp3", b"tag", 5);
        let converted: ConvertedFrom = [
            (keep.clone(), "/src/Song.m4a".to_owned()),
            (encode.clone(), "/src/Song.m4a".to_owned()),
            (stranger.clone(), "/src/Other.m4a".to_owned()),
        ]
        .into();
        let groups = [TrashGroup {
            keep,
            trash: vec![encode.clone(), stranger.clone()],
        }];
        let (ok, skipped) = verify(&dir, &groups, &converted);
        assert_eq!(ok, vec![encode]);
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].path, stranger.display().to_string());
        let (ok, _) = verify(&dir, &groups, &ConvertedFrom::new());
        assert!(ok.is_empty(), "without the record their audio differs");
    }

    #[test]
    fn verify_refuses_files_outside_the_library() {
        let lib = tmp("inside");
        let outside = tmp("outside");
        let keep = mp3(&lib, "Song.mp3", b"tag", 0);
        let stray = mp3(&outside, "Song.mp3", b"tag", 0);
        let (ok, skipped) = verify(
            &lib,
            &[TrashGroup {
                keep,
                trash: vec![stray],
            }],
            &ConvertedFrom::new(),
        );
        assert_eq!(ok, Vec::<PathBuf>::new());
        assert_eq!(skipped.len(), 1);
    }

    #[test]
    fn finds_cue_points_in_tags_only() {
        let dir = tmp("cues");
        let cases: [(&str, &[u8], Vec<CueApp>); 4] = [
            (
                "serato.mp3",
                b"GEOB\0\0Serato Markers2\0data",
                vec![CueApp::Serato],
            ),
            (
                "traktor.mp3",
                b"PRIV\0\0TRAKTOR4\0data",
                vec![CueApp::Traktor],
            ),
            (
                "both.mp3",
                b"Serato BeatGrid TRAKTOR4",
                vec![CueApp::Serato, CueApp::Traktor],
            ),
            ("plain.mp3", b"TIT2 just a title", vec![]),
        ];
        for (name, tag, expected) in cases {
            let path = mp3(&dir, name, tag, 0);
            assert_eq!(embedded_cues(&path), expected, "{name}");
        }
    }
}
