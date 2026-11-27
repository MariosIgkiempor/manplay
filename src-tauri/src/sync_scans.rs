//! What each sync destination would get and give, read in the background one destination at a
//! time and kept so a review opens at once. A kept plan can be applied while it is fresh and the
//! library it was compared with has not changed.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::Error;
use crate::scan;
use crate::sync::{Item, Kind, Known, Remote, TargetPlan};
use crate::sync_ignore::{IgnoreList, Ignores};

/// Database id of a sync destination.
pub type TargetId = i64;

/// Unix time in seconds, UTC.
pub type UnixSeconds = i64;

/// Names one read of one destination; a review applies the plans it was shown by these.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PlanId(pub String);

/// How long after its destination was read a plan may still be applied.
pub const MAX_PLAN_AGE_SECS: i64 = 30 * 60;

/// How often every destination is checked again on its own (a [`ReadDepth::Quick`] read).
pub const RESCAN_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// How long a background read waits on a destination that sends nothing before giving up on it.
pub const STALLED_AFTER: Duration = Duration::from_secs(60);

/// How long the library must stay unchanged before the destinations are checked against it.
pub const LIBRARY_SETTLE: Duration = Duration::from_secs(30);

/// Plans kept per destination, so a review left open while a newer read lands can still run.
const PLANS_KEPT_PER_TARGET: usize = 3;

pub const OUT_OF_DATE: &str = "this review is out of date: review the changes again";

/// The library as a plan saw it: which tracks there were, and a hash of what the plan used of
/// them (paths, sizes, modification times, fingerprints, missing state). Tracks added later
/// (e.g. pulled in the same sync) do not count; the planned ones changing does.
#[derive(Debug, Clone)]
pub struct LibraryDigest {
    track_ids: HashSet<i64>,
    hash: u64,
}

impl LibraryDigest {
    pub fn of(items: &[Item], known: &HashMap<Vec<String>, Known>) -> Self {
        let track_ids = items
            .iter()
            .map(|i| i.track_id)
            .chain(known.values().map(|k| k.track_id))
            .collect();
        let hash = Self::hash(items, known, &track_ids);
        Self { track_ids, hash }
    }

    pub fn still_matches(&self, items: &[Item], known: &HashMap<Vec<String>, Known>) -> bool {
        Self::hash(items, known, &self.track_ids) == self.hash
    }

    fn hash(items: &[Item], known: &HashMap<Vec<String>, Known>, track_ids: &HashSet<i64>) -> u64 {
        let mut hasher = DefaultHasher::new();
        let mut planned_items: Vec<&Item> = items
            .iter()
            .filter(|i| track_ids.contains(&i.track_id))
            .collect();
        planned_items.sort_by(|a, b| a.rel.cmp(&b.rel));
        for item in planned_items {
            (
                item.track_id,
                &item.rel,
                item.size,
                item.modified,
                &item.identity,
            )
                .hash(&mut hasher);
        }
        let mut planned_known: Vec<(&Vec<String>, &Known)> = known
            .iter()
            .filter(|(_, k)| k.streamed || track_ids.contains(&k.track_id))
            .collect();
        planned_known.sort_by(|a, b| a.0.cmp(b.0));
        for (rel, k) in planned_known {
            (rel, k.track_id, k.missing, k.in_grace, k.streamed).hash(&mut hasher);
        }
        hasher.finish()
    }
}

/// How much of a destination a background read looks at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ReadDepth {
    /// Lists the destination and keeps the last plan when neither its files nor the library
    /// changed since; reads in full otherwise. Costs one listing instead of comparing every file.
    Quick,
    /// Compares every file again.
    Full,
}

/// A hash of what a full read compared: the destination's listing (paths, sizes and change
/// markers) and the library inputs. Equal stamps mean the same plan would come out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadStamp {
    listing: u64,
    library: u64,
}

impl ReadStamp {
    /// `None` when the destination does not say when a file changed, so an edit that kept the
    /// size could not be told apart.
    pub fn of(listing: &[Remote], library: LibraryHash) -> Option<Self> {
        let mut files: Vec<&Remote> = listing.iter().collect();
        files.sort_by(|a, b| a.rel.cmp(&b.rel));
        let mut hasher = DefaultHasher::new();
        for file in files {
            (&file.rel, file.size, file.version.as_ref()?).hash(&mut hasher);
        }
        Some(Self {
            listing: hasher.finish(),
            library: library.0,
        })
    }
}

