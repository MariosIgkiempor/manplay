//! Destination files the user never wants offered: an ignored song, or every file under an
//! ignored folder (an album), drops out of a destination's "Only on …" list. It is then neither
//! copied into the library nor deleted from the destination. Kept per destination, by path, and
//! undone by unignoring. Applied when a read is shown, not when it is made, so ignoring and
//! unignoring take effect at once without reading the destination again.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::sync::{Action, Kind, folded, safe_rel};
use crate::sync_scans::{MissingFile, TargetId, TargetScan};

/// A path on a destination, relative to the destination folder, one folder or file name per
/// segment. Only plain names are accepted, so a rule can never reach outside the destination.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "Vec<String>", into = "Vec<String>")]
pub struct RemotePath(Vec<String>);

impl RemotePath {
    pub fn segments(&self) -> &[String] {
        &self.0
    }
}

impl TryFrom<Vec<String>> for RemotePath {
    type Error = String;

    fn try_from(segments: Vec<String>) -> Result<Self, Self::Error> {
        if safe_rel(&segments) {
            Ok(Self(segments))
        } else {
            Err(format!("not a path on the destination: {segments:?}"))
        }
    }
}

impl From<RemotePath> for Vec<String> {
    fn from(path: RemotePath) -> Self {
        path.0
    }
}

/// What a rule covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IgnoreScope {
    /// The one file at the path.
    File,
    /// Every file anywhere under the folder at the path, including ones added later.
    Folder,
}

impl IgnoreScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Folder => "folder",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "file" => Some(Self::File),
            "folder" => Some(Self::Folder),
            _ => None,
        }
    }
}

/// One thing ignored on a destination.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreRule {
    pub rel: RemotePath,
    pub scope: IgnoreScope,
}

impl IgnoreRule {
    /// Whether the rule covers the destination file at `rel`. Paths compare the way destinations
    /// treat them: case and Unicode form do not matter (see [`folded`]).
    fn covers(&self, rel: &[String]) -> bool {
        let own = folded(self.rel.segments());
        let file = folded(rel);
        match self.scope {
            IgnoreScope::File => file == own,
            IgnoreScope::Folder => file.len() > own.len() && file.starts_with(&own),
        }
    }
}

/// The rules of one destination.
#[derive(Debug, Clone, Default)]
pub struct IgnoreList {
    rules: Vec<IgnoreRule>,
}

/// Every destination's rules, by destination.
pub type Ignores = HashMap<TargetId, IgnoreList>;

impl IgnoreList {
    pub fn new(rules: Vec<IgnoreRule>) -> Self {
        Self { rules }
    }

    pub fn covers(&self, rel: &[String]) -> bool {
        self.rules.iter().any(|rule| rule.covers(rel))
    }

    /// Whether a planned action is a delete of a destination-only file under a rule.
    fn hides(&self, action: &Action) -> bool {
        action.kind == Kind::Delete && self.covers(&action.rel)
    }

    /// Songs the library lacks still offered, and pushes still planned, once the rules apply.
    pub fn counts(&self, scan: &TargetScan) -> (usize, usize) {
        let missing = scan
            .pull
            .missing
            .iter()
            .filter(|m| !self.covers(&m.file.rel))
            .count();
        let hidden_deletes = scan.plan.actions.iter().filter(|a| self.hides(a)).count();
        (missing, scan.plan.actions.len() - hidden_deletes)
    }
}

/// A rule as the review lists it, with how many files of the shown read it hides.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredView {
    #[serde(flatten)]
    pub rule: IgnoreRule,
    pub files: usize,
}

/// A read as the review shows it: without the files the rules hide, and the rules themselves.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShownScan {
    #[serde(flatten)]
    pub scan: TargetScan,
    pub ignored: Vec<IgnoredView>,
}

/// `scan` without the destination-only files `list` hides. Every rule is listed, also one that
/// hides nothing in this read (its files may have gone from the destination), so it can be undone.
pub fn shown(scan: &TargetScan, list: &IgnoreList) -> ShownScan {
    let mut out = scan.clone();
    let mut hidden: HashSet<Vec<String>> = HashSet::new();
    out.pull.missing.retain(|m: &MissingFile| {
        let covered = list.covers(&m.file.rel);
        if covered {
            hidden.insert(m.file.rel.clone());
        }
        !covered
    });
    out.plan.actions.retain(|a| {
        let covered = list.hides(a);
        if covered {
            hidden.insert(a.rel.clone());
        }
        !covered
    });
    let ignored = list
        .rules
        .iter()
        .map(|rule| IgnoredView {
            rule: rule.clone(),
            files: hidden.iter().filter(|rel| rule.covers(rel)).count(),
        })
        .collect();
    ShownScan { scan: out, ignored }
}

