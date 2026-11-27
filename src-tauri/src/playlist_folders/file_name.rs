//! What a song is called in a playlist folder, after its position: tags and text in an order the
//! user picks, such as `Artist - Title`. The position always comes first, so a player that sorts
//! by name still lists the songs in playlist order, and the extension always comes last.

use crate::pdb;
use crate::usb_export::safe_file_name;
use serde::{Deserialize, Serialize};

/// The most parts a template holds; more would only make names too long for the players.
pub const MAX_PARTS: usize = 16;
/// The longest piece of text, in characters, between tags.
pub const MAX_TEXT: usize = 40;

/// A tag of the song that can go into its name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NameTag {
    /// The song's own file name without its extension, as it was before it went into a folder.
    FileName,
    Title,
    Artist,
    Album,
    Genre,
    Key,
    Bpm,
    Year,
    TrackNumber,
}

/// One piece of a name: a tag's value, or text typed by the user such as ` - `.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NamePart {
    Tag(NameTag),
    Text(String),
}

/// Why a template cannot be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateError {
    NoTag,
    TooManyParts,
    TextTooLong,
    EmptyText,
}

impl std::fmt::Display for TemplateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NoTag => "a file name needs at least one tag",
            Self::TooManyParts => "a file name has too many parts",
            Self::TextTooLong => "text in a file name is too long",
            Self::EmptyText => "text in a file name is empty",
        })
    }
}

/// How the songs in playlist folders are named. Always holds at least one tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Vec<NamePart>", into = "Vec<NamePart>")]
pub struct FileNameTemplate(Vec<NamePart>);

impl Default for FileNameTemplate {
    /// The song's own file name.
    fn default() -> Self {
        Self(vec![NamePart::Tag(NameTag::FileName)])
    }
}

impl TryFrom<Vec<NamePart>> for FileNameTemplate {
    type Error = TemplateError;

    fn try_from(parts: Vec<NamePart>) -> Result<Self, Self::Error> {
        if parts.len() > MAX_PARTS {
            return Err(TemplateError::TooManyParts);
        }
        if !parts.iter().any(|p| matches!(p, NamePart::Tag(_))) {
            return Err(TemplateError::NoTag);
        }
        for part in &parts {
            if let NamePart::Text(text) = part {
                if text.is_empty() {
                    return Err(TemplateError::EmptyText);
                }
                if text.chars().count() > MAX_TEXT {
                    return Err(TemplateError::TextTooLong);
                }
            }
        }
        Ok(Self(parts))
    }
}

impl From<FileNameTemplate> for Vec<NamePart> {
    fn from(template: FileNameTemplate) -> Self {
        template.0
    }
}

/// A song's file name split at its extension: `Song.mp3` → (`Song`, `.mp3`).
fn split_extension(file_name: &str) -> (&str, &str) {
    match file_name.rfind('.') {
        Some(dot) if dot > 0 && file_name.len() - dot <= 6 => file_name.split_at(dot),
        _ => (file_name, ""),
    }
}

/// `12800` (BPM × 100) → `128`; `12750` → `127.5`.
fn bpm_text(tempo: u32) -> String {
    if tempo == 0 {
        return String::new();
    }
    let whole = tempo / 100;
    let hundredths = tempo % 100;
    if hundredths == 0 {
        whole.to_string()
    } else if hundredths.is_multiple_of(10) {
        format!("{whole}.{}", hundredths / 10)
    } else {
        format!("{whole}.{hundredths:02}")
    }
}

fn tag_value(tag: NameTag, track: &pdb::Track, stem: &str) -> String {
    let nonzero = |n: u32| if n == 0 { String::new() } else { n.to_string() };
    match tag {
        NameTag::FileName => stem.to_owned(),
        NameTag::Title => track.title.clone(),
        NameTag::Artist => track.artist.clone(),
        NameTag::Album => track.album.clone(),
        NameTag::Genre => track.genre.clone(),
        NameTag::Key => track.key.clone(),
        NameTag::Bpm => bpm_text(track.tempo),
        NameTag::Year => nonzero(u32::from(track.year)),
        NameTag::TrackNumber => match track.track_number {
            0 => String::new(),
            n => format!("{n:02}"),
        },
    }
    .trim()
    .to_owned()
}