/// A hash of everything in the library that a read of one destination depends on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LibraryHash(u64);

impl LibraryHash {
    /// `library` is the digest of every track; `synced_at` and `bases` are this destination's;
    /// `present` is the `(path, size)` of every track on disk, which the pull list uses.
    pub fn of(
        library: &LibraryDigest,
        synced_at: &HashMap<i64, i64>,
        bases: &HashMap<i64, crate::db::Base>,
        present: &[(String, i64)],
    ) -> Self {
        let mut hasher = DefaultHasher::new();
        library.hash.hash(&mut hasher);
        let mut synced: Vec<(&i64, &i64)> = synced_at.iter().collect();
        synced.sort_unstable();
        synced.hash(&mut hasher);
        let mut bases: Vec<(&i64, &crate::db::Base)> = bases.iter().collect();
        bases.sort_unstable_by_key(|(id, _)| **id);
        for (id, base) in bases {
            (id, &base.local_sig, &base.remote_sig, &base.tags).hash(&mut hasher);
        }
        let mut present: Vec<&(String, i64)> = present.iter().collect();
        present.sort_unstable();
        present.hash(&mut hasher);
        Self(hasher.finish())
    }
}

/// An audio file on a destination that the library does not have.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingFile {
    #[serde(flatten)]
    pub file: Remote,
    /// Extension of a library track with the same name but another format (e.g. `flac`).
    pub other_format: Option<String>,
}

/// The pull side of one read: what the destination holds that the library lacks.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullScan {
    /// Every file found on the destination, audio or not.
    pub total: usize,
    pub missing: Vec<MissingFile>,
    /// Set when the destination could not be listed; `missing` is then empty.
    pub error: Option<String>,
}

impl PullScan {
    pub fn failed(error: String) -> Self {
        Self {
            total: 0,
            missing: Vec::new(),
            error: Some(error),
        }
    }
}

/// One read of one destination: its push plan and its pull list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetScan {
    pub target_id: TargetId,
    pub plan_id: PlanId,
    pub scanned_at: UnixSeconds,
    pub plan: TargetPlan,
    pub pull: PullScan,
}

/// A read's counts, for the sidebar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub target_id: TargetId,
    pub plan_id: PlanId,
    pub scanned_at: UnixSeconds,
    /// The push could not be planned, or the destination could not be read.
    pub error: Option<String>,
    /// Songs the library lacks plus files edited on the destination.
    pub to_pull: usize,
    /// Uploads, replaces, moves and deletes.
    pub to_push: usize,
}

impl ScanSummary {
    /// The counts of a read, without the destination-only files `ignored` hides.
    fn of(scan: &TargetScan, ignored: &IgnoreList) -> Self {
        let (missing, actions) = ignored.counts(scan);
        let incoming = scan
            .plan
            .actions
            .iter()
            .filter(|a| matches!(a.kind, Kind::Update | Kind::Merge | Kind::Conflict))
            .count();
        Self {
            target_id: scan.target_id,
            plan_id: scan.plan_id.clone(),
            scanned_at: scan.scanned_at,
            error: scan.plan.error.clone().or_else(|| scan.pull.error.clone()),
            to_pull: missing + incoming,
            to_push: actions - incoming,
        }
    }
}

/// What the background reads have found and what they are doing now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub scans: Vec<ScanSummary>,
    pub queued: Vec<TargetId>,
    pub scanning: Option<TargetId>,
}

/// A plan that can be applied while it is fresh and its library has not changed.
#[derive(Debug, Clone)]
pub struct StoredPlan {
    pub id: PlanId,
    pub target_id: TargetId,
    pub scanned_at: UnixSeconds,
    pub library: LibraryDigest,
    pub plan: TargetPlan,
}

/// The destinations waiting to be read, the latest read of each, and the plans still applicable.
#[derive(Debug, Default)]
pub struct ScanStore {
    latest: HashMap<TargetId, TargetScan>,
    plans: HashMap<PlanId, StoredPlan>,
    /// What the latest read of each destination compared, for [`ReadDepth::Quick`] reads.
    stamps: HashMap<TargetId, ReadStamp>,
    queue: VecDeque<(TargetId, ReadDepth)>,
    scanning: Option<TargetId>,
    reads: u64,
}

