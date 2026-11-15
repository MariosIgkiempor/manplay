//! Writes a rekordbox XML library (`DJ_PLAYLISTS`): the whole collection plus manplay's
//! playlists inside a "manplay" folder. rekordbox imports from this file.

use std::fmt::Write as _;
use std::path::Path;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

use crate::db::{ExportPlaylist, ExportTrack};

/// Playlists live in this folder so they never mix with the user's own rekordbox playlists.
pub const FOLDER_NAME: &str = "manplay";

/// Keeps `/` and the unreserved characters literal, escapes the rest like rekordbox does.
const PATH_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'/')
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Control characters are not allowed in XML 1.0 (tab/newline are flattened).
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// `file://localhost/Users/me/My%20Music/a.mp3`
pub fn location(path: &str) -> String {
    format!("file://localhost{}", utf8_percent_encode(path, PATH_SET))
}

fn kind(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("mp3") => "MP3 File",
        Some("wav") => "WAV File",
        Some("flac") => "FLAC File",
        Some("aif" | "aiff") => "AIFF File",
        Some("m4a") => "M4A File",
        _ => "Audio File",
    }
}

fn write_track(out: &mut String, t: &ExportTrack) {
    let _ = write!(
        out,
        "    <TRACK TrackID=\"{}\" Name=\"{}\" Artist=\"{}\" Album=\"{}\" Kind=\"{}\" Size=\"{}\"",
        t.id,
        esc(&t.title),
        esc(&t.artist),
        esc(&t.album),
        kind(&t.path),
        t.size,
    );
    if let Some(ms) = t.duration_ms {
        let _ = write!(out, " TotalTime=\"{}\"", (ms + 500) / 1000);
    }
    if let Some(kbps) = t.bitrate {
        let _ = write!(out, " BitRate=\"{kbps}\"");
    }
    if let Some(hz) = t.sample_rate {
        let _ = write!(out, " SampleRate=\"{hz}\"");
    }
    if let Some(bpm) = t.bpm {
        let _ = write!(out, " AverageBpm=\"{bpm:.2}\"");
    }
    if let Some(key) = &t.key {
        let _ = write!(out, " Tonality=\"{}\"", esc(key));
    }
    let _ = writeln!(out, " Location=\"{}\"/>", esc(&location(&t.path)));
}

/// Tag playlists live in this sub-folder of the manplay folder.
pub const TAGS_FOLDER_NAME: &str = "Tags";

fn write_playlist(
    out: &mut String,
    known: &std::collections::HashSet<i64>,
    name: &str,
    track_ids: &[i64],
    indent: &str,
) {
    let ids: Vec<i64> = track_ids
        .iter()
        .copied()
        .filter(|id| known.contains(id))
        .collect();
    let _ = writeln!(
        out,
        "{indent}<NODE Name=\"{}\" Type=\"1\" KeyType=\"0\" Entries=\"{}\">",
        esc(name),
        ids.len()
    );
    for id in ids {
        let _ = writeln!(out, "{indent}  <TRACK Key=\"{id}\"/>");
    }
    let _ = writeln!(out, "{indent}</NODE>");
}

/// Builds the XML document. Playlist entries that point at unknown tracks are dropped. Tag
/// playlists go in a "Tags" sub-folder, which is left out when there are none.
pub fn build_xml(
    tracks: &[ExportTrack],
    playlists: &[ExportPlaylist],
    tag_playlists: &[ExportPlaylist],
) -> String {
    let known: std::collections::HashSet<i64> = tracks.iter().map(|t| t.id).collect();
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str("<DJ_PLAYLISTS Version=\"1.0.0\">\n");
    out.push_str("  <PRODUCT Name=\"manplay\" Version=\"0.1.0\" Company=\"manplay\"/>\n");
    let _ = writeln!(out, "  <COLLECTION Entries=\"{}\">", tracks.len());
    for t in tracks {
        write_track(&mut out, t);
    }
    out.push_str("  </COLLECTION>\n");
    out.push_str("  <PLAYLISTS>\n");
    out.push_str("    <NODE Type=\"0\" Name=\"ROOT\" Count=\"1\">\n");
    let folder_count = playlists.len() + usize::from(!tag_playlists.is_empty());
    let _ = writeln!(
        out,
        "      <NODE Type=\"0\" Name=\"{FOLDER_NAME}\" Count=\"{folder_count}\">"
    );
    for p in playlists {
        write_playlist(&mut out, &known, &p.name, &p.track_ids, "        ");
    }
    if !tag_playlists.is_empty() {
        let _ = writeln!(
            out,
            "        <NODE Type=\"0\" Name=\"{TAGS_FOLDER_NAME}\" Count=\"{}\">",
            tag_playlists.len()
        );
        for p in tag_playlists {
            let name = p.name.replace('/', " › ");
            write_playlist(&mut out, &known, &name, &p.track_ids, "          ");
        }
        out.push_str("        </NODE>\n");
    }
    out.push_str("      </NODE>\n");
    out.push_str("    </NODE>\n");
    out.push_str("  </PLAYLISTS>\n");
    out.push_str("</DJ_PLAYLISTS>\n");
    out
}

