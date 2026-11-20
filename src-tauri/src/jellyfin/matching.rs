//! Which Jellyfin item is which song on a destination. Jellyfin knows a file by its full path on
//! the server; manplay knows it by its path inside the destination folder. The same file is the
//! item whose path ends with the song's path, so no mount or prefix has to be set up.

use std::collections::HashMap;

use unicode_normalization::UnicodeNormalization;

use super::AudioId;

/// A song on the destination, by its path inside the destination folder.
pub struct DestinationSong {
    pub track_id: i64,
    pub rel: Vec<String>,
}

/// A song as Jellyfin has it: its id and its full path on the server.
pub struct ServerItem {
    pub id: AudioId,
    pub path: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Matches {
    /// Library track id → Jellyfin item.
    pub found: HashMap<i64, AudioId>,
    /// Songs Jellyfin has no item for (not scanned yet, or outside the library).
    pub missing: Vec<i64>,
    /// Songs several items fit equally well; left out rather than guessed.
    pub ambiguous: Vec<i64>,
}

/// Path segments compared the way sync compares them: NFC (macOS writes NFD), lower case.
fn folded(segments: impl Iterator<Item = impl AsRef<str>>) -> Vec<String> {
    segments
        .map(|s| s.as_ref().nfc().collect::<String>().to_lowercase())
        .collect()
}

/// A server path in segments; Windows servers use `\`.
fn server_segments(path: &str) -> Vec<String> {
    folded(path.split(['/', '\\']).filter(|s| !s.is_empty()))
}

pub fn match_songs(songs: &[DestinationSong], items: &[ServerItem]) -> Matches {
    let items: Vec<(&AudioId, Vec<String>)> = items
        .iter()
        .map(|i| (&i.id, server_segments(&i.path)))
        .filter(|(_, segments)| !segments.is_empty())
        .collect();
    let mut by_name: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, (_, segments)) in items.iter().enumerate() {
        if let Some(name) = segments.last() {
            by_name.entry(name.as_str()).or_default().push(index);
        }
    }

    let mut matches = Matches::default();
    // Songs with several candidates wait until the folder most songs sit under is known.
    let mut unsure: Vec<(i64, usize, Vec<usize>)> = Vec::new();
    let mut roots: HashMap<&[String], usize> = HashMap::new();
    for song in songs {
        let rel = folded(song.rel.iter());
        let candidates: Vec<usize> = rel
            .last()
            .and_then(|name| by_name.get(name.as_str()))
            .into_iter()
            .flatten()
            .copied()
            .filter(|&i| items[i].1.ends_with(&rel))
            .collect();
        match candidates.as_slice() {
            [] => matches.missing.push(song.track_id),
            [one] => {
                let segments = &items[*one].1;
                *roots
                    .entry(&segments[..segments.len() - rel.len()])
                    .or_default() += 1;
                matches.found.insert(song.track_id, items[*one].0.clone());
            }
            _ => unsure.push((song.track_id, rel.len(), candidates)),
        }
    }

    let top = roots
        .iter()
        .max_by_key(|(_, count)| **count)
        .map(|(root, _)| *root);
    for (track_id, depth, candidates) in unsure {
        let under_top: Vec<usize> = candidates
            .into_iter()
            .filter(|&i| {
                let segments = &items[i].1;
                Some(&segments[..segments.len() - depth]) == top
            })
            .collect();
        match under_top.as_slice() {
            [one] => {
                matches.found.insert(track_id, items[*one].0.clone());
            }
            _ => matches.ambiguous.push(track_id),
        }
    }
    matches
}

