//! Smart playlists: rules over tags, when a song was added and its tempo, worked out into songs
//! at export time. They never become library playlists. Stored (and shared) rules name tags by
//! uid; everything else in the app, the editor included, sees tag names (see `db.rs`).

use serde::{Deserialize, Serialize};

use crate::db::Track;

const DAY: i64 = 86_400;

/// How far back "in the last …" reaches.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Unit {
    Days,
    Weeks,
    Months,
}

/// When a song came into the library.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Added {
    /// On or after this day (unix seconds of its start).
    After { date: i64 },
    /// Before this day (unix seconds of its start).
    Before { date: i64 },
    /// In the last `amount` units, counted back from the export, so the playlist stays fresh.
    Within { amount: i64, unit: Unit },
}

impl Added {
    /// The earliest and latest-plus-one `added_at` that match, at `now`.
    fn window(&self, now: i64) -> (i64, i64) {
        match *self {
            Self::After { date } => (date, i64::MAX),
            Self::Before { date } => (i64::MIN, date),
            Self::Within { amount, unit } => {
                let days = match unit {
                    Unit::Days => 1,
                    Unit::Weeks => 7,
                    Unit::Months => 30,
                };
                (now.saturating_sub(amount.max(0) * days * DAY), i64::MAX)
            }
        }
    }
}

/// What a song needs to be in the playlist. Every part that is set must hold; empty parts are
/// ignored. A tag includes the tags below it, as tag playlists do.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Rules {
    /// Has every one of these.
    pub all_tags: Vec<String>,
    /// Has at least one of these.
    pub any_tags: Vec<String>,
    /// Has none of these.
    pub none_tags: Vec<String>,
    pub added: Option<Added>,
    pub bpm_min: Option<f64>,
    pub bpm_max: Option<f64>,
}

impl Rules {
    /// The same rules with every tag entry replaced by `f(entry)`; entries that end up equal
    /// within a group are kept once.
    pub fn map_tags(&self, mut f: impl FnMut(&str) -> String) -> Self {
        let mut map = |names: &[String]| {
            let mut out: Vec<String> = Vec::new();
            for name in names {
                let mapped = f(name);
                if !out.contains(&mapped) {
                    out.push(mapped);
                }
            }
            out
        };
        Self {
            all_tags: map(&self.all_tags),
            any_tags: map(&self.any_tags),
            none_tags: map(&self.none_tags),
            ..self.clone()
        }
    }
}

/// Whether a stored tag entry is a tag's uid (rules are kept by uid, so renaming a tag leaves
/// them intact) rather than a name from before rules were kept by uid.
pub fn is_uid(entry: &str) -> bool {
    uuid::Uuid::parse_str(entry).is_ok()
}

/// How an unresolved uid is shown to the editor: this device does not have the tag (it is
/// local to another device, or deleted). Sent back unchanged, it keeps the uid.
pub const UNKNOWN_PREFIX: char = '?';

/// A smart playlist as stored for a destination.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SmartPlaylist {
    pub id: i64,
    pub name: String,
    pub rules: Rules,
}

/// The tag or one below it (`Genre/House` is within `Genre`), ignoring case.
fn within(tag: &str, ancestor: &str) -> bool {
    let (tag, ancestor) = (tag.to_lowercase(), ancestor.to_lowercase());
    tag.strip_prefix(&ancestor)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

fn has(track: &Track, wanted: &str) -> bool {
    track.tags.iter().any(|t| within(t, wanted))
}

/// Why a song is left out, when the reason is worth telling.
#[derive(Debug, PartialEq, Eq)]
enum Miss {
    /// Fails a rule.
    Rule,
    /// Matches the tags but has no added date, so a date rule cannot hold.
    Undated,
}

fn check(rules: &Rules, track: &Track, now: i64) -> Result<(), Miss> {
    let tags_ok = rules.all_tags.iter().all(|t| has(track, t))
        && (rules.any_tags.is_empty() || rules.any_tags.iter().any(|t| has(track, t)))
        && !rules.none_tags.iter().any(|t| has(track, t));
    if !tags_ok {
        return Err(Miss::Rule);
    }
    if rules.bpm_min.is_some() || rules.bpm_max.is_some() {
        let Some(bpm) = track.bpm else {
            return Err(Miss::Rule);
        };
        if rules.bpm_min.is_some_and(|m| bpm < m) || rules.bpm_max.is_some_and(|m| bpm > m) {
            return Err(Miss::Rule);
        }
    }
    if let Some(added) = &rules.added {
        let Some(at) = track.added_at else {
            return Err(Miss::Undated);
        };
        let (from, until) = added.window(now);
        if at < from || at >= until {
            return Err(Miss::Rule);
        }
    }
    Ok(())
}

/// The songs a rule set picks from `tracks`, in their order.
pub fn resolve(rules: &Rules, tracks: &[Track], now: i64) -> Vec<i64> {
    tracks
        .iter()
        .filter(|t| check(rules, t, now).is_ok())
        .map(|t| t.id)
        .collect()
}

/// What a rule set picks right now, for the builder's live count.
#[derive(Serialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub track_ids: Vec<i64>,
    pub duration_ms: i64,
    pub bytes: i64,
    /// Songs that match everything else but have no added date.
    pub undated: usize,
}