impl ScanStore {
    /// Queues destinations to be read. `urgent` ones go to the front, e.g. after the user pressed
    /// Refresh. One already queued is not queued twice but keeps the deeper of both reads; one
    /// being read now is read again after.
    pub fn enqueue(&mut self, ids: &[TargetId], urgent: bool, depth: ReadDepth) {
        for &id in ids {
            let queued = self.queue.iter().position(|&(q, _)| q == id);
            let depth = queued.map_or(depth, |at| depth.max(self.queue[at].1));
            match queued {
                Some(at) if !urgent => self.queue[at].1 = depth,
                Some(at) => {
                    self.queue.remove(at);
                    self.queue.push_front((id, depth));
                }
                None if urgent => self.queue.push_front((id, depth)),
                None => self.queue.push_back((id, depth)),
            }
        }
    }

    /// Takes the next destination to read and marks it as being read.
    pub fn start_next(&mut self) -> Option<(TargetId, ReadDepth)> {
        let next = self.queue.pop_front()?;
        self.scanning = Some(next.0);
        Some(next)
    }

    /// Ends a [`ReadDepth::Quick`] read when the destination and library match the latest read,
    /// whose plan then counts as read now. `false` when it needs a full read.
    pub fn confirm(&mut self, id: TargetId, stamp: ReadStamp, now: UnixSeconds) -> bool {
        let reading = self.scanning == Some(id);
        let unchanged = self.stamps.get(&id) == Some(&stamp);
        let Some(latest) = self.latest.get_mut(&id) else {
            return false;
        };
        let Some(plan) = self.plans.get_mut(&latest.plan_id) else {
            return false;
        };
        if !reading || !unchanged {
            return false;
        }
        latest.scanned_at = now;
        plan.scanned_at = now;
        self.scanning = None;
        true
    }

    /// A name for the read that is about to be stored.
    pub fn new_plan_id(&mut self, now: UnixSeconds) -> PlanId {
        self.reads += 1;
        PlanId(format!("{now}-{}", self.reads))
    }

    /// Stores a finished read, unless its destination was removed while it was being read.
    /// Without a `stamp` the next read of the destination is a full one.
    pub fn finish(
        &mut self,
        scan: TargetScan,
        stored: StoredPlan,
        stamp: Option<ReadStamp>,
        now: UnixSeconds,
    ) {
        if self.scanning == Some(scan.target_id) {
            match stamp {
                Some(stamp) => self.stamps.insert(scan.target_id, stamp),
                None => self.stamps.remove(&scan.target_id),
            };
            self.plans.insert(stored.id.clone(), stored);
            self.latest.insert(scan.target_id, scan);
        }
        self.scanning = None;
        self.prune(now);
    }

    /// Ends a read that produced nothing to keep (its destination is gone).
    pub fn abandon(&mut self) {
        self.scanning = None;
    }

    /// Drops everything about a removed destination.
    pub fn forget(&mut self, id: TargetId) {
        self.latest.remove(&id);
        self.stamps.remove(&id);
        self.plans.retain(|_, p| p.target_id != id);
        self.queue.retain(|&(q, _)| q != id);
        if self.scanning == Some(id) {
            self.scanning = None;
        }
    }

    pub fn latest(&self, id: TargetId) -> Option<&TargetScan> {
        self.latest.get(&id)
    }

    /// What every latest read comes to, counted without the files `ignores` hides.
    pub fn status(&self, ignores: &Ignores) -> ScanStatus {
        let none = IgnoreList::default();
        let mut scans: Vec<ScanSummary> = self
            .latest
            .values()
            .map(|scan| ScanSummary::of(scan, ignores.get(&scan.target_id).unwrap_or(&none)))
            .collect();
        scans.sort_by_key(|s| s.target_id);
        ScanStatus {
            scans,
            queued: self.queue.iter().map(|&(id, _)| id).collect(),
            scanning: self.scanning,
        }
    }