// ---- reading an existing library file --------------------------------------

#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTrack {
    pub title: String,
    pub artist: String,
}

#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPlaylist {
    /// Folders above the playlist, outermost first (without the hidden ROOT).
    pub folders: Vec<String>,
    pub name: String,
    pub tracks: Vec<LibraryTrack>,
}

#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub tracks: usize,
    pub playlists: Vec<LibraryPlaylist>,
}

fn collect_playlists(
    node: roxmltree::Node<'_, '_>,
    folders: &mut Vec<String>,
    by_id: &std::collections::HashMap<&str, LibraryTrack>,
    out: &mut Vec<LibraryPlaylist>,
) {
    for child in node.children().filter(|n| n.has_tag_name("NODE")) {
        let name = child.attribute("Name").unwrap_or_default().to_owned();
        if child.attribute("Type") == Some("1") {
            let tracks = child
                .children()
                .filter(|n| n.has_tag_name("TRACK"))
                .filter_map(|n| n.attribute("Key"))
                .map(|key| {
                    by_id.get(key).map_or_else(
                        || LibraryTrack {
                            title: format!("(unknown track {key})"),
                            artist: String::new(),
                        },
                        |t| LibraryTrack {
                            title: t.title.clone(),
                            artist: t.artist.clone(),
                        },
                    )
                })
                .collect();
            out.push(LibraryPlaylist {
                folders: folders.clone(),
                name,
                tracks,
            });
        } else {
            folders.push(name);
            collect_playlists(child, folders, by_id, out);
            folders.pop();
        }
    }
}

