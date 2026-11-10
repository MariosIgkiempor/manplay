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
    let _ = writeln!(out, " Location=\"{}\"/>", esc(&location(&t.path)));
}

/// Builds the XML document. Playlist entries that point at unknown tracks are dropped.
pub fn build_xml(tracks: &[ExportTrack], playlists: &[ExportPlaylist]) -> String {
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
    let _ = writeln!(
        out,
        "      <NODE Type=\"0\" Name=\"{FOLDER_NAME}\" Count=\"{}\">",
        playlists.len()
    );
    for p in playlists {
        let ids: Vec<i64> = p
            .track_ids
            .iter()
            .copied()
            .filter(|id| known.contains(id))
            .collect();
        let _ = writeln!(
            out,
            "        <NODE Name=\"{}\" Type=\"1\" KeyType=\"0\" Entries=\"{}\">",
            esc(&p.name),
            ids.len()
        );
        for id in ids {
            let _ = writeln!(out, "          <TRACK Key=\"{id}\"/>");
        }
        out.push_str("        </NODE>\n");
    }
    out.push_str("      </NODE>\n");
    out.push_str("    </NODE>\n");
    out.push_str("  </PLAYLISTS>\n");
    out.push_str("</DJ_PLAYLISTS>\n");
    out
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
                name: "Warm up \"set\" & chill".into(),
                track_ids: vec![3, 1, 99],
            },
            ExportPlaylist {
                name: "Empty".into(),
                track_ids: vec![],
            },
        ];
        let xml = build_xml(&tracks, &playlists);
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
        let xml = build_xml(&tracks, &[]);
        assert!(roxmltree::Document::parse(&xml).is_ok());
    }
}