    /// Hands out the plans a review is applying, all or none: one that is unknown or older than
    /// [`MAX_PLAN_AGE_SECS`] refuses the whole review. Applying changes the destinations, so every
    /// other plan and the latest read of each of them go too, until they are read again.
    pub fn take(&mut self, ids: &[PlanId], now: UnixSeconds) -> Result<Vec<StoredPlan>, Error> {
        let fresh = ids.iter().all(|id| {
            self.plans
                .get(id)
                .is_some_and(|p| now - p.scanned_at <= MAX_PLAN_AGE_SECS)
        });
        let unique = ids.iter().collect::<HashSet<_>>().len() == ids.len();
        if ids.is_empty() || !fresh || !unique {
            return Err(Error::Msg(OUT_OF_DATE.to_owned()));
        }
        let taken: Vec<StoredPlan> = ids.iter().filter_map(|id| self.plans.remove(id)).collect();
        let changed: HashSet<TargetId> = taken.iter().map(|p| p.target_id).collect();
        self.plans.retain(|_, p| !changed.contains(&p.target_id));
        self.latest.retain(|id, _| !changed.contains(id));
        self.stamps.retain(|id, _| !changed.contains(id));
        Ok(taken)
    }

    /// Drops expired plans and keeps the newest few per destination.
    fn prune(&mut self, now: UnixSeconds) {
        self.plans
            .retain(|_, p| now - p.scanned_at <= MAX_PLAN_AGE_SECS);
        let mut by_target: HashMap<TargetId, Vec<(UnixSeconds, PlanId)>> = HashMap::new();
        for p in self.plans.values() {
            by_target
                .entry(p.target_id)
                .or_default()
                .push((p.scanned_at, p.id.clone()));
        }
        for mut kept in by_target.into_values() {
            kept.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.0.cmp(&a.1.0)));
            for (_, id) in kept.into_iter().skip(PLANS_KEPT_PER_TARGET) {
                self.plans.remove(&id);
            }
        }
    }
}

/// Library lookups for [`missing_files`]: lower-cased paths, `(file name, size)` pairs, and
/// file name without extension -> extension.
pub struct KnownLibrary {
    paths: HashSet<String>,
    files: HashSet<(String, i64)>,
    stems: HashMap<String, String>,
}

impl KnownLibrary {
    /// Built from `(path, size)` of every present track.
    pub fn of(rows: &[(String, i64)]) -> Self {
        let paths = rows.iter().map(|(p, _)| p.to_lowercase()).collect();
        let files = rows
            .iter()
            .filter_map(|(p, size)| {
                let name = Path::new(p).file_name()?.to_str()?.to_lowercase();
                Some((name, *size))
            })
            .collect();
        let stems = rows
            .iter()
            .filter_map(|(p, _)| {
                let p = Path::new(p);
                let stem = p.file_stem()?.to_str()?.to_lowercase();
                let ext = p.extension()?.to_str()?.to_lowercase();
                Some((stem, ext))
            })
            .collect();
        Self {
            paths,
            files,
            stems,
        }
    }
}

fn local_path(root: &Path, rel: &[String]) -> PathBuf {
    rel.iter().fold(root.to_path_buf(), |p, s| p.join(s))
}