/// What a rekordbox XML library holds: how many tracks and every playlist with its songs.
pub fn read_library(xml: &str) -> Result<Library, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("not a rekordbox file: {e}"))?;
    let root = doc.root_element();
    if !root.has_tag_name("DJ_PLAYLISTS") {
        return Err("not a rekordbox file".to_owned());
    }
    let mut by_id = std::collections::HashMap::new();
    if let Some(collection) = root.children().find(|n| n.has_tag_name("COLLECTION")) {
        for t in collection.children().filter(|n| n.has_tag_name("TRACK")) {
            if let Some(id) = t.attribute("TrackID") {
                by_id.insert(
                    id,
                    LibraryTrack {
                        title: t.attribute("Name").unwrap_or_default().to_owned(),
                        artist: t.attribute("Artist").unwrap_or_default().to_owned(),
                    },
                );
            }
        }
    }
    let mut playlists = Vec::new();
    if let Some(node) = root.children().find(|n| n.has_tag_name("PLAYLISTS")) {
        // The top NODE is rekordbox's hidden ROOT folder.
        for top in node.children().filter(|n| n.has_tag_name("NODE")) {
            collect_playlists(top, &mut Vec::new(), &by_id, &mut playlists);
        }
    }
    Ok(Library {
        tracks: by_id.len(),
        playlists,
    })
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    fn track(id: i64, path: &str, title: &str) -> ExportTrack {
        ExportTrack {
            id,
            path: path.into(),
            artist: "Artist & Co".into(),
            album: "Album \"One\"".into(),
            title: title.into(),
            size: 1234,
            duration_ms: Some(215_600),
            bitrate: Some(320),
            sample_rate: Some(44100),
            bpm: (id == 1).then_some(128.0),
            key: (id == 1).then(|| "Am".to_owned()),
            fingerprint: None,
        }
    }

    #[test]
    fn location_is_a_percent_encoded_file_url() {
        assert_eq!(
            location("/Users/me/My Music/Ärtist/a #1 (mix).mp3"),
            "file://localhost/Users/me/My%20Music/%C3%84rtist/a%20%231%20%28mix%29.mp3"
        );
    }

    #[test]
    fn output_is_well_formed_and_structured_like_rekordbox_expects() {
        let tracks = vec![
            track(1, "/m/a/one.mp3", "One <Intro> & more"),
            track(2, "/m/a/two.wav", "Two"),
            track(3, "/m/a/three.flac", "Three"),
        ];
        let playlists = vec![
            ExportPlaylist {
                id: Some(1),
                name: "Warm up \"set\" & chill".into(),
                track_ids: vec![3, 1, 99],
            },
            ExportPlaylist {
                id: Some(2),
                name: "Empty".into(),
                track_ids: vec![],
            },
        ];
        let xml = build_xml(&tracks, &playlists, &[]);
        let doc = roxmltree::Document::parse(&xml).expect("well-formed xml");

        let root = doc.root_element();
        assert_eq!(root.tag_name().name(), "DJ_PLAYLISTS");
        assert_eq!(root.attribute("Version"), Some("1.0.0"));

        let collection = root
            .children()
            .find(|n| n.has_tag_name("COLLECTION"))
            .expect("collection");
        assert_eq!(collection.attribute("Entries"), Some("3"));
        let first = collection
            .children()
            .find(|n| n.has_tag_name("TRACK"))
            .expect("track");
        assert_eq!(
            first.attribute("Name"),
            Some("One <Intro> & more"),
            "escapes round-trip"
        );
        assert_eq!(first.attribute("Artist"), Some("Artist & Co"));
        assert_eq!(first.attribute("Album"), Some("Album \"One\""));
        assert_eq!(first.attribute("Kind"), Some("MP3 File"));
        assert_eq!(
            first.attribute("TotalTime"),
            Some("216"),
            "rounded to seconds"
        );
        assert_eq!(
            first.attribute("Location"),
            Some("file://localhost/m/a/one.mp3")
        );
        assert_eq!(first.attribute("AverageBpm"), Some("128.00"));
        assert_eq!(first.attribute("Tonality"), Some("Am"));
        let second = collection
            .children()
            .filter(|n| n.has_tag_name("TRACK"))
            .nth(1)
            .expect("second track");
        assert_eq!(
            second.attribute("AverageBpm"),
            None,
            "unknown BPM is left out"
        );
        assert_eq!(second.attribute("Tonality"), None);

        let kinds: Vec<_> = collection
            .children()
            .filter(|n| n.has_tag_name("TRACK"))
            .filter_map(|n| n.attribute("Kind"))
            .collect();
        assert_eq!(kinds, ["MP3 File", "WAV File", "FLAC File"]);

        let folder = doc
            .descendants()
            .find(|n| n.has_tag_name("NODE") && n.attribute("Name") == Some(FOLDER_NAME))
            .expect("manplay folder");
        assert_eq!(folder.attribute("Type"), Some("0"));
        assert_eq!(folder.attribute("Count"), Some("2"));

        let lists: Vec<_> = folder
            .children()
            .filter(|n| n.has_tag_name("NODE"))
            .collect();
        assert_eq!(lists[0].attribute("Name"), Some("Warm up \"set\" & chill"));
        assert_eq!(lists[0].attribute("Type"), Some("1"));
        assert_eq!(lists[0].attribute("KeyType"), Some("0"));
        assert_eq!(
            lists[0].attribute("Entries"),
            Some("2"),
            "unknown track 99 is dropped"
        );
        let keys: Vec<_> = lists[0]
            .children()
            .filter(|n| n.has_tag_name("TRACK"))
            .filter_map(|n| n.attribute("Key"))
            .collect();
        assert_eq!(keys, ["3", "1"], "playlist order is preserved");
        assert_eq!(lists[1].attribute("Entries"), Some("0"));
    }

    #[test]
    fn control_characters_cannot_break_the_document() {
        let tracks = vec![track(1, "/m/a.mp3", "bad\u{0}\u{1}title\nline")];
        let xml = build_xml(&tracks, &[], &[]);
        assert!(roxmltree::Document::parse(&xml).is_ok());
    }

    #[test]
    fn tag_playlists_go_in_a_tags_folder_and_the_library_reads_back() {
        let tracks = vec![track(1, "/m/a.mp3", "One"), track(2, "/m/b.mp3", "Two")];
        let playlists = vec![ExportPlaylist {
            id: Some(1),
            name: "Friday".into(),
            track_ids: vec![2],
        }];
        let tags = vec![ExportPlaylist {
            id: None,
            name: "Genre/House".into(),
            track_ids: vec![1, 2],
        }];
        let xml = build_xml(&tracks, &playlists, &tags);
        let doc = roxmltree::Document::parse(&xml).expect("well-formed xml");
        let folder = doc
            .descendants()
            .find(|n| n.has_tag_name("NODE") && n.attribute("Name") == Some(FOLDER_NAME))
            .expect("manplay folder");
        assert_eq!(
            folder.attribute("Count"),
            Some("2"),
            "playlist + Tags folder"
        );

        let lib = read_library(&xml).expect("reads back");
        assert_eq!(lib.tracks, 2);
        assert_eq!(lib.playlists.len(), 2);
        assert_eq!(lib.playlists[0].folders, ["manplay"]);
        assert_eq!(lib.playlists[0].name, "Friday");
        assert_eq!(lib.playlists[0].tracks[0].title, "Two");
        assert_eq!(lib.playlists[1].folders, ["manplay", "Tags"]);
        assert_eq!(lib.playlists[1].name, "Genre › House");
        assert_eq!(lib.playlists[1].tracks.len(), 2);
    }

    #[test]
    fn reading_rejects_other_xml() {
        assert!(read_library("<nope/>").is_err());
        assert!(read_library("garbage").is_err());
    }
}
