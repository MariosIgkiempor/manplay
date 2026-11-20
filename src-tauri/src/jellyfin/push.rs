//! What sending the chosen playlists to Jellyfin would change, worked out before anything is
//! sent so it can be reviewed. Pure: the calls are made by the caller.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::{AudioId, PlaylistId, Visibility};

/// What a manplay playlist is known by across renames: `playlist:<uid>`, `smart:<uid>` or
/// `tag:<name>`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PlaylistKey(pub String);

/// Where a manplay playlist was sent before, and who it was made visible to (`None` for one
/// taken over: its sharing was never manplay's).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sent {
    pub id: PlaylistId,
    pub visibility: Option<Visibility>,
}

/// A chosen playlist with its songs in order, by library track id.
pub struct Wanted {
    pub key: PlaylistKey,
    pub name: String,
    pub track_ids: Vec<i64>,
}

/// A playlist on the server as it is now.
pub struct OnServer {
    pub id: PlaylistId,
    pub name: String,
    /// Its songs in order; only read for playlists manplay may change.
    pub songs: Vec<AudioId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Action {
    /// Make it on the server.
    Create,
    /// Replace its songs.
    Refill {
        id: PlaylistId,
    },
    /// Jellyfin cannot rename with an API key: make it under the new name, then delete the old.
    Rename {
        old: PlaylistId,
        old_name: String,
    },
    /// Made for other people than now chosen; sharing cannot be changed with an API key either,
    /// so it is made again and the old one deleted.
    Reshare {
        old: PlaylistId,
    },
    /// No longer chosen: delete it from the server.
    Remove {
        id: PlaylistId,
    },
    Unchanged {
        id: PlaylistId,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Planned {
    pub key: PlaylistKey,
    pub name: String,
    pub action: Action,
    /// The playlist was made outside manplay and has the same name: manplay takes it over.
    pub adopted: bool,
    /// Its songs after the push.
    pub songs: Vec<AudioId>,
    /// Its songs on the server now (empty when new).
    pub before: Vec<AudioId>,
    /// Chosen songs Jellyfin does not have (not synced, or not scanned yet).
    pub left_out: usize,
}

impl Planned {
    /// Changes that delete or take over something on the server: they wait for a review.
    pub fn needs_review(&self) -> bool {
        self.adopted
            || matches!(
                self.action,
                Action::Rename { .. } | Action::Reshare { .. } | Action::Remove { .. }
            )
    }

    pub fn changes(&self) -> bool {
        !matches!(self.action, Action::Unchanged { .. })
    }
}

/// One row of the review: what happens to a playlist, with counts instead of song ids.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub key: PlaylistKey,
    pub name: String,
    /// `create`, `update`, `rename`, `reshare`, `remove` or `unchanged`.
    pub action: &'static str,
    /// The name on the server before a rename.
    pub old_name: Option<String>,
    pub adopted: bool,
    pub songs: usize,
    pub added: usize,
    pub removed: usize,
    pub left_out: usize,
}

impl Planned {
    pub fn row(&self) -> Row {
        let before: HashSet<&AudioId> = self.before.iter().collect();
        let after: HashSet<&AudioId> = self.songs.iter().collect();
        let (action, old_name) = match &self.action {
            Action::Create => ("create", None),
            Action::Refill { .. } => ("update", None),
            Action::Rename { old_name, .. } => ("rename", Some(old_name.clone())),
            Action::Reshare { .. } => ("reshare", None),
            Action::Remove { .. } => ("remove", None),
            Action::Unchanged { .. } => ("unchanged", None),
        };
        Row {
            key: self.key.clone(),
            name: self.name.clone(),
            action,
            old_name,
            adopted: self.adopted,
            songs: self.songs.len(),
            added: after.difference(&before).count(),
            removed: before.difference(&after).count(),
            left_out: self.left_out,
        }
    }
}

/// What a push did, kept as the destination's last push.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Summary {
    pub created: usize,
    pub updated: usize,
    pub renamed: usize,
    /// Made again for the people now chosen to see them.
    pub reshared: usize,
    pub removed: usize,
    /// Changes left for a review (renames, removals, taking over a playlist made elsewhere).
    pub waiting: usize,
    /// One line per playlist that could not be sent.
    pub failed: Vec<String>,
}

/// The songs a wanted playlist gets: matched ones in order, each once.
fn songs_of(wanted: &Wanted, found: &HashMap<i64, AudioId>) -> (Vec<AudioId>, usize) {
    let mut seen = HashSet::new();
    let mut songs = Vec::new();
    let mut left_out = 0;
    for track in &wanted.track_ids {
        match found.get(track) {
            Some(id) => {
                if seen.insert(id) {
                    songs.push(id.clone());
                }
            }
            None => left_out += 1,
        }
    }
    (songs, left_out)
}

/// `known`: where each key was sent before. `server`: the user's playlists. `visibility`: who
/// should see the playlists now.
pub fn plan(
    wanted: &[Wanted],
    known: &HashMap<PlaylistKey, Sent>,
    server: &[OnServer],
    found: &HashMap<i64, AudioId>,
    visibility: &Visibility,
) -> Vec<Planned> {
    let by_id: HashMap<&PlaylistId, &OnServer> = server.iter().map(|p| (&p.id, p)).collect();
    let owned: HashSet<&PlaylistId> = known.values().map(|s| &s.id).collect();
    // A playlist made outside manplay can be taken over once, by the first wanted one named so.
    let mut claimed: HashSet<&PlaylistId> = HashSet::new();
    let mut out = Vec::new();

    for w in wanted {
        let (songs, left_out) = songs_of(w, found);
        let sent = known.get(&w.key);
        let mine = sent.and_then(|s| by_id.get(&s.id)).copied();
        let reshare = sent
            .and_then(|s| s.visibility.as_ref())
            .is_some_and(|v| v != visibility);
        let (action, adopted, before) = if let Some(p) = mine {
            let action = if p.name != w.name {
                Action::Rename {
                    old: p.id.clone(),
                    old_name: p.name.clone(),
                }
            } else if reshare {
                Action::Reshare { old: p.id.clone() }
            } else if p.songs == songs {
                Action::Unchanged { id: p.id.clone() }
            } else {
                Action::Refill { id: p.id.clone() }
            };
            (action, false, p.songs.clone())
        } else if let Some(p) = server
            .iter()
            .find(|p| p.name == w.name && !owned.contains(&p.id) && !claimed.contains(&p.id))
        {
            claimed.insert(&p.id);
            let action = if p.songs == songs {
                Action::Unchanged { id: p.id.clone() }
            } else {
                Action::Refill { id: p.id.clone() }
            };
            (action, true, p.songs.clone())
        } else {
            (Action::Create, false, Vec::new())
        };
        out.push(Planned {
            key: w.key.clone(),
            name: w.name.clone(),
            action,
            adopted,
            songs,
            before,
            left_out,
        });
    }

    let chosen: HashSet<&PlaylistKey> = wanted.iter().map(|w| &w.key).collect();
    let mut gone: Vec<(&PlaylistKey, &OnServer)> = known
        .iter()
        .filter(|(key, _)| !chosen.contains(key))
        .filter_map(|(key, sent)| Some((key, *by_id.get(&sent.id)?)))
        .collect();
    gone.sort_by(|a, b| a.1.name.cmp(&b.1.name));
    for (key, p) in gone {
        out.push(Planned {
            key: key.clone(),
            name: p.name.clone(),
            action: Action::Remove { id: p.id.clone() },
            adopted: false,
            songs: Vec::new(),
            before: p.songs.clone(),
            left_out: 0,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(id: &str) -> AudioId {
        AudioId(id.to_owned())
    }

    fn key(k: &str) -> PlaylistKey {
        PlaylistKey(k.to_owned())
    }

    fn pid(id: &str) -> PlaylistId {
        PlaylistId(id.to_owned())
    }

    fn wanted(k: &str, name: &str, tracks: &[i64]) -> Wanted {
        Wanted {
            key: key(k),
            name: name.to_owned(),
            track_ids: tracks.to_vec(),
        }
    }

    fn on_server(id: &str, name: &str, songs: &[&str]) -> OnServer {
        OnServer {
            id: pid(id),
            name: name.to_owned(),
            songs: songs.iter().map(|s| song(s)).collect(),
        }
    }

    /// Tracks 1–3 are songs a–c in Jellyfin; track 9 is not in Jellyfin.
    fn found() -> HashMap<i64, AudioId> {
        [(1, "a"), (2, "b"), (3, "c")]
            .into_iter()
            .map(|(t, s)| (t, song(s)))
            .collect()
    }

    /// (case, wanted, known (key, playlist, made visible to), server, expected: name, action,
    /// adopted, left out). Playlists should now be visible to everyone.
    type Case = (
        &'static str,
        Vec<Wanted>,
        Vec<(&'static str, &'static str, Option<Visibility>)>,
        Vec<OnServer>,
        Vec<(&'static str, Action, bool, usize)>,
    );

    #[allow(clippy::too_many_lines)] // one row per case
    fn cases() -> Vec<Case> {
        vec![
            (
                "new playlist",
                vec![wanted("playlist:u1", "House", &[1, 2, 9])],
                vec![],
                vec![],
                vec![("House", Action::Create, false, 1)],
            ),
            (
                "sent before, same songs",
                vec![wanted("playlist:u1", "House", &[1, 2])],
                vec![("playlist:u1", "p1", Some(Visibility::Everyone))],
                vec![on_server("p1", "House", &["a", "b"])],
                vec![("House", Action::Unchanged { id: pid("p1") }, false, 0)],
            ),
            (
                "sent before, songs changed",
                vec![wanted("playlist:u1", "House", &[2, 1])],
                vec![("playlist:u1", "p1", Some(Visibility::Everyone))],
                vec![on_server("p1", "House", &["a", "b"])],
                vec![("House", Action::Refill { id: pid("p1") }, false, 0)],
            ),
            (
                "renamed in manplay",
                vec![wanted("playlist:u1", "Deep House", &[1])],
                vec![("playlist:u1", "p1", Some(Visibility::Everyone))],
                vec![on_server("p1", "House", &["a"])],
                vec![(
                    "Deep House",
                    Action::Rename {
                        old: pid("p1"),
                        old_name: "House".to_owned(),
                    },
                    false,
                    0,
                )],
            ),
            (
                "deleted on the server since: made again",
                vec![wanted("playlist:u1", "House", &[1])],
                vec![("playlist:u1", "p1", Some(Visibility::Everyone))],
                vec![],
                vec![("House", Action::Create, false, 0)],
            ),
            (
                "made outside manplay with that name: taken over",
                vec![wanted("playlist:u1", "House", &[1])],
                vec![],
                vec![on_server("p7", "House", &["c"])],
                vec![("House", Action::Refill { id: pid("p7") }, true, 0)],
            ),
            (
                "two chosen with one name: only the first takes it over",
                vec![
                    wanted("playlist:u1", "House", &[1]),
                    wanted("tag:House", "House", &[2]),
                ],
                vec![],
                vec![on_server("p7", "House", &["a"])],
                vec![
                    ("House", Action::Unchanged { id: pid("p7") }, true, 0),
                    ("House", Action::Create, false, 0),
                ],
            ),
            (
                "another chosen playlist's name is not taken over",
                vec![wanted("smart:s1", "Techno", &[1])],
                vec![("playlist:u1", "p1", Some(Visibility::Everyone))],
                vec![on_server("p1", "Techno", &["a"])],
                vec![
                    ("Techno", Action::Create, false, 0),
                    ("Techno", Action::Remove { id: pid("p1") }, false, 0),
                ],
            ),
            (
                "no longer chosen: removed",
                vec![],
                vec![("playlist:u1", "p1", Some(Visibility::Everyone))],
                vec![on_server("p1", "House", &["a"])],
                vec![("House", Action::Remove { id: pid("p1") }, false, 0)],
            ),
            (
                "no longer chosen and already gone: nothing",
                vec![],
                vec![("playlist:u1", "p1", Some(Visibility::Everyone))],
                vec![],
                vec![],
            ),
            (
                "made for fewer people than now chosen: made again",
                vec![wanted("playlist:u1", "House", &[1])],
                vec![("playlist:u1", "p1", Some(Visibility::OnlyMe))],
                vec![on_server("p1", "House", &["a"])],
                vec![("House", Action::Reshare { old: pid("p1") }, false, 0)],
            ),
            (
                "taken over earlier: its sharing is left alone",
                vec![wanted("playlist:u1", "House", &[1])],
                vec![("playlist:u1", "p1", None)],
                vec![on_server("p1", "House", &["a"])],
                vec![("House", Action::Unchanged { id: pid("p1") }, false, 0)],
            ),
            (
                "renamed and reshared: one remake",
                vec![wanted("playlist:u1", "Deep", &[1])],
                vec![("playlist:u1", "p1", Some(Visibility::OnlyMe))],
                vec![on_server("p1", "House", &["a"])],
                vec![(
                    "Deep",
                    Action::Rename {
                        old: pid("p1"),
                        old_name: "House".to_owned(),
                    },
                    false,
                    0,
                )],
            ),
            (
                "a song twice is sent once",
                vec![wanted("playlist:u1", "House", &[1, 1, 2])],
                vec![],
                vec![],
                vec![("House", Action::Create, false, 0)],
            ),
        ]
    }

    #[test]
    fn plans_what_changes_on_the_server() {
        for (name, wanted, known, server, expected) in cases() {
            let known: HashMap<PlaylistKey, Sent> = known
                .into_iter()
                .map(|(k, id, visibility)| {
                    (
                        key(k),
                        Sent {
                            id: pid(id),
                            visibility,
                        },
                    )
                })
                .collect();
            let planned = plan(&wanted, &known, &server, &found(), &Visibility::Everyone);
            let got: Vec<(&str, Action, bool, usize)> = planned
                .iter()
                .map(|p| (p.name.as_str(), p.action.clone(), p.adopted, p.left_out))
                .collect();
            assert_eq!(got, expected, "{name}");
        }
    }

    #[test]
    fn deleting_or_taking_over_waits_for_a_review() {
        let base = Planned {
            key: key("playlist:u1"),
            name: "House".to_owned(),
            action: Action::Create,
            adopted: false,
            songs: vec![],
            before: vec![],
            left_out: 0,
        };
        let cases = [
            (Action::Create, false, false),
            (Action::Refill { id: pid("p1") }, false, false),
            (Action::Unchanged { id: pid("p1") }, false, false),
            (Action::Refill { id: pid("p1") }, true, true),
            (
                Action::Rename {
                    old: pid("p1"),
                    old_name: "x".to_owned(),
                },
                false,
                true,
            ),
            (Action::Remove { id: pid("p1") }, false, true),
            (Action::Reshare { old: pid("p1") }, false, true),
        ];
        for (action, adopted, review) in cases {
            let p = Planned {
                action: action.clone(),
                adopted,
                ..base.clone()
            };
            assert_eq!(p.needs_review(), review, "{action:?} adopted={adopted}");
        }
    }

    #[test]
    fn review_rows_count_songs_added_and_removed() {
        let planned = plan(
            &[wanted("playlist:u1", "House", &[2, 3, 9])],
            &[(
                key("playlist:u1"),
                Sent {
                    id: pid("p1"),
                    visibility: Some(Visibility::OnlyMe),
                },
            )]
            .into_iter()
            .collect(),
            &[on_server("p1", "House", &["a", "b"])],
            &found(),
            &Visibility::OnlyMe,
        );
        let row = planned[0].row();
        assert_eq!(
            (row.action, row.songs, row.added, row.removed, row.left_out),
            ("update", 2, 1, 1, 1)
        );
    }

    #[test]
    fn songs_keep_their_order() {
        let planned = plan(
            &[wanted("playlist:u1", "House", &[3, 9, 1, 2])],
            &HashMap::new(),
            &[],
            &found(),
            &Visibility::OnlyMe,
        );
        assert_eq!(planned[0].songs, vec![song("c"), song("a"), song("b")]);
    }
}