/// Audio files on the destination the library is missing. A library file counts as a match by
/// path (any letter case) or by file name plus size, so tracks that were organised into
/// different folders locally are not offered again.
pub fn missing_files(remote: &[Remote], root: &Path, known: &KnownLibrary) -> Vec<MissingFile> {
    remote
        .iter()
        .filter(|r| {
            let name = r.rel.last().map_or("", String::as_str);
            if name.starts_with('.') || !scan::is_audio(Path::new(name)) {
                return false;
            }
            let path = local_path(root, &r.rel);
            let size = i64::try_from(r.size).unwrap_or(i64::MAX);
            !path.exists()
                && path
                    .to_str()
                    .is_none_or(|p| !known.paths.contains(&p.to_lowercase()))
                && !known.files.contains(&(name.to_lowercase(), size))
        })
        .map(|file| {
            let p = Path::new(file.rel.last().map_or("", String::as_str));
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
            let other_format = known
                .stems
                .get(&stem.to_lowercase())
                .filter(|e| !e.eq_ignore_ascii_case(ext))
                .cloned();
            MissingFile {
                file: file.clone(),
                other_format,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(track_id: i64, rel: &str, size: u64) -> Item {
        Item {
            track_id,
            local: PathBuf::from(rel),
            rel: rel.split('/').map(str::to_owned).collect(),
            size,
            identity: None,
            modified: 0,
        }
    }

    fn plan(target_id: TargetId) -> TargetPlan {
        let target = crate::db::SyncTarget {
            id: target_id,
            tailnet: "tailnet".to_owned(),
            machine: "machine".to_owned(),
            path: Vec::new(),
            synced_tracks: 0,
            libsync: false,
            library_name: None,
        };
        TargetPlan::failed(&target, String::new())
    }

    fn stored(store: &mut ScanStore, target_id: TargetId, at: UnixSeconds) -> PlanId {
        let id = store.new_plan_id(at);
        store.enqueue(&[target_id], true, ReadDepth::Full);
        store.start_next();
        let scan = TargetScan {
            target_id,
            plan_id: id.clone(),
            scanned_at: at,
            plan: plan(target_id),
            pull: PullScan::failed(String::new()),
        };
        let kept = StoredPlan {
            id: id.clone(),
            target_id,
            scanned_at: at,
            library: LibraryDigest::of(&[], &HashMap::new()),
            plan: plan(target_id),
        };
        store.finish(scan, kept, Some(stamp(1, 1)), at);
        id
    }

    fn stamp(listing: u64, library: u64) -> ReadStamp {
        ReadStamp { listing, library }
    }

    fn remote(rel: &str, size: u64, version: Option<&str>) -> Remote {
        Remote {
            rel: rel.split('/').map(str::to_owned).collect(),
            size,
            version: version.map(str::to_owned),
        }
    }

    #[test]
    fn digest_ignores_tracks_added_after_the_plan() {
        let before = vec![item(1, "a/one.mp3", 10)];
        let digest = LibraryDigest::of(&before, &HashMap::new());
        let after = vec![item(1, "a/one.mp3", 10), item(2, "b/pulled.mp3", 20)];
        assert!(digest.still_matches(&after, &HashMap::new()));
    }

    struct DigestCase {
        name: &'static str,
        after: Vec<Item>,
    }

    #[test]
    fn digest_notices_planned_tracks_changing() {
        let before = vec![item(1, "a/one.mp3", 10), item(2, "a/two.mp3", 20)];
        let digest = LibraryDigest::of(&before, &HashMap::new());
        let cases = [
            DigestCase {
                name: "resized",
                after: vec![item(1, "a/one.mp3", 11), item(2, "a/two.mp3", 20)],
            },
            DigestCase {
                name: "moved",
                after: vec![item(1, "b/one.mp3", 10), item(2, "a/two.mp3", 20)],
            },
            DigestCase {
                name: "gone",
                after: vec![item(2, "a/two.mp3", 20)],
            },
            DigestCase {
                name: "touched",
                after: vec![
                    Item {
                        modified: 5,
                        ..item(1, "a/one.mp3", 10)
                    },
                    item(2, "a/two.mp3", 20),
                ],
            },
        ];
        for case in cases {
            assert!(
                !digest.still_matches(&case.after, &HashMap::new()),
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn digest_notices_a_missing_track_returning() {
        let known = HashMap::from([(
            vec!["a".to_owned(), "one.mp3".to_owned()],
            Known {
                track_id: 1,
                missing: true,
                in_grace: true,
                streamed: false,
            },
        )]);
        let digest = LibraryDigest::of(&[], &known);
        assert!(!digest.still_matches(&[item(1, "a/one.mp3", 10)], &known));
    }

    #[test]
    fn take_uses_up_plans() {
        let mut store = ScanStore::default();
        let id = stored(&mut store, 1, 100);
        assert_eq!(
            store
                .take(std::slice::from_ref(&id), 100)
                .map(|p| p.len())
                .ok(),
            Some(1)
        );
        assert!(store.take(&[id], 100).is_err());
    }

    #[test]
    fn take_refuses_old_plans() {
        let mut store = ScanStore::default();
        let id = stored(&mut store, 1, 100);
        assert!(
            store
                .take(std::slice::from_ref(&id), 100 + MAX_PLAN_AGE_SECS + 1)
                .is_err()
        );
        // A refused review uses nothing up.
        assert!(store.take(&[id], 100 + MAX_PLAN_AGE_SECS).is_ok());
    }

    struct TakeCase {
        name: &'static str,
        ids: fn(&PlanId, &PlanId) -> Vec<PlanId>,
    }

    #[test]
    fn take_is_all_or_nothing() {
        let cases = [
            TakeCase {
                name: "unknown id",
                ids: |a, _| vec![a.clone(), PlanId("nope".to_owned())],
            },
            TakeCase {
                name: "repeated id",
                ids: |a, _| vec![a.clone(), a.clone()],
            },
            TakeCase {
                name: "no ids",
                ids: |_, _| Vec::new(),
            },
        ];
        for case in cases {
            let mut store = ScanStore::default();
            let a = stored(&mut store, 1, 100);
            let b = stored(&mut store, 2, 100);
            assert!(
                store.take(&(case.ids)(&a, &b), 100).is_err(),
                "{}",
                case.name
            );
            assert!(store.take(&[a, b], 100).is_ok(), "{}", case.name);
        }
    }

    #[test]
    fn an_older_plan_stays_applicable_after_a_newer_read() {
        let mut store = ScanStore::default();
        let first = stored(&mut store, 1, 100);
        let second = stored(&mut store, 1, 110);
        assert_eq!(store.latest(1).map(|s| s.plan_id.clone()), Some(second));
        assert!(store.take(&[first], 120).is_ok());
    }

    #[test]
    fn applying_drops_every_read_of_that_target_only() {
        let mut store = ScanStore::default();
        let first = stored(&mut store, 1, 100);
        let second = stored(&mut store, 1, 110);
        let other = stored(&mut store, 2, 110);
        assert!(store.take(&[first], 120).is_ok());
        assert!(store.latest(1).is_none());
        assert!(store.take(std::slice::from_ref(&second), 120).is_err());
        assert!(store.latest(2).is_some());
        assert!(store.take(&[other], 120).is_ok());
    }

    #[test]
    fn only_a_few_plans_are_kept_per_target() {
        let mut store = ScanStore::default();
        let oldest = stored(&mut store, 1, 100);
        for at in 101..=100 + i64::try_from(PLANS_KEPT_PER_TARGET).unwrap_or(0) {
            stored(&mut store, 1, at);
        }
        assert!(store.take(&[oldest], 110).is_err());
    }

    #[test]
    fn forgetting_a_target_drops_its_plans_and_a_read_in_progress() {
        let mut store = ScanStore::default();
        let id = stored(&mut store, 1, 100);
        store.enqueue(&[1], false, ReadDepth::Full);
        store.start_next();
        store.forget(1);
        assert!(store.latest(1).is_none());
        assert!(store.take(&[id], 100).is_err());
        assert_eq!(store.status(&Ignores::default()).scanning, None);
    }

    #[test]
    fn enqueue_does_not_repeat_and_urgent_goes_first() {
        let mut store = ScanStore::default();
        store.enqueue(&[1, 2, 3], false, ReadDepth::Quick);
        store.enqueue(&[2], false, ReadDepth::Quick);
        store.enqueue(&[3], true, ReadDepth::Quick);
        assert_eq!(store.status(&Ignores::default()).queued, vec![3, 1, 2]);
    }

    #[test]
    fn a_queued_read_keeps_the_deeper_depth() {
        let mut store = ScanStore::default();
        store.enqueue(&[1], false, ReadDepth::Full);
        store.enqueue(&[1], true, ReadDepth::Quick);
        store.enqueue(&[2], false, ReadDepth::Quick);
        store.enqueue(&[2], false, ReadDepth::Full);
        assert_eq!(store.start_next(), Some((1, ReadDepth::Full)));
        assert_eq!(store.start_next(), Some((2, ReadDepth::Full)));
    }

    struct ConfirmCase {
        name: &'static str,
        stamp: ReadStamp,
        applied_since: bool,
        kept: bool,
    }

    #[test]
    fn a_quick_read_keeps_the_plan_only_when_nothing_changed() {
        let cases = [
            ConfirmCase {
                name: "unchanged",
                stamp: stamp(1, 1),
                applied_since: false,
                kept: true,
            },
            ConfirmCase {
                name: "destination changed",
                stamp: stamp(2, 1),
                applied_since: false,
                kept: false,
            },
            ConfirmCase {
                name: "library changed",
                stamp: stamp(1, 2),
                applied_since: false,
                kept: false,
            },
            ConfirmCase {
                name: "plan applied since",
                stamp: stamp(1, 1),
                applied_since: true,
                kept: false,
            },
        ];
        for case in cases {
            let mut store = ScanStore::default();
            let id = stored(&mut store, 1, 100);
            if case.applied_since {
                assert!(
                    store.take(std::slice::from_ref(&id), 100).is_ok(),
                    "{}",
                    case.name
                );
            }
            store.enqueue(&[1], false, ReadDepth::Quick);
            store.start_next();
            let now = 100 + MAX_PLAN_AGE_SECS;
            assert_eq!(
                store.confirm(1, case.stamp, now),
                case.kept,
                "{}",
                case.name
            );
            if case.kept {
                assert_eq!(
                    store.latest(1).map(|s| s.scanned_at),
                    Some(now),
                    "{}",
                    case.name
                );
                assert_eq!(
                    store.status(&Ignores::default()).scanning,
                    None,
                    "{}",
                    case.name
                );
                // Still applicable after the original read would have expired.
                assert!(store.take(&[id], now + 1).is_ok(), "{}", case.name);
            } else {
                assert_eq!(
                    store.status(&Ignores::default()).scanning,
                    Some(1),
                    "{}",
                    case.name
                );
            }
        }
    }

    #[test]
    fn a_read_without_a_stamp_is_read_in_full_next_time() {
        let mut store = ScanStore::default();
        stored(&mut store, 1, 100);
        store.enqueue(&[1], false, ReadDepth::Quick);
        store.start_next();
        let id = store.new_plan_id(110);
        let scan = TargetScan {
            target_id: 1,
            plan_id: id.clone(),
            scanned_at: 110,
            plan: plan(1),
            pull: PullScan::failed(String::new()),
        };
        let kept = StoredPlan {
            id,
            target_id: 1,
            scanned_at: 110,
            library: LibraryDigest::of(&[], &HashMap::new()),
            plan: plan(1),
        };
        store.finish(scan, kept, None, 110);
        store.enqueue(&[1], false, ReadDepth::Quick);
        store.start_next();
        assert!(!store.confirm(1, stamp(1, 1), 120));
    }

    struct StampCase {
        name: &'static str,
        listing: Vec<Remote>,
        same: bool,
    }

    #[test]
    fn the_listing_stamp_notices_any_file_changing() {
        let before = vec![
            remote("a/one.mp3", 10, Some("1")),
            remote("b/two.mp3", 20, Some("2")),
        ];
        let cases = [
            StampCase {
                name: "same files in another order",
                listing: vec![
                    remote("b/two.mp3", 20, Some("2")),
                    remote("a/one.mp3", 10, Some("1")),
                ],
                same: true,
            },
            StampCase {
                name: "edited, same size",
                listing: vec![
                    remote("a/one.mp3", 10, Some("9")),
                    remote("b/two.mp3", 20, Some("2")),
                ],
                same: false,
            },
            StampCase {
                name: "resized",
                listing: vec![
                    remote("a/one.mp3", 11, Some("1")),
                    remote("b/two.mp3", 20, Some("2")),
                ],
                same: false,
            },
            StampCase {
                name: "renamed",
                listing: vec![
                    remote("a/uno.mp3", 10, Some("1")),
                    remote("b/two.mp3", 20, Some("2")),
                ],
                same: false,
            },
            StampCase {
                name: "deleted",
                listing: vec![remote("b/two.mp3", 20, Some("2"))],
                same: false,
            },
        ];
        let library = LibraryHash(7);
        let original = ReadStamp::of(&before, library);
        assert!(original.is_some());
        for case in cases {
            let now = ReadStamp::of(&case.listing, library);
            assert_eq!(now == original, case.same, "{}", case.name);
        }
    }

    #[test]
    fn no_stamp_when_the_destination_does_not_say_what_changed() {
        let listing = vec![
            remote("a/one.mp3", 10, Some("1")),
            remote("b/two.mp3", 20, None),
        ];
        assert!(ReadStamp::of(&listing, LibraryHash(7)).is_none());
    }

    #[test]
    fn summary_splits_pull_and_push() {
        let mut store = ScanStore::default();
        stored(&mut store, 1, 100);
        let summary = &store.status(&Ignores::default()).scans[0];
        assert_eq!((summary.to_pull, summary.to_push), (0, 0));
    }
}