impl FileNameTemplate {
    /// The song's name in a folder, without its position: the template filled from `track`'s
    /// tags, `original` being its own file name. Text next to a tag the song has no value for is
    /// left out with it, so `Artist - Title` is just `Title` for a song with no artist. A name
    /// that comes out empty is the song's own file name.
    pub fn render(&self, track: &pdb::Track, original: &str) -> String {
        let (stem, extension) = split_extension(original);
        let values: Vec<Option<String>> = self
            .0
            .iter()
            .map(|part| match part {
                NamePart::Tag(tag) => Some(tag_value(*tag, track, stem)),
                NamePart::Text(_) => None,
            })
            .collect();
        let filled = |value: Option<&Option<String>>| {
            value.is_some_and(|v| v.as_ref().is_some_and(|v| !v.is_empty()))
        };
        let mut name = String::new();
        for (i, part) in self.0.iter().enumerate() {
            match part {
                NamePart::Tag(_) => {
                    if let Some(Some(value)) = values.get(i) {
                        name.push_str(value);
                    }
                }
                NamePart::Text(text) => {
                    let before = values[..i].iter().rev().find(|v| v.is_some());
                    let after = values[i + 1..].iter().find(|v| v.is_some());
                    let needed = match (before, after) {
                        (None, None) => true,
                        (Some(_), None) => filled(before),
                        (None, Some(_)) => filled(after),
                        (Some(_), Some(_)) => filled(before) && filled(after),
                    };
                    if needed {
                        name.push_str(text);
                    }
                }
            }
        }
        let name = name.trim();
        let name = if name.is_empty() { stem } else { name };
        safe_file_name(&format!("{name}{extension}"))
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    fn tag(t: NameTag) -> NamePart {
        NamePart::Tag(t)
    }

    fn text(t: &str) -> NamePart {
        NamePart::Text(t.into())
    }

    fn song() -> pdb::Track {
        pdb::Track {
            title: "Glue".into(),
            artist: "Bicep".into(),
            album: "Bicep".into(),
            genre: "Electronic".into(),
            key: "8A".into(),
            tempo: 12_750,
            year: 2017,
            track_number: 3,
            ..pdb::Track::default()
        }
    }

    #[test]
    fn templates_are_checked_when_read() {
        let long = "x".repeat(MAX_TEXT + 1);
        let cases: [(&str, Vec<NamePart>, Result<(), TemplateError>); 6] = [
            ("one tag", vec![tag(NameTag::Title)], Ok(())),
            (
                "tags and text",
                vec![tag(NameTag::Artist), text(" - "), tag(NameTag::Title)],
                Ok(()),
            ),
            ("nothing", vec![], Err(TemplateError::NoTag)),
            ("text alone", vec![text("set")], Err(TemplateError::NoTag)),
            (
                "too long a text",
                vec![tag(NameTag::Title), NamePart::Text(long)],
                Err(TemplateError::TextTooLong),
            ),
            (
                "empty text",
                vec![tag(NameTag::Title), text("")],
                Err(TemplateError::EmptyText),
            ),
        ];
        for (name, parts, expected) in cases {
            assert_eq!(
                FileNameTemplate::try_from(parts).map(|_| ()),
                expected,
                "{name}"
            );
        }
        let too_many = vec![tag(NameTag::Title); MAX_PARTS + 1];
        assert_eq!(
            FileNameTemplate::try_from(too_many),
            Err(TemplateError::TooManyParts)
        );
    }

    #[test]
    fn templates_are_stored_as_a_list_of_parts() {
        let json = r#"[{"tag":"artist"},{"text":" - "},{"tag":"title"}]"#;
        let template: FileNameTemplate = serde_json::from_str(json).expect("template");
        assert_eq!(serde_json::to_string(&template).expect("json"), json);
        for bad in [
            "[]",
            r#"[{"text":"a"}]"#,
            r#"[{"tag":"mood"}]"#,
            r#"{"tag":"title"}"#,
        ] {
            assert!(
                serde_json::from_str::<FileNameTemplate>(bad).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn names_are_filled_from_the_songs_tags() {
        let cases: [(&str, Vec<NamePart>, pdb::Track, &str); 8] = [
            (
                "the default keeps the file name",
                FileNameTemplate::default().into(),
                song(),
                "01 Glue.mp3",
            ),
            (
                "artist and title",
                vec![tag(NameTag::Artist), text(" - "), tag(NameTag::Title)],
                song(),
                "Bicep - Glue.mp3",
            ),
            (
                "numbers",
                vec![
                    tag(NameTag::Bpm),
                    text(" "),
                    tag(NameTag::Key),
                    text(" "),
                    tag(NameTag::Year),
                    text(" "),
                    tag(NameTag::TrackNumber),
                ],
                song(),
                "127.5 8A 2017 03.mp3",
            ),
            (
                "text beside a missing tag goes with it",
                vec![tag(NameTag::Artist), text(" - "), tag(NameTag::Title)],
                pdb::Track {
                    artist: String::new(),
                    ..song()
                },
                "Glue.mp3",
            ),
            (
                "brackets round a missing tag go too",
                vec![
                    text("["),
                    tag(NameTag::Key),
                    text("] "),
                    tag(NameTag::Title),
                ],
                pdb::Track {
                    key: String::new(),
                    ..song()
                },
                "Glue.mp3",
            ),
            (
                "brackets round a tag that is there stay",
                vec![
                    text("["),
                    tag(NameTag::Key),
                    text("] "),
                    tag(NameTag::Title),
                ],
                song(),
                "[8A] Glue.mp3",
            ),
            (
                "nothing to show falls back to the file name",
                vec![tag(NameTag::Genre)],
                pdb::Track {
                    genre: String::new(),
                    ..song()
                },
                "01 Glue.mp3",
            ),
            (
                "characters a drive refuses are replaced",
                vec![tag(NameTag::Artist), text(" / "), tag(NameTag::Title)],
                pdb::Track {
                    title: "What?".into(),
                    ..song()
                },
                "Bicep _ What_.mp3",
            ),
        ];
        for (name, parts, track, expected) in cases {
            let template = FileNameTemplate::try_from(parts).expect("template");
            assert_eq!(template.render(&track, "01 Glue.mp3"), expected, "{name}");
        }
    }

    #[test]
    fn bpm_drops_zeros_after_the_point() {
        for (tempo, expected) in [
            (0, ""),
            (12_800, "128"),
            (12_750, "127.5"),
            (12_725, "127.25"),
        ] {
            assert_eq!(bpm_text(tempo), expected, "{tempo}");
        }
    }
}