/// Where a destination song would be on the server, under each folder the library scans, in
/// the server's own separator. Used to tell Jellyfin about new files.
pub fn server_paths(locations: &[String], rel: &[String]) -> Vec<String> {
    locations
        .iter()
        .map(|location| {
            let windows = location.contains('\\') && !location.contains('/');
            let sep = if windows { "\\" } else { "/" };
            format!(
                "{}{sep}{}",
                location.trim_end_matches(['/', '\\']),
                rel.join(sep)
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(track_id: i64, rel: &str) -> DestinationSong {
        DestinationSong {
            track_id,
            rel: rel.split('/').map(str::to_owned).collect(),
        }
    }

    fn item(id: &str, path: &str) -> ServerItem {
        ServerItem {
            id: AudioId(id.to_owned()),
            path: path.to_owned(),
        }
    }

    /// (case, songs on the destination, Jellyfin items, expected found / missing / ambiguous)
    type Case<'a> = (
        &'a str,
        Vec<DestinationSong>,
        Vec<ServerItem>,
        &'a [(i64, &'a str)],
        &'a [i64],
        &'a [i64],
    );

    fn cases() -> Vec<Case<'static>> {
        vec![
            (
                "same path under the server's mount",
                vec![song(1, "Sub Code Records/Lavery - '95 Jazz Lick.mp3")],
                vec![item(
                    "a",
                    "/Volumes/KINGSTON/media/music/Sub Code Records/Lavery - '95 Jazz Lick.mp3",
                )],
                &[(1, "a")],
                &[],
                &[],
            ),
            (
                "Windows server paths",
                vec![song(1, "Artist/Album/01.flac")],
                vec![item("a", r"D:\Music\Artist\Album\01.flac")],
                &[(1, "a")],
                &[],
                &[],
            ),
            (
                "NFD on the destination, NFC on the server",
                vec![song(1, "Bjo\u{308}rk/Debut/01.mp3")],
                vec![item("a", "/music/Bj\u{f6}rk/Debut/01.mp3")],
                &[(1, "a")],
                &[],
                &[],
            ),
            (
                "case differs",
                vec![song(1, "artist/album/01.mp3")],
                vec![item("a", "/music/Artist/Album/01.MP3")],
                &[(1, "a")],
                &[],
                &[],
            ),
            (
                "not scanned yet",
                vec![song(1, "A/B/01.mp3"), song(2, "A/B/02.mp3")],
                vec![item("a", "/music/A/B/01.mp3")],
                &[(1, "a")],
                &[2],
                &[],
            ),
            (
                "same file name in another album",
                vec![song(1, "A/One/01.mp3")],
                vec![
                    item("a", "/music/A/Two/01.mp3"),
                    item("b", "/music/A/One/01.mp3"),
                ],
                &[(1, "b")],
                &[],
                &[],
            ),
            (
                "a folder name is only part of a segment",
                vec![song(1, "B/01.mp3")],
                vec![item("a", "/music/AB/01.mp3")],
                &[],
                &[1],
                &[],
            ),
            (
                "a copy outside the destination's folder: the usual folder wins",
                vec![song(1, "A/B/01.mp3"), song(2, "C/D/02.mp3")],
                vec![
                    item("a", "/music/A/B/01.mp3"),
                    item("b", "/backup/A/B/01.mp3"),
                    item("c", "/music/C/D/02.mp3"),
                ],
                &[(1, "a"), (2, "c")],
                &[],
                &[],
            ),
            (
                "two copies and nothing to tell them apart",
                vec![song(1, "A/B/01.mp3")],
                vec![
                    item("a", "/music/A/B/01.mp3"),
                    item("b", "/backup/A/B/01.mp3"),
                ],
                &[],
                &[],
                &[1],
            ),
            (
                "an item with an empty path is ignored",
                vec![song(1, "A/01.mp3")],
                vec![item("a", ""), item("b", "/")],
                &[],
                &[1],
                &[],
            ),
        ]
    }

    #[test]
    fn new_songs_are_named_as_the_server_would() {
        let rel = vec!["Artist".to_owned(), "01.mp3".to_owned()];
        let cases: [(&[&str], &[&str]); 4] = [
            (&["/media/music"], &["/media/music/Artist/01.mp3"]),
            (&["/media/music/"], &["/media/music/Artist/01.mp3"]),
            (&[r"D:\Music"], &[r"D:\Music\Artist\01.mp3"]),
            (&["/a", "/b"], &["/a/Artist/01.mp3", "/b/Artist/01.mp3"]),
        ];
        for (locations, expected) in cases {
            let locations: Vec<String> = locations.iter().map(|l| (*l).to_owned()).collect();
            assert_eq!(server_paths(&locations, &rel), expected, "{locations:?}");
        }
    }

    #[test]
    fn songs_match_items_by_path_ending() {
        for (name, songs, items, found, missing, ambiguous) in cases() {
            let matches = match_songs(&songs, &items);
            let expected: HashMap<i64, AudioId> = found
                .iter()
                .map(|(t, id)| (*t, AudioId((*id).to_owned())))
                .collect();
            assert_eq!(matches.found, expected, "{name}: found");
            assert_eq!(matches.missing, missing, "{name}: missing");
            assert_eq!(matches.ambiguous, ambiguous, "{name}: ambiguous");
        }
    }
}