pub fn preview(rules: &Rules, tracks: &[Track], now: i64) -> Preview {
    let mut out = Preview::default();
    for t in tracks {
        match check(rules, t, now) {
            Ok(()) => {
                out.track_ids.push(t.id);
                out.duration_ms += t.duration_ms.unwrap_or(0);
                out.bytes += t.size;
            }
            Err(Miss::Undated) => out.undated += 1,
            Err(Miss::Rule) => {}
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;
    use crate::db::Edited;

    fn song(id: i64, tags: &[&str], added_at: Option<i64>, bpm: Option<f64>) -> Track {
        Track {
            id,
            path: format!("/{id}.mp3"),
            artist: String::new(),
            album: String::new(),
            title: String::new(),
            size: 10,
            tags: tags.iter().map(|&t| t.to_owned()).collect(),
            synced_count: 0,
            duration_ms: Some(1000),
            bitrate: None,
            sample_rate: None,
            bpm,
            key: None,
            analyzed: false,
            fields: std::collections::BTreeMap::new(),
            edited: Edited::default(),
            added_at,
        }
    }

    fn library() -> Vec<Track> {
        vec![
            song(
                1,
                &["instrumental", "Genre/House"],
                Some(100 * DAY),
                Some(124.0),
            ),
            song(
                2,
                &["instrumental", "Genre/House/Deep"],
                Some(10 * DAY),
                Some(120.0),
            ),
            song(3, &["Genre/House", "vocal"], Some(100 * DAY), Some(126.0)),
            song(4, &["instrumental", "Genre/Techno"], None, Some(130.0)),
            song(5, &["Instrumental", "genre/house"], None, None),
        ]
    }

    #[test]
    fn all_of_needs_every_tag_and_reaches_tags_below() {
        let rules = Rules {
            all_tags: vec!["instrumental".into(), "Genre/House".into()],
            ..Rules::default()
        };
        assert_eq!(resolve(&rules, &library(), 0), [1, 2, 5]);
    }

    #[test]
    fn any_of_and_none_of() {
        let rules = Rules {
            any_tags: vec!["Genre/Techno".into(), "vocal".into()],
            none_tags: vec!["Genre/House".into()],
            ..Rules::default()
        };
        assert_eq!(resolve(&rules, &library(), 0), [4]);
    }

    #[test]
    fn date_rules_leave_out_undated_songs_and_count_them() {
        let now = 101 * DAY;
        let recent = Rules {
            all_tags: vec!["instrumental".into()],
            added: Some(Added::Within {
                amount: 2,
                unit: Unit::Weeks,
            }),
            ..Rules::default()
        };
        assert_eq!(resolve(&recent, &library(), now), [1]);
        let p = preview(&recent, &library(), now);
        assert_eq!((p.track_ids.len(), p.undated, p.bytes), (1, 2, 10));

        let after = Rules {
            added: Some(Added::After { date: 50 * DAY }),
            ..Rules::default()
        };
        assert_eq!(resolve(&after, &library(), now), [1, 3]);
        let before = Rules {
            added: Some(Added::Before { date: 50 * DAY }),
            ..Rules::default()
        };
        assert_eq!(resolve(&before, &library(), now), [2]);
    }

    #[test]
    fn bpm_range_is_inclusive_and_skips_unknown_tempo() {
        let rules = Rules {
            bpm_min: Some(120.0),
            bpm_max: Some(126.0),
            ..Rules::default()
        };
        assert_eq!(resolve(&rules, &library(), 0), [1, 2, 3]);
    }

    #[test]
    fn map_tags_keeps_each_entry_once() {
        let rules = Rules {
            all_tags: vec!["a".into(), "A".into(), "b".into()],
            ..Rules::default()
        };
        let lower = rules.map_tags(str::to_lowercase);
        assert_eq!(lower.all_tags, ["a", "b"]);
        assert!(is_uid("0190a0e5-7c1e-7d3a-8b1b-2f6a1c3d4e5f"));
        assert!(!is_uid("Genre/House"));
    }

    #[test]
    fn rules_read_from_json_with_parts_left_out() {
        let rules: Rules = serde_json::from_str(
            r#"{"allTags":["house"],"added":{"kind":"within","amount":30,"unit":"days"}}"#,
        )
        .expect("json");
        assert_eq!(
            rules.added,
            Some(Added::Within {
                amount: 30,
                unit: Unit::Days
            })
        );
        assert_eq!(rules.none_tags, Vec::<String>::new());
    }
}
