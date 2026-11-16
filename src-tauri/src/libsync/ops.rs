//! The op format.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Version of the op format this build writes and understands.
pub const FORMAT: u32 = 1;

pub const F_NAME: &str = "name";
pub const F_PRESENT: &str = "present";
pub const F_POS: &str = "pos";
/// Tombstone: the entity is gone. Wins over every edit, earlier or later.
pub const F_DELETE: &str = "_delete";
// `_merge` (`val` is the uid the entity was merged into) is part of the format but not written
// yet: such an op is stored like any other and has no effect on the tables.

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
