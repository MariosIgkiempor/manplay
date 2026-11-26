//! The op format.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Version of the op format this build writes and understands.
pub const FORMAT: u32 = 1;

pub const F_NAME: &str = "name";
pub const F_PRESENT: &str = "present";
pub const F_POS: &str = "pos";
/// Where a `file` is, below the library folder: the folder names and the file name, in order.
pub const F_PATH: &str = "path";
/// A smart playlist's rules (tags by uid).
pub const F_RULES: &str = "rules";

// Fields of an `analysis` entity. The plain ones hold the automatic result; a hand edit goes to
// the `*_hand` register and raises the `*_edited` flag, and while a flag is up the hand value
// is the one that shows, whatever the clocks say.
pub const A_BPM: &str = "bpm";
pub const A_KEY: &str = "key";
pub const A_GRID_BPM: &str = "grid_bpm";
pub const A_FIRST_BEAT: &str = "first_beat";
pub const A_BAR_OFFSET: &str = "bar_offset";
pub const A_DURATION: &str = "duration";
/// The analysis version that made the result; names the waveform file.
pub const A_VERSION: &str = "version";
pub const A_BPM_HAND: &str = "bpm_hand";
pub const A_KEY_HAND: &str = "key_hand";
/// `{grid_bpm, first_beat, bar_offset}` set in the grid editor.
pub const A_GRID_HAND: &str = "grid_hand";
pub const A_BPM_EDITED: &str = "bpm_edited";
pub const A_KEY_EDITED: &str = "key_edited";
pub const A_GRID_EDITED: &str = "grid_edited";
/// Tombstone: the entity is gone. Wins over every edit, earlier or later. Its value is `null`;
/// a later `_delete` with the value `false` takes it back (Restore in Recently deleted).
pub const F_DELETE: &str = "_delete";
/// The entity was merged into another of its kind (`val` is that uid). It is gone like a
/// tombstone, and everything that pointed at it (memberships, smart playlist rules) points at the
/// target instead, on every device.
pub const F_MERGE: &str = "_merge";

/// What an op is about. Entities this build does not know are kept as `Other` (stored and
/// forwarded, never applied) so a newer device's data is not lost.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Entity {
    Tag,
    Playlist,
    PlaylistTrack,
    TrackTag,
    SmartPlaylist,
    TagCustom,
    Analysis,
    /// A song's file, by `audio_fp`: where it is (`path`) and whether the library still has it
    /// (`present`). See `files.rs`.
    File,
    Other(String),
}

impl Entity {
    pub fn parse(s: &str) -> Self {
        match s {
            "tag" => Self::Tag,
            "playlist" => Self::Playlist,
            "playlist_track" => Self::PlaylistTrack,
            "track_tag" => Self::TrackTag,
            "smart_playlist" => Self::SmartPlaylist,
            "tag_custom" => Self::TagCustom,
            "analysis" => Self::Analysis,
            "file" => Self::File,
            other => Self::Other(other.to_owned()),
        }
    }
}

/// One line of a log chunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Op {
    pub v: u32,
    pub clock: String,
    pub dev: String,
    pub e: String,
    pub id: String,
    pub f: String,
    #[serde(default)]
    pub val: Value,
}

impl Op {
    pub fn entity(&self) -> Entity {
        Entity::parse(&self.e)
    }

    /// The `audio_fp` a membership op is about (`<parent uid>/<audio_fp>`), so ops for tracks the
    /// library does not have yet can be found when the track appears.
    pub fn reference(&self) -> Option<&str> {
        match self.entity() {
            Entity::TrackTag | Entity::PlaylistTrack => self.id.split_once('/').map(|(_, fp)| fp),
            _ => None,
        }
    }
}

/// Id of a membership: the parent's uid and the track's `audio_fp`.
pub fn member_id(parent: &str, audio_fp: &str) -> String {
    format!("{parent}/{audio_fp}")
}