#[cfg(test)]
#[allow(clippy::expect_used)] // test fixtures: panicking is the failure mode
mod tests {
    use super::*;
    use crate::sync::{Remote, TargetPlan};
    use crate::sync_scans::{PlanId, PullScan};

    fn path(p: &str) -> Vec<String> {
        p.split('/').map(str::to_owned).collect()
    }

    fn rule(p: &str, scope: IgnoreScope) -> IgnoreRule {
        IgnoreRule {
            rel: RemotePath::try_from(path(p)).expect("valid path"),
            scope,
        }
    }

    struct CoverCase {
        name: &'static str,
        rule: IgnoreRule,
        file: &'static str,
        covered: bool,
    }

    #[test]
    fn rules_cover_their_file_or_everything_under_their_folder() {
        let cases = [
            CoverCase {
                name: "file: the same path",
                rule: rule("A/B/01 x.flac", IgnoreScope::File),
                file: "A/B/01 x.flac",
                covered: true,
            },
            CoverCase {
                name: "file: another case and Unicode form",
                rule: rule("Pa\u{303}o/b/01.mp3", IgnoreScope::File),
                file: "P\u{e3}O/B/01.mp3",
                covered: true,
            },
            CoverCase {
                name: "file: a sibling",
                rule: rule("A/B/01 x.flac", IgnoreScope::File),
                file: "A/B/02 y.flac",
                covered: false,
            },
            CoverCase {
                name: "folder: a file in it",
                rule: rule("A/B", IgnoreScope::Folder),
                file: "A/B/01 x.flac",
                covered: true,
            },
            CoverCase {
                name: "folder: a file in a subfolder",
                rule: rule("A/B", IgnoreScope::Folder),
                file: "A/B/CD1/01 x.flac",
                covered: true,
            },
            CoverCase {
                name: "folder: a folder whose name starts the same",
                rule: rule("A/B", IgnoreScope::Folder),
                file: "A/B side/01 x.flac",
                covered: false,
            },
            CoverCase {
                name: "folder: a file named like the folder",
                rule: rule("A/B", IgnoreScope::Folder),
                file: "A/B",
                covered: false,
            },
        ];
        for case in cases {
            assert_eq!(
                IgnoreList::new(vec![case.rule]).covers(&path(case.file)),
                case.covered,
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn only_plain_paths_make_a_rule() {
        let cases: [(&str, Vec<String>, bool); 6] = [
            ("a file", path("A/B/01.flac"), true),
            ("empty", vec![], false),
            ("an empty segment", path("A//01.flac"), false),
            ("a parent step", path("A/../01.flac"), false),
            ("a slash in a segment", vec!["A/B".to_owned()], false),
            ("a backslash in a segment", vec!["A\\B".to_owned()], false),
        ];
        for (name, segments, valid) in cases {
            assert_eq!(RemotePath::try_from(segments).is_ok(), valid, "{name}");
        }
        let parsed: Result<IgnoreRule, _> =
            serde_json::from_str(r#"{"rel":["..","x.flac"],"scope":"file"}"#);
        assert!(parsed.is_err(), "a rule from the frontend is checked too");
        let parsed: Result<IgnoreRule, _> =
            serde_json::from_str(r#"{"rel":["A","x.flac"],"scope":"everything"}"#);
        assert!(parsed.is_err(), "an unknown scope is refused");
    }

    fn missing(p: &str) -> MissingFile {
        MissingFile {
            file: Remote {
                rel: path(p),
                size: 1,
                version: None,
            },
            other_format: None,
        }
    }

    fn action(kind: Kind, p: &str) -> Action {
        Action::new(1, kind, &path(p))
    }

    fn scan() -> TargetScan {
        let target = crate::db::SyncTarget {
            id: 1,
            tailnet: "tailnet".to_owned(),
            machine: "machine".to_owned(),
            path: Vec::new(),
            synced_tracks: 0,
            libsync: false,
            library_name: None,
        };
        let mut plan = TargetPlan::failed(&target, String::new());
        plan.actions = vec![
            action(Kind::Delete, "Them/Live/01.flac"),
            action(Kind::Delete, "Me/Mine/01.flac"),
            action(Kind::Upload, "Them/Live/02.flac"),
        ];
        TargetScan {
            target_id: 1,
            plan_id: PlanId("p".to_owned()),
            scanned_at: 0,
            plan,
            pull: PullScan {
                total: 4,
                missing: vec![
                    missing("Them/Live/01.flac"),
                    missing("Them/Live/03.flac"),
                    missing("Other/x.flac"),
                ],
                error: None,
            },
        }
    }

    #[test]
    fn a_shown_read_leaves_out_what_the_rules_hide_and_lists_every_rule() {
        let list = IgnoreList::new(vec![
            rule("Them/Live", IgnoreScope::Folder),
            rule("Gone/y.flac", IgnoreScope::File),
        ]);
        let shown = shown(&scan(), &list);
        let rels: Vec<String> = shown
            .scan
            .pull
            .missing
            .iter()
            .map(|m| m.file.rel.join("/"))
            .collect();
        assert_eq!(rels, ["Other/x.flac"]);
        let actions: Vec<(Kind, String)> = shown
            .scan
            .plan
            .actions
            .iter()
            .map(|a| (a.kind, a.rel.join("/")))
            .collect();
        assert_eq!(
            actions,
            [
                (Kind::Delete, "Me/Mine/01.flac".to_owned()),
                // A library file going into an ignored folder is not the destination's own.
                (Kind::Upload, "Them/Live/02.flac".to_owned()),
            ]
        );
        let files: Vec<usize> = shown.ignored.iter().map(|i| i.files).collect();
        assert_eq!(
            files,
            [2, 0],
            "01 counts once though it is both a pull and a delete"
        );
    }

    #[test]
    fn counts_match_the_shown_read() {
        let list = IgnoreList::new(vec![rule("Them/Live", IgnoreScope::Folder)]);
        let scan = scan();
        let shown = shown(&scan, &list);
        assert_eq!(
            list.counts(&scan),
            (shown.scan.pull.missing.len(), shown.scan.plan.actions.len())
        );
        assert_eq!(IgnoreList::default().counts(&scan), (3, 3));
    }

    #[test]
    fn rules_are_kept_per_destination_until_unignored() {
        let dir = std::env::temp_dir().join(format!("manplay-ignore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut conn = crate::db::open(&dir.join("library.db")).expect("open db");
        let target = |machine: &str| crate::db::NewTarget {
            tailnet: "t".to_owned(),
            machine: machine.to_owned(),
            path: vec!["share".to_owned()],
        };
        let one = crate::db::add_target(&conn, &target("one")).expect("target");
        let two = crate::db::add_target(&conn, &target("two")).expect("target");
        let album = rule("Them/Live", IgnoreScope::Folder);
        let song = rule("Other/x.flac", IgnoreScope::File);
        crate::db::add_sync_ignores(&mut conn, one, std::slice::from_ref(&album), 10)
            .expect("ignore");
        crate::db::add_sync_ignores(&mut conn, one, std::slice::from_ref(&song), 11)
            .expect("ignore");
        crate::db::add_sync_ignores(&mut conn, one, std::slice::from_ref(&album), 20)
            .expect("ignore again");
        crate::db::add_sync_ignores(&mut conn, two, std::slice::from_ref(&song), 10)
            .expect("ignore");
        let rules = |conn: &rusqlite::Connection, id| {
            crate::db::sync_ignores(conn)
                .expect("read")
                .get(&id)
                .map(|l| l.rules.clone())
                .unwrap_or_default()
        };
        assert_eq!(rules(&conn, one), [album.clone(), song.clone()]);
        assert_eq!(rules(&conn, two), std::slice::from_ref(&song));

        crate::db::remove_sync_ignores(&mut conn, one, std::slice::from_ref(&album))
            .expect("unignore");
        assert_eq!(rules(&conn, one), std::slice::from_ref(&song));
        assert_eq!(
            rules(&conn, two),
            std::slice::from_ref(&song),
            "the other destination keeps its own"
        );

        crate::db::set_target_path(&mut conn, two, &["elsewhere".to_owned()]).expect("move");
        assert!(
            rules(&conn, two).is_empty(),
            "paths of the old folder are dropped"
        );
        crate::db::remove_target(&conn, one).expect("remove");
        assert!(
            rules(&conn, one).is_empty(),
            "removing the destination drops its rules"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
