//! Tag lookup: finds a song in an online music database from the tags it already has, and
//! offers the tags the database holds for it. It runs only for the songs the user picks, and
//! only once the `lookup` service is switched on. The title and the first artist are all that
//! is sent; the album and the length stay here and rank what comes back.

pub mod discogs;
pub mod musicbrainz;

use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use lofty::file::{AudioFile, TaggedFileExt};
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

use crate::db;
use crate::error::Error;
use crate::tags::{self, Change, SEPARATOR};

/// The service switch that allows lookups. Off until the user turns it on, because a lookup
/// tells an outside service which songs are in the library.
pub const SERVICE: &str = "lookup";

pub type Milliseconds = u64;

/// How alike two things are, from 0 (nothing in common) to 1000 (the same).
type Permille = usize;
const SAME: Permille = 1000;

/// An answer is asked for again after this long, so corrections made at the source arrive.
const FRESH_FOR_SECONDS: i64 = 30 * 24 * 60 * 60;

/// The most candidates shown for one song.
const MAX_CANDIDATES: usize = 5;

/// An identifier `MusicBrainz` gives out, which is a UUID. It is checked on the way in because
/// it is later put into request addresses.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(try_from = "String", into = "String")]
pub struct Mbid(String);

impl Mbid {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Mbid {
    type Error = String;

    fn try_from(raw: String) -> Result<Self, Self::Error> {
        uuid::Uuid::parse_str(raw.trim())
            .map(|id| Self(id.hyphenated().to_string()))
            .map_err(|_| not_an_identifier(&raw))
    }
}

impl From<Mbid> for String {
    fn from(id: Mbid) -> Self {
        id.0
    }
}

/// The number Discogs gives a release.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DiscogsRelease(pub u64);

/// What starts an identifier Discogs gave out, where it is written as text.
const DISCOGS_PREFIX: &str = "discogs-";

fn not_an_identifier(raw: &str) -> String {
    format!("{raw:?} is not an identifier")
}

/// A number written in digits alone: no sign, no spaces.
fn digits<T: std::str::FromStr>(text: &str) -> Option<T> {
    (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// One release (an album, single or compilation) a recording appears on, in the source that
/// knows it. As text it is the UUID for `MusicBrainz` and `discogs-<number>` for Discogs.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(try_from = "String", into = "String")]
pub enum ReleaseId {
    MusicBrainz(Mbid),
    Discogs(DiscogsRelease),
}

impl TryFrom<String> for ReleaseId {
    type Error = String;

    fn try_from(raw: String) -> Result<Self, Self::Error> {
        match raw.strip_prefix(DISCOGS_PREFIX) {
            Some(number) => digits(number)
                .map(|number| Self::Discogs(DiscogsRelease(number)))
                .ok_or_else(|| not_an_identifier(&raw)),
            None => Mbid::try_from(raw).map(Self::MusicBrainz),
        }
    }
}

impl fmt::Display for ReleaseId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MusicBrainz(id) => f.write_str(id.as_str()),
            Self::Discogs(release) => write!(f, "{DISCOGS_PREFIX}{}", release.0),
        }
    }
}

impl From<ReleaseId> for String {
    fn from(id: ReleaseId) -> Self {
        id.to_string()
    }
}

/// One recording of a song, in the source that knows it. Discogs lists songs only as the
/// tracks of a release, so there it is the release and the track's place in its list, written
/// `discogs-<release>-<place>`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(try_from = "String", into = "String")]
pub enum RecordingId {
    MusicBrainz(Mbid),
    Discogs { release: DiscogsRelease, track: u32 },
}

impl TryFrom<String> for RecordingId {
    type Error = String;

    fn try_from(raw: String) -> Result<Self, Self::Error> {
        match raw.strip_prefix(DISCOGS_PREFIX) {
            Some(rest) => rest
                .split_once('-')
                .and_then(|(release, track)| {
                    Some(Self::Discogs {
                        release: DiscogsRelease(digits(release)?),
                        track: digits(track)?,
                    })
                })
                .ok_or_else(|| not_an_identifier(&raw)),
            None => Mbid::try_from(raw).map(Self::MusicBrainz),
        }
    }
}

impl fmt::Display for RecordingId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MusicBrainz(id) => f.write_str(id.as_str()),
            Self::Discogs { release, track } => {
                write!(f, "{DISCOGS_PREFIX}{}-{track}", release.0)
            }
        }
    }
}

impl From<RecordingId> for String {
    fn from(id: RecordingId) -> Self {
        id.to_string()
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(transparent)]
pub struct Year(pub u16);

impl Year {
    /// The year a date starts with: `1997`, `1997-03` and `1997-03-17` all give 1997.
    pub fn from_date(date: &str) -> Option<Self> {
        let year = date.trim().get(..4)?;
        year.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| year.parse().ok().map(Self))
            .flatten()
    }
}

/// How sure a match is, from 0 to 100.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(transparent)]
pub struct Confidence(u8);

impl Confidence {
    /// From here up a match is offered ready to apply.
    const LIKELY: Self = Self(85);
    /// Below this a result is a different song and is not shown.
    const LOWEST_SHOWN: Self = Self(50);

    fn of(title: Permille, artist: Permille, duration: Permille) -> Self {
        let weighed = title * 45 + artist * 30 + duration * 25;
        Self(u8::try_from(weighed / SAME).unwrap_or(100).min(100))
    }
}

/// A song as a music database knows it, with the releases it appears on.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub recording: RecordingId,
    pub title: String,
    pub artists: Vec<String>,
    pub duration_ms: Option<Milliseconds>,
    pub first_released: Option<Year>,
    pub isrc: Option<String>,
    pub releases: Vec<Release>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub id: ReleaseId,
    pub title: String,
    pub album_artists: Vec<String>,
    /// Put out by the artist or label, as opposed to a bootleg or a promo.
    pub official: bool,
    pub compilation: bool,
    pub year: Option<Year>,
    /// The song's number on this release, when it is a plain number.
    pub track: Option<u32>,
    pub track_total: Option<u32>,
    /// Where it came out, as a country code, and on what (CD, Vinyl, Digital Media): what tells
    /// two pressings of one album apart.
    pub country: Option<String>,
    pub format: Option<String>,
    /// The source says this release has a cover picture; otherwise that is only known on
    /// asking for it.
    #[serde(default)]
    pub pictured: bool,
}

/// What a release's own page adds to what a search already says about it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct ReleaseDetails {
    pub label: Option<String>,
    /// The styles of music on it, most telling first; empty where the source keeps none.
    #[serde(default)]
    pub genres: Vec<String>,
    /// The release has a front cover that can be fetched.
    pub front_cover: bool,
}

/// How large a fetched cover is, by its longer side.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoverSize {
    /// Small: to show a match's cover before anything is written.
    Thumbnail,
    /// The largest the source has up to 1200 pixels: what is written into a song, once
    /// [`fit_cover`] has brought it down to size.
    Embedded,
}

/// The longer side of a cover written into a song, in pixels. Sharp on a large screen, and
/// small enough that older DJ players still show it.
pub const EMBEDDED_COVER_PIXELS: u32 = 800;

/// A fetched cover made ready to write into a song: scaled down to [`EMBEDDED_COVER_PIXELS`]
/// when it is larger, and otherwise left exactly as it came.
pub fn fit_cover(cover: Vec<u8>) -> Result<Vec<u8>, Error> {
    let picture = image::load_from_memory(&cover)
        .map_err(|e| Error::Msg(format!("that cover cannot be read: {e}")))?;
    if picture.width().max(picture.height()) <= EMBEDDED_COVER_PIXELS {
        return Ok(cover);
    }
    let smaller = picture.resize(
        EMBEDDED_COVER_PIXELS,
        EMBEDDED_COVER_PIXELS,
        image::imageops::FilterType::Lanczos3,
    );
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
        .encode_image(&smaller.to_rgb8())
        .map_err(|e| Error::Msg(format!("that cover cannot be resized: {e}")))?;
    Ok(jpeg)
}

/// Exactly what a search sends to the outside service.
#[derive(Debug, PartialEq, Eq)]
pub struct SearchTerms {
    pub title: String,
    pub artist: String,
}

impl SearchTerms {
    fn cache_key(&self) -> String {
        format!(
            "recording:{}\u{1f}{}",
            words(&self.artist).join(" "),
            words(&self.title).join(" ")
        )
    }
}

/// Exactly what a search for an album's covers sends to the outside service.
#[derive(Debug, PartialEq, Eq)]
pub struct ReleaseTerms {
    pub album: String,
    pub artist: String,
}

impl ReleaseTerms {
    /// From a song's tags: its album, or its title when it has none (a single is released under
    /// its own name), by its album artist or else its first artist. `None` without those.
    pub fn from_tags(fields: &BTreeMap<String, String>) -> Option<Self> {
        let filled = |field: &str| {
            fields
                .get(field)
                .map(|v| v.trim())
                .filter(|v| !v.is_empty())
        };
        let album = filled("album").or_else(|| filled("title"))?;
        let artists = filled("albumArtist").or_else(|| filled("artist"))?;
        Some(Self {
            album: album.to_owned(),
            artist: tags::split_names(artists)
                .into_iter()
                .next()
                .unwrap_or_else(|| artists.to_owned()),
        })
    }

    fn cache_key(&self) -> String {
        format!(
            "releases:{}\u{1f}{}",
            words(&self.artist).join(" "),
            words(&self.album).join(" ")
        )
    }
}

/// A music database that can be searched for a song.
pub trait Source {
    /// Names this source's answers in the cache.
    const NAME: &'static str;

    async fn search(&self, terms: &SearchTerms) -> Result<Vec<Found>, Error>;
    /// The releases named like an album, to choose a cover from.
    async fn releases(&self, terms: &ReleaseTerms) -> Result<Vec<Release>, Error>;
    async fn release(&self, id: &ReleaseId) -> Result<ReleaseDetails, Error>;
    /// The image bytes of a release's front cover.
    async fn cover(&self, id: &ReleaseId, size: CoverSize) -> Result<Vec<u8>, Error>;
}

/// What a song's own tags say about it, to search with and to rank the answers against.
#[derive(Debug, PartialEq, Eq)]
pub struct Query {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_ms: Option<Milliseconds>,
}

impl Query {
    /// `None` when the song has no title or no artist: there is nothing to search with.
    pub fn from_tags(
        fields: &BTreeMap<String, String>,
        duration_ms: Option<Milliseconds>,
    ) -> Option<Self> {
        let filled = |field: &str| {
            fields
                .get(field)
                .map(|v| v.trim())
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        Some(Self {
            title: filled("title")?,
            artist: filled("artist")?,
            album: filled("album"),
            duration_ms,
        })
    }

    /// Stores' "(Original Mix)" is left off the title, since databases list that version under
    /// the plain title; of several artists only the first is sent, since any one of them finds
    /// the song.
    fn terms(&self) -> SearchTerms {
        SearchTerms {
            title: without_original_mix(&self.title).to_owned(),
            artist: tags::split_names(&self.artist)
                .into_iter()
                .next()
                .unwrap_or_else(|| self.artist.clone()),
        }
    }
}

/// `title` without a trailing "(Original Mix)", in any brackets or after a dash.
fn without_original_mix(title: &str) -> &str {
    let trimmed = title.trim();
    let lower = trimmed.to_lowercase();
    for ending in ["(original mix)", "[original mix]", "- original mix"] {
        if lower.ends_with(ending) && lower.len() == trimmed.len() {
            let kept = trimmed[..trimmed.len() - ending.len()].trim_end();
            if !kept.is_empty() {
                return kept;
            }
        }
    }
    trimmed
}

/// Words that join names without being part of one.
const JOINING_WORDS: [&str; 5] = ["feat", "ft", "featuring", "and", "vs"];

/// The words of `text` for comparing: no case, accents or punctuation, no joining words, and
/// no trailing "original mix".
fn words(text: &str) -> Vec<String> {
    let plain: String = text
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    let mut words: Vec<String> = plain
        .split_whitespace()
        .filter(|w| !JOINING_WORDS.contains(w))
        .map(str::to_owned)
        .collect();
    if words.len() > 2 && words.ends_with(&["original".to_owned(), "mix".to_owned()]) {
        words.truncate(words.len() - 2);
    }
    words
}

/// How many of the words two texts share, whatever their order.
fn shared_words(a: &[String], b: &[String]) -> Permille {
    let mut unmatched: Vec<&String> = b.iter().collect();
    let mut shared = 0;
    for word in a {
        if let Some(at) = unmatched.iter().position(|other| *other == word) {
            unmatched.swap_remove(at);
            shared += 1;
        }
    }
    2 * shared * SAME / (a.len() + b.len())
}

/// How few single-letter edits turn one text into the other (Levenshtein distance).
fn same_spelling(a: &str, b: &str) -> Permille {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (i, from) in a.iter().enumerate() {
        let mut row = vec![i + 1];
        for (j, to) in b.iter().enumerate() {
            let swap = previous[j] + usize::from(from != to);
            row.push(swap.min(previous[j + 1] + 1).min(row[j] + 1));
        }
        previous = row;
    }
    let longest = a.len().max(b.len());
    (longest - previous[b.len()]) * SAME / longest
}

/// Spelling only counts from here up: it is there to forgive a typo, and any two unrelated
/// names share a few letters.
const MISSPELLING_FROM: Permille = 700;

/// How alike two names are: by shared words, so word order and extra credits cost little, or
/// by spelling, so `Daftpunk` still finds `Daft Punk`; whichever says more.
fn similarity(a: &str, b: &str) -> Permille {
    let (a, b) = (words(a), words(b));
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    let spelling = Some(same_spelling(&a.join(" "), &b.join(" ")))
        .filter(|alike| *alike >= MISSPELLING_FROM)
        .unwrap_or(0);
    shared_words(&a, &b).max(spelling)
}

/// Encoders pad and trim a little, so lengths this close are the same recording.
const SAME_LENGTH_WITHIN: Milliseconds = 2_000;
/// From here on the lengths say it is another edit of the song.
const OTHER_EDIT_FROM: Milliseconds = 10_000;
/// When either length is unknown: neither for nor against.
const LENGTH_UNKNOWN: Permille = 600;

fn length_similarity(mine: Option<Milliseconds>, theirs: Option<Milliseconds>) -> Permille {
    let (Some(mine), Some(theirs)) = (mine, theirs) else {
        return LENGTH_UNKNOWN;
    };
    let apart = mine.abs_diff(theirs);
    if apart <= SAME_LENGTH_WITHIN {
        return SAME;
    }
    if apart >= OTHER_EDIT_FROM {
        return 0;
    }
    let span = OTHER_EDIT_FROM - SAME_LENGTH_WITHIN;
    usize::try_from((OTHER_EDIT_FROM - apart) * 1000 / span).unwrap_or(0)
}

/// The release to take album tags from: the one named most like the song's album, then an
/// official one, then one that is not a compilation, then the earliest.
fn best_release<'a>(album: Option<&str>, releases: &'a [Release]) -> Option<&'a Release> {
    releases.iter().max_by_key(|release| {
        (
            album.map_or(0, |album| similarity(album, &release.title)),
            release.official,
            !release.compilation,
            Reverse(release.year.map_or(u16::MAX, |year| year.0)),
        )
    })
}

/// One possible match for a song, with the tags it would give.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub recording: RecordingId,
    pub release: Option<ReleaseId>,
    pub confidence: Confidence,
    /// Sure enough, and ahead of every other candidate, to be offered ready to apply.
    pub likely: bool,
    /// Every tag this match knows, by tag editor field.
    pub fields: BTreeMap<String, String>,
    /// The tags that differ from the song's own. `from` is `None` where the song has none,
    /// which is what a fill-only apply writes.
    pub changes: Vec<Change>,
    /// The release whose front cover this match can give. Whether it would replace a cover the
    /// song has is for the review to show: see [`SongLookup::has_cover`].
    pub cover: Option<ReleaseId>,
}

impl Candidate {
    fn new(query: &Query, current: &BTreeMap<String, String>, found: &Found) -> Self {
        let release = best_release(query.album.as_deref(), &found.releases);
        let mut candidate = Self {
            recording: found.recording.clone(),
            release: release.map(|r| r.id.clone()),
            confidence: Confidence::of(
                similarity(&query.title, &found.title),
                similarity(&query.artist, &found.artists.join(" ")),
                length_similarity(query.duration_ms, found.duration_ms),
            ),
            likely: false,
            fields: BTreeMap::new(),
            changes: Vec::new(),
            cover: None,
        };
        let year = found.first_released.or(release.and_then(|r| r.year));
        let number = |n: Option<u32>| n.map(|n| n.to_string());
        let offers = [
            ("title", Some(found.title.clone())),
            ("artist", Some(found.artists.join(SEPARATOR))),
            ("album", release.map(|r| r.title.clone())),
            (
                "albumArtist",
                release.map(|r| r.album_artists.join(SEPARATOR)),
            ),
            ("year", year.map(|y| y.0.to_string())),
            ("track", number(release.and_then(|r| r.track))),
            ("trackTotal", number(release.and_then(|r| r.track_total))),
            ("isrc", found.isrc.clone()),
        ];
        for (field, value) in offers {
            if let Some(value) = value {
                candidate.offer(field, &value, current);
            }
        }
        candidate
    }

    /// Adds a tag this match knows; an empty value is not an offer.
    fn offer(&mut self, field: &str, value: &str, current: &BTreeMap<String, String>) {
        let value = value.trim();
        if value.is_empty() {
            return;
        }
        self.fields.insert(field.to_owned(), value.to_owned());
        let from = current.get(field);
        if from.map(String::as_str) != Some(value) {
            self.changes.push(Change {
                field: field.to_owned(),
                from: from.cloned(),
                to: Some(value.to_owned()),
            });
        }
    }
}

/// The tags that belong to one release of a song rather than to the song, so they are only
/// taken from another source when it means the same album.
const ALBUM_FIELDS: [&str; 6] = [
    "album",
    "albumArtist",
    "year",
    "track",
    "trackTotal",
    "label",
];
/// Two artist credits this alike name the same act: one source may list a guest the other
/// leaves out.
const SAME_ARTIST_FROM: Permille = 500;

impl Candidate {
    fn field(&self, field: &str) -> &str {
        self.fields.get(field).map_or("", String::as_str)
    }

    /// Both are the same song: the same title, by the same artist.
    fn same_song(&self, other: &Self) -> bool {
        similarity(self.field("title"), other.field("title")) == SAME
            && similarity(self.field("artist"), other.field("artist")) >= SAME_ARTIST_FROM
    }

    /// Takes from the same song in another source the tags this match lacks, and its cover if
    /// this has none. What this match already says stays.
    fn add(&mut self, other: Self, current: &BTreeMap<String, String>) {
        let same_album = !self.fields.contains_key("album")
            || similarity(self.field("album"), other.field("album")) >= SAME_ALBUM_FROM;
        for (field, value) in &other.fields {
            let wanted = same_album || !ALBUM_FIELDS.contains(&field.as_str());
            if wanted && !self.fields.contains_key(field) {
                self.offer(field, value, current);
            }
        }
        if self.cover.is_none() {
            self.cover = other.cover;
        }
    }
}

/// The matches worth showing for a song, surest first. Results that would give the same tags
/// are shown once.
fn rank(query: &Query, current: &BTreeMap<String, String>, found: &[Found]) -> Vec<Candidate> {
    settle(
        found
            .iter()
            .map(|found| Candidate::new(query, current, found))
            .filter(|candidate| candidate.confidence >= Confidence::LOWEST_SHOWN)
            .collect(),
    )
}

/// What two sources found for one song, as one list. A song both know is one match that says
/// more: the first source's tags, and from the second whatever the first lacks.
fn merge(
    mut first: Vec<Candidate>,
    second: Vec<Candidate>,
    current: &BTreeMap<String, String>,
) -> Vec<Candidate> {
    let known = first.len();
    let mut joined = vec![false; known];
    for extra in second {
        let same = (0..known).find(|at| !joined[*at] && first[*at].same_song(&extra));
        match same {
            Some(at) => {
                joined[at] = true;
                first[at].add(extra, current);
            }
            None => first.push(extra),
        }
    }
    settle(first)
}

/// Orders matches surest first, shows those that give the same tags once, keeps the most
/// that are shown, and marks the best as likely when it is.
fn settle(mut candidates: Vec<Candidate>) -> Vec<Candidate> {
    candidates.sort_by_key(|candidate| Reverse(candidate.confidence));
    let mut shown: Vec<Candidate> = Vec::new();
    for candidate in candidates {
        if shown.iter().all(|other| other.fields != candidate.fields) {
            shown.push(candidate);
        }
    }
    shown.truncate(MAX_CANDIDATES);
    // Two different answers that fit equally well are a choice for the user, not a match.
    let runner_up = shown.get(1).map(|second| second.confidence);
    for candidate in &mut shown {
        candidate.likely = false;
    }
    if let Some(best) = shown.first_mut() {
        best.likely = best.confidence >= Confidence::LIKELY && runner_up < Some(best.confidence);
    }
    shown
}

/// Answers kept in the library database, so a song looked up again costs no request.
pub struct Cache<'a> {
    db: &'a Mutex<Connection>,
    /// Unix time, to date new answers and to age old ones.
    now: i64,
}

impl<'a> Cache<'a> {
    pub fn new(db: &'a Mutex<Connection>, now: i64) -> Self {
        Self { db, now }
    }

    /// The saved answer, unless it has aged out or can no longer be read.
    fn get<T: DeserializeOwned>(&self, source: &str, key: &str) -> Result<Option<T>, Error> {
        let conn = self.db.lock().map_err(|_| Error::Lock)?;
        let Some((data, fetched_at)) = db::get_lookup_cache(&conn, source, key)? else {
            return Ok(None);
        };
        if self.now - fetched_at > FRESH_FOR_SECONDS {
            return Ok(None);
        }
        Ok(serde_json::from_str(&data).ok())
    }

    fn put<T: Serialize>(&self, source: &str, key: &str, answer: &T) -> Result<(), Error> {
        let data = serde_json::to_string(answer).map_err(|e| Error::Msg(e.to_string()))?;
        let conn = self.db.lock().map_err(|_| Error::Lock)?;
        db::put_lookup_cache(&conn, source, key, &data, self.now)
    }
}

/// The matches for one song. `song` is what the file holds now, to say what each match would
/// change; `refresh` asks the source again even when an answer is saved. The label and the
/// cover come from the release's own page, a second request, so only the best match gets them.
pub async fn candidates<S: Source>(
    source: &S,
    cache: &Cache<'_>,
    query: &Query,
    song: &Song,
    refresh: bool,
) -> Result<Vec<Candidate>, Error> {
    let current = &song.fields;
    let terms = query.terms();
    let key = terms.cache_key();
    let saved = if refresh {
        None
    } else {
        cache.get::<Vec<Found>>(S::NAME, &key)?
    };
    let found = if let Some(found) = saved {
        found
    } else {
        let found = source.search(&terms).await?;
        cache.put(S::NAME, &key, &found)?;
        found
    };
    let mut candidates = rank(query, current, &found);
    if let Some(best) = candidates.first_mut()
        && let Some(release) = best.release.clone()
    {
        let key = format!("release:{release}");
        let saved = if refresh {
            None
        } else {
            cache.get::<ReleaseDetails>(S::NAME, &key)?
        };
        let details = if let Some(details) = saved {
            details
        } else {
            let details = source.release(&release).await?;
            cache.put(S::NAME, &key, &details)?;
            details
        };
        if let Some(label) = details.label {
            best.offer("label", &label, current);
        }
        best.offer("genre", &details.genres.join(SEPARATOR), current);
        if details.front_cover {
            best.cover = Some(release);
        }
    }
    Ok(candidates)
}

/// The most releases offered to choose a cover from.
const MAX_COVER_OPTIONS: usize = 12;
/// A release named less like the album than this is another album.
const SAME_ALBUM_FROM: Permille = 600;

/// A release whose cover could be used. Whether it has one is only known on asking for it.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoverOption {
    pub release: ReleaseId,
    pub title: String,
    pub artist: String,
    pub year: Option<Year>,
    pub country: Option<String>,
    pub format: Option<String>,
}

/// What a cover search looked for and the releases it found.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoverSearch {
    pub album: String,
    pub artist: String,
    pub options: Vec<CoverOption>,
}

/// The releases a source has that are named like an album, from the cache when it holds them.
async fn releases_like<S: Source>(
    source: &S,
    cache: &Cache<'_>,
    terms: &ReleaseTerms,
    refresh: bool,
) -> Result<Vec<Release>, Error> {
    let key = terms.cache_key();
    if !refresh && let Some(saved) = cache.get::<Vec<Release>>(S::NAME, &key)? {
        return Ok(saved);
    }
    let releases = source.releases(terms).await?;
    cache.put(S::NAME, &key, &releases)?;
    Ok(releases)
}

/// What two sources answered, as one list. One source failing does not lose what the other
/// found; when neither found anything and one failed, that failure is the answer.
fn either<T>(first: Result<Vec<T>, Error>, second: Option<Result<Vec<T>, Error>>) -> Answers<T> {
    match (first, second) {
        (Ok(first), None) => Ok((first, Vec::new())),
        (Ok(first), Some(Ok(second))) => Ok((first, second)),
        (Ok(first), Some(Err(e))) => {
            if first.is_empty() {
                Err(e)
            } else {
                Ok((first, Vec::new()))
            }
        }
        (Err(e), Some(Ok(second))) => {
            if second.is_empty() {
                Err(e)
            } else {
                Ok((Vec::new(), second))
            }
        }
        (Err(e), None | Some(Err(_))) => Err(e),
    }
}

/// What the first and the second source found.
type Answers<T> = Result<(Vec<T>, Vec<T>), Error>;

/// The releases to choose a cover from, in every source given: those named like the album,
/// ones known to have a picture first, then official ones, then the earliest, since the first
/// pressing is most often the cover people know.
pub async fn cover_search<A: Source, B: Source>(
    first: &A,
    second: Option<&B>,
    cache: &Cache<'_>,
    terms: ReleaseTerms,
    refresh: bool,
) -> Result<CoverSearch, Error> {
    let (found, more) = tokio::join!(releases_like(first, cache, &terms, refresh), async {
        match second {
            Some(second) => Some(releases_like(second, cache, &terms, refresh).await),
            None => None,
        }
    });
    let (mut releases, more) = either(found, more)?;
    releases.extend(more);
    releases.retain(|release| similarity(&terms.album, &release.title) >= SAME_ALBUM_FROM);
    releases.sort_by_key(|release| {
        (
            Reverse(similarity(&terms.album, &release.title)),
            !release.pictured,
            !release.official,
            release.year.map_or(u16::MAX, |year| year.0),
        )
    });
    releases.truncate(MAX_COVER_OPTIONS);
    Ok(CoverSearch {
        options: releases
            .into_iter()
            .map(|release| CoverOption {
                release: release.id,
                title: release.title,
                artist: release.album_artists.join(SEPARATOR),
                year: release.year,
                country: release.country,
                format: release.format,
            })
            .collect(),
        album: terms.album,
        artist: terms.artist,
    })
}

/// What a lookup needs from a song file.
pub struct Song {
    pub fields: BTreeMap<String, String>,
    pub duration_ms: Option<Milliseconds>,
    /// The file already holds a picture, so no cover is offered for it.
    pub has_cover: bool,
}

/// Reads a song's tags and length; `None` when the file cannot be read as audio.
pub fn read_song(path: &Path) -> Option<Song> {
    let file = lofty::read_from_path(path).ok()?;
    let duration_ms = u64::try_from(file.properties().duration().as_millis())
        .ok()
        .filter(|ms| *ms > 0);
    Some(Song {
        fields: tags::field_values(file.primary_tag()),
        duration_ms,
        has_cover: file.tags().iter().any(|tag| !tag.pictures().is_empty()),
    })
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    Matched {
        candidates: Vec<Candidate>,
    },
    /// The source has no song like this one.
    NoMatch,
    /// The song has no title or no artist to search with.
    NotEnoughTags,
    Failed {
        message: String,
    },
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SongLookup {
    pub path: String,
    /// The file already holds a cover, so a cover from a match would replace it.
    pub has_cover: bool,
    pub outcome: Outcome,
}

/// Sent as `lookup-progress` while songs are looked up.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: usize,
    pub total: usize,
}

/// Looks up one song file in every source given. A failure is part of the answer, so one bad
/// song does not lose the others.
pub async fn song<A: Source, B: Source>(
    first: &A,
    second: Option<&B>,
    cache: &Cache<'_>,
    path: &Path,
    song: Option<Song>,
    refresh: bool,
) -> SongLookup {
    let has_cover = song.as_ref().is_some_and(|song| song.has_cover);
    let outcome = match song {
        None => Outcome::Failed {
            message: "this file's tags cannot be read".to_owned(),
        },
        Some(song) => match Query::from_tags(&song.fields, song.duration_ms) {
            None => Outcome::NotEnoughTags,
            Some(query) => {
                let (found, more) =
                    tokio::join!(candidates(first, cache, &query, &song, refresh), async {
                        match second {
                            Some(second) => {
                                Some(candidates(second, cache, &query, &song, refresh).await)
                            }
                            None => None,
                        }
                    });
                match either(found, more).map(|(found, more)| merge(found, more, &song.fields)) {
                    Ok(found) if found.is_empty() => Outcome::NoMatch,
                    Ok(found) => Outcome::Matched { candidates: found },
                    Err(e) => Outcome::Failed {
                        message: e.to_string(),
                    },
                }
            }
        },
    };
    SongLookup {
        path: path.to_string_lossy().into_owned(),
        has_cover,
        outcome,
    }
}

/// A little over a second between requests: `MusicBrainz` asks for one a second, Discogs for
/// sixty a minute, and the margin keeps clock jitter from breaking either limit.
pub(crate) const SPACING: Duration = Duration::from_millis(1100);

/// Spaces out every request the app makes to one source, whichever lookup makes it.
#[derive(Default)]
pub struct Pace {
    next: tokio::sync::Mutex<Option<Instant>>,
}

impl Pace {
    /// Returns when the next request may be sent. The lock is held while waiting, so
    /// requests queue up instead of all waking at once.
    pub(crate) async fn turn(&self) {
        let mut next = self.next.lock().await;
        if let Some(at) = *next {
            tokio::time::sleep_until(at).await;
        }
        *next = Some(Instant::now() + SPACING);
    }
}

/// The app's one lookup at a time: its request pacing, what it remembers of Discogs while the
/// app runs, and the flags that start and stop it.
#[derive(Default)]
pub struct Session {
    /// The pacing of requests to `MusicBrainz`.
    pub pace: Pace,
    pub discogs_pace: Pace,
    pub discogs_pages: discogs::Pages,
    pub running: AtomicBool,
    pub cancelled: AtomicBool,
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use std::cell::RefCell;

    use super::*;

    const RECORDING: &str = "de0c999d-ddd0-494b-8a52-463333df64fd";
    const OTHER_RECORDING: &str = "0bb97c9b-eb49-4db1-b1b8-2b72111fd1ae";
    const RELEASE: &str = "170d8783-40b3-4b0b-879d-0ef6055dfeb3";
    const OTHER_RELEASE: &str = "b791a9cc-dc92-45ee-b5b9-be5617823411";

    fn recording_id(raw: &str) -> RecordingId {
        RecordingId::try_from(raw.to_owned()).expect("id")
    }

    fn release_id(raw: &str) -> ReleaseId {
        ReleaseId::try_from(raw.to_owned()).expect("id")
    }

    fn release(id: &str, title: &str) -> Release {
        Release {
            id: release_id(id),
            title: title.to_owned(),
            album_artists: vec!["Daft Punk".to_owned()],
            official: true,
            compilation: false,
            year: Some(Year(1997)),
            track: Some(7),
            track_total: Some(16),
            country: None,
            format: None,
            pictured: false,
        }
    }

    fn found(id: &str, title: &str, artist: &str, duration_ms: Option<Milliseconds>) -> Found {
        Found {
            recording: recording_id(id),
            title: title.to_owned(),
            artists: vec![artist.to_owned()],
            duration_ms,
            first_released: Some(Year(1997)),
            isrc: None,
            releases: vec![release(RELEASE, "Homework")],
        }
    }

    fn fields(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(field, value)| ((*field).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn query(title: &str, artist: &str, duration_ms: Option<Milliseconds>) -> Query {
        Query {
            title: title.to_owned(),
            artist: artist.to_owned(),
            album: None,
            duration_ms,
        }
    }

    #[test]
    fn identifiers_are_checked() {
        // (as written, as kept; `None` when refused)
        let recordings = [
            (RECORDING, Some(RECORDING)),
            ("DE0C999D-DDD0-494B-8A52-463333DF64FD", Some(RECORDING)),
            ("  de0c999d-ddd0-494b-8a52-463333df64fd ", Some(RECORDING)),
            ("de0c999dddd0494b8a52463333df64fd", Some(RECORDING)),
            ("discogs-27651-6", Some("discogs-27651-6")),
            ("discogs-27651-0", Some("discogs-27651-0")),
            ("", None),
            ("de0c999d", None),
            ("../release/x", None),
            ("de0c999d-ddd0-494b-8a52-463333df64fd/extra", None),
            ("de0c999d-ddd0-494b-8a52-463333df64fg", None),
            ("discogs-27651", None),
            ("discogs-27651-", None),
            ("discogs--6", None),
            ("discogs-27651-6-1", None),
            ("discogs-27651-+6", None),
            ("discogs-27651-6/extra", None),
            ("Discogs-27651-6", None),
        ];
        for (raw, expected) in recordings {
            let id = RecordingId::try_from(raw.to_owned()).ok();
            assert_eq!(
                id.map(|id| id.to_string()).as_deref(),
                expected,
                "recording {raw:?}"
            );
        }
        let releases = [
            (RELEASE, Some(RELEASE)),
            ("discogs-27651", Some("discogs-27651")),
            ("discogs-0", Some("discogs-0")),
            ("", None),
            ("27651", None),
            ("discogs-", None),
            ("discogs-27651-6", None),
            ("discogs-../x", None),
            ("discogs- 27651", None),
            ("discogs-99999999999999999999999", None),
            ("discogs-27651?x=1", None),
        ];
        for (raw, expected) in releases {
            let id = ReleaseId::try_from(raw.to_owned()).ok();
            assert_eq!(
                id.map(|id| id.to_string()).as_deref(),
                expected,
                "release {raw:?}"
            );
        }
    }

    #[test]
    fn an_identifier_keeps_its_source_through_the_cache() {
        let ids = [release_id(RELEASE), release_id("discogs-27651")];
        let saved = serde_json::to_string(&ids).expect("saved");
        assert_eq!(saved, format!(r#"["{RELEASE}","discogs-27651"]"#));
        let read: Vec<ReleaseId> = serde_json::from_str(&saved).expect("read");
        assert_eq!(read, ids);
        assert!(matches!(
            read[1],
            ReleaseId::Discogs(DiscogsRelease(27_651))
        ));
    }

    #[test]
    fn a_year_is_read_from_the_start_of_a_date() {
        let cases = [
            ("1997", Some(1997)),
            ("1997-03", Some(1997)),
            ("1997-03-17", Some(1997)),
            (" 2006-10-02 ", Some(2006)),
            ("", None),
            ("199", None),
            ("19x7-01-01", None),
            ("-199-01-01", None),
            ("unknown", None),
        ];
        for (date, expected) in cases {
            assert_eq!(Year::from_date(date), expected.map(Year), "{date:?}");
        }
    }

    #[test]
    fn a_song_needs_a_title_and_an_artist_to_be_searched_for() {
        /// The title, artist and album a song is searched by.
        type Searched<'a> = (&'a str, &'a str, Option<&'a str>);
        /// A song's tags, by field.
        type Tags<'a> = &'a [(&'a str, &'a str)];
        let cases: [(Tags, Option<Searched>); 6] = [
            (
                &[("title", "Song"), ("artist", "Band")],
                Some(("Song", "Band", None)),
            ),
            (
                &[("title", " Song "), ("artist", "Band"), ("album", "LP")],
                Some(("Song", "Band", Some("LP"))),
            ),
            (
                &[("title", "Song"), ("artist", "Band"), ("album", "  ")],
                Some(("Song", "Band", None)),
            ),
            (&[("title", "Song")], None),
            (&[("artist", "Band"), ("album", "LP")], None),
            (&[("title", "  "), ("artist", "Band")], None),
        ];
        for (tags, expected) in cases {
            let query = Query::from_tags(&fields(tags), Some(1));
            let read = query
                .as_ref()
                .map(|q| (q.title.as_str(), q.artist.as_str(), q.album.as_deref()));
            assert_eq!(read, expected, "{tags:?}");
        }
    }

    #[test]
    fn only_the_title_and_first_artist_are_sent() {
        let cases = [
            (
                ("Around the World", "Daft Punk"),
                ("Around the World", "Daft Punk"),
            ),
            (
                ("Strobe (Original Mix)", "deadmau5"),
                ("Strobe", "deadmau5"),
            ),
            (
                ("Strobe [original mix]", "deadmau5"),
                ("Strobe", "deadmau5"),
            ),
            (
                ("Strobe - Original Mix", "deadmau5"),
                ("Strobe", "deadmau5"),
            ),
            (
                ("Strobe (Club Mix)", "deadmau5"),
                ("Strobe (Club Mix)", "deadmau5"),
            ),
            (
                ("(Original Mix)", "deadmau5"),
                ("(Original Mix)", "deadmau5"),
            ),
            (("Song", "First; Second"), ("Song", "First")),
            (("Song", "First & Second"), ("Song", "First & Second")),
        ];
        for ((title, artist), (sent_title, sent_artist)) in cases {
            let mut query = query(title, artist, Some(240_000));
            query.album = Some("Private Album".to_owned());
            assert_eq!(
                query.terms(),
                SearchTerms {
                    title: sent_title.to_owned(),
                    artist: sent_artist.to_owned(),
                },
                "{title:?} by {artist:?}"
            );
        }
    }

    #[test]
    fn names_are_compared_without_case_accents_or_punctuation() {
        // (a, b, the lowest and highest similarity that is right)
        let cases = [
            ("Around the World", "around the world", SAME, SAME),
            ("Beyoncé", "Beyonce", SAME, SAME),
            ("AC/DC", "ac dc", SAME, SAME),
            ("Simon & Garfunkel", "Simon and Garfunkel", SAME, SAME),
            ("A feat. B", "B, A", SAME, SAME),
            ("Strobe (Original Mix)", "Strobe", SAME, SAME),
            ("Daftpunk", "Daft Punk", 850, 950),
            (
                "Around the World",
                "Around the World (Radio Edit)",
                700,
                800,
            ),
            ("Daft Punk", "Daft Punk feat. Pharrell", 750, 850),
            ("Around the World", "Harder Better Faster Stronger", 0, 0),
            ("Daft Punk", "Red Hot Chili Peppers", 0, 0),
            ("", "Daft Punk", 0, 0),
            ("!!!", "???", 0, 0),
        ];
        for (a, b, lowest, highest) in cases {
            let alike = similarity(a, b);
            assert!(
                (lowest..=highest).contains(&alike),
                "{a:?} and {b:?} are {alike} alike, expected {lowest} to {highest}"
            );
            assert_eq!(alike, similarity(b, a), "{a:?} and {b:?}, either way round");
        }
    }

    #[test]
    fn lengths_count_for_a_match_when_close_and_against_when_far() {
        let cases = [
            (Some(240_000), Some(240_000), SAME),
            (Some(240_000), Some(242_000), SAME),
            (Some(242_000), Some(240_000), SAME),
            (Some(240_000), Some(246_000), 500),
            (Some(240_000), Some(250_000), 0),
            (Some(240_000), Some(420_000), 0),
            (None, Some(240_000), LENGTH_UNKNOWN),
            (Some(240_000), None, LENGTH_UNKNOWN),
            (None, None, LENGTH_UNKNOWN),
        ];
        for (mine, theirs, expected) in cases {
            assert_eq!(
                length_similarity(mine, theirs),
                expected,
                "{mine:?} and {theirs:?}"
            );
        }
    }

    #[test]
    fn a_match_is_likely_only_when_names_and_length_agree() {
        // (what, the song, the result, confidence, likely)
        let cases = [
            (
                "the same song",
                query("Around the World", "Daft Punk", Some(240_000)),
                found(RECORDING, "Around the World", "Daft Punk", Some(241_000)),
                Some((100, true)),
            ),
            (
                "the same names, length unknown",
                query("Around the World", "Daft Punk", None),
                found(RECORDING, "Around the World", "Daft Punk", Some(241_000)),
                Some((90, true)),
            ),
            (
                "the same names, another edit by its length",
                query("Around the World", "Daft Punk", Some(240_000)),
                found(RECORDING, "Around the World", "Daft Punk", Some(430_000)),
                Some((75, false)),
            ),
            (
                "a store's Original Mix",
                query(
                    "Around the World (Original Mix)",
                    "daft punk",
                    Some(240_000),
                ),
                found(RECORDING, "Around the World", "Daft Punk", Some(240_000)),
                Some((100, true)),
            ),
            (
                "a named edit against the plain title, length unknown",
                query("Around the World (Radio Edit)", "Daft Punk", None),
                found(RECORDING, "Around the World", "Daft Punk", None),
                Some((78, false)),
            ),
            (
                "the same title by someone else",
                query("Around the World", "Daft Punk", Some(240_000)),
                found(
                    RECORDING,
                    "Around the World",
                    "Red Hot Chili Peppers",
                    Some(240_000),
                ),
                Some((70, false)),
            ),
            (
                "another song altogether",
                query("Around the World", "Daft Punk", Some(240_000)),
                found(RECORDING, "One More Time", "Someone Else", Some(320_000)),
                None,
            ),
        ];
        for (what, query, result, expected) in cases {
            let ranked = rank(&query, &BTreeMap::new(), &[result]);
            let read = ranked.first().map(|c| (c.confidence.0, c.likely));
            assert_eq!(read, expected, "{what}");
        }
    }

    #[test]
    fn two_results_that_fit_equally_well_are_left_for_the_user_to_choose() {
        let song = query("Around the World", "Daft Punk", None);
        let mut live = found(
            OTHER_RECORDING,
            "Around the World",
            "Daft Punk",
            Some(205_000),
        );
        live.releases = vec![release(OTHER_RELEASE, "Alive 2007")];
        let album = found(RECORDING, "Around the World", "Daft Punk", Some(240_000));

        let tied = rank(&song, &BTreeMap::new(), &[album.clone(), live.clone()]);
        assert_eq!(tied.len(), 2);
        assert!(tied.iter().all(|c| !c.likely), "a tie is not a match");

        let with_length = query("Around the World", "Daft Punk", Some(240_500));
        let settled = rank(&with_length, &BTreeMap::new(), &[live, album]);
        assert_eq!(settled[0].recording, recording_id(RECORDING));
        assert!(settled[0].likely, "the length settles it");
        assert!(!settled[1].likely);
    }

    #[test]
    fn results_that_give_the_same_tags_are_shown_once() {
        let song = query("Around the World", "Daft Punk", Some(240_000));
        let first = found(RECORDING, "Around the World", "Daft Punk", Some(240_000));
        let again = found(
            OTHER_RECORDING,
            "Around the World",
            "Daft Punk",
            Some(240_000),
        );
        let ranked = rank(&song, &BTreeMap::new(), &[first, again]);
        assert_eq!(ranked.len(), 1);
        assert!(ranked[0].likely);
    }

    #[test]
    fn at_most_five_candidates_are_shown() {
        let song = query("Around the World", "Daft Punk", None);
        let results: Vec<Found> = (0..8)
            .map(|n| {
                let mut result = found(RECORDING, "Around the World", "Daft Punk", None);
                result.first_released = Some(Year(1990 + n));
                result
            })
            .collect();
        assert_eq!(
            rank(&song, &BTreeMap::new(), &results).len(),
            MAX_CANDIDATES
        );
    }

    #[test]
    fn album_tags_come_from_the_release_that_fits_best() {
        let official = |official: bool| Release {
            official,
            ..release(if official { RELEASE } else { OTHER_RELEASE }, "Homework")
        };
        let compilation = |compilation: bool| Release {
            compilation,
            ..release(
                if compilation { OTHER_RELEASE } else { RELEASE },
                "Homework",
            )
        };
        let from = |year: Option<u16>, id: &str| Release {
            year: year.map(Year),
            ..release(id, "Homework")
        };
        // (what, the song's album, the releases, the one chosen)
        let cases = [
            (
                "the one named like the song's album",
                Some("Musique Vol. 1"),
                vec![
                    release(RELEASE, "Homework"),
                    release(OTHER_RELEASE, "Musique, Vol. 1"),
                ],
                Some(OTHER_RELEASE),
            ),
            (
                "an official one over a bootleg",
                None,
                vec![official(false), official(true)],
                Some(RELEASE),
            ),
            (
                "an album over a compilation",
                None,
                vec![compilation(true), compilation(false)],
                Some(RELEASE),
            ),
            (
                "the earliest",
                None,
                vec![from(Some(2001), OTHER_RELEASE), from(Some(1997), RELEASE)],
                Some(RELEASE),
            ),
            (
                "a dated one over an undated one",
                None,
                vec![from(None, OTHER_RELEASE), from(Some(2001), RELEASE)],
                Some(RELEASE),
            ),
            ("none when there are none", Some("Homework"), vec![], None),
        ];
        for (what, album, releases, expected) in cases {
            let chosen = best_release(album, &releases).map(|r| r.id.to_string());
            assert_eq!(chosen.as_deref(), expected, "{what}");
        }
    }

    #[test]
    fn a_candidate_lists_what_it_knows_and_what_it_would_change() {
        let song = query("around the world", "Daft Punk", Some(240_000));
        let current = fields(&[
            ("title", "around the world"),
            ("artist", "Daft Punk"),
            ("year", "1997"),
            ("genre", "House"),
        ]);
        let mut result = found(RECORDING, "Around the World", "Daft Punk", Some(240_000));
        result.artists.push("Guest".to_owned());
        result.isrc = Some("GBDUW0000059".to_owned());

        let ranked = rank(&song, &current, &[result]);
        let candidate = &ranked[0];
        assert_eq!(candidate.release, Some(release_id(RELEASE)));
        assert_eq!(
            candidate.fields,
            fields(&[
                ("title", "Around the World"),
                ("artist", "Daft Punk; Guest"),
                ("album", "Homework"),
                ("albumArtist", "Daft Punk"),
                ("year", "1997"),
                ("track", "7"),
                ("trackTotal", "16"),
                ("isrc", "GBDUW0000059"),
            ])
        );
        let change = |field: &str, from: Option<&str>, to: &str| Change {
            field: field.to_owned(),
            from: from.map(str::to_owned),
            to: Some(to.to_owned()),
        };
        assert_eq!(
            candidate.changes,
            vec![
                change("title", Some("around the world"), "Around the World"),
                change("artist", Some("Daft Punk"), "Daft Punk; Guest"),
                change("album", None, "Homework"),
                change("albumArtist", None, "Daft Punk"),
                change("track", None, "7"),
                change("trackTotal", None, "16"),
                change("isrc", None, "GBDUW0000059"),
            ],
            "the year is the same and the genre is not the source's to change"
        );
    }

    /// A source that answers from memory and counts what it is asked.
    struct Scripted {
        found: Vec<Found>,
        label: Option<&'static str>,
        genres: Vec<&'static str>,
        front_cover: bool,
        /// What a search for an album's releases answers, and how often it was asked.
        albums: Vec<Release>,
        release_searches: std::cell::Cell<usize>,
        fails: bool,
        searches: RefCell<Vec<SearchTerms>>,
        releases: RefCell<Vec<ReleaseId>>,
    }

    impl Scripted {
        fn with(found: Vec<Found>) -> Self {
            Self {
                found,
                label: Some("Virgin"),
                genres: Vec::new(),
                front_cover: true,
                albums: Vec::new(),
                release_searches: std::cell::Cell::new(0),
                fails: false,
                searches: RefCell::new(Vec::new()),
                releases: RefCell::new(Vec::new()),
            }
        }

        fn requests(&self) -> (usize, usize) {
            (self.searches.borrow().len(), self.releases.borrow().len())
        }
    }

    impl Source for Scripted {
        const NAME: &'static str = "scripted";

        fn search(&self, terms: &SearchTerms) -> impl Future<Output = Result<Vec<Found>, Error>> {
            self.searches.borrow_mut().push(SearchTerms {
                title: terms.title.clone(),
                artist: terms.artist.clone(),
            });
            std::future::ready(if self.fails {
                Err(Error::Msg("the source is not answering".to_owned()))
            } else {
                Ok(self.found.clone())
            })
        }

        fn releases(
            &self,
            _terms: &ReleaseTerms,
        ) -> impl Future<Output = Result<Vec<Release>, Error>> {
            self.release_searches.set(self.release_searches.get() + 1);
            std::future::ready(Ok(self.albums.clone()))
        }

        fn release(&self, id: &ReleaseId) -> impl Future<Output = Result<ReleaseDetails, Error>> {
            self.releases.borrow_mut().push(id.clone());
            std::future::ready(Ok(ReleaseDetails {
                label: self.label.map(str::to_owned),
                genres: self.genres.iter().map(|g| (*g).to_owned()).collect(),
                front_cover: self.front_cover,
            }))
        }

        fn cover(
            &self,
            _id: &ReleaseId,
            _size: CoverSize,
        ) -> impl Future<Output = Result<Vec<u8>, Error>> {
            std::future::ready(Ok(Vec::new()))
        }
    }

    /// A lookup in one source, as when no Discogs token is saved.
    async fn song_alone(
        source: &Scripted,
        cache: &Cache<'_>,
        path: &Path,
        read: Option<Song>,
        refresh: bool,
    ) -> SongLookup {
        song(source, None::<&Scripted>, cache, path, read, refresh).await
    }

    async fn cover_search_alone(
        source: &Scripted,
        cache: &Cache<'_>,
        terms: ReleaseTerms,
        refresh: bool,
    ) -> Result<CoverSearch, Error> {
        cover_search(source, None::<&Scripted>, cache, terms, refresh).await
    }

    fn library() -> Mutex<Connection> {
        Mutex::new(db::open(Path::new(":memory:")).expect("db"))
    }

    fn tagged(pairs: &[(&str, &str)]) -> Song {
        Song {
            fields: fields(pairs),
            duration_ms: Some(240_000),
            has_cover: false,
        }
    }

    const DAFT_PUNK: &[(&str, &str)] = &[("title", "Around the World"), ("artist", "Daft Punk")];

    fn album_result() -> Vec<Found> {
        vec![found(
            RECORDING,
            "Around the World",
            "Daft Punk",
            Some(240_000),
        )]
    }

    #[tokio::test]
    async fn the_best_match_also_gets_its_label() {
        let db = library();
        let source = Scripted::with(album_result());
        let cache = Cache::new(&db, 1_000);
        let looked_up = song_alone(
            &source,
            &cache,
            Path::new("a.mp3"),
            Some(tagged(DAFT_PUNK)),
            false,
        )
        .await;

        assert_eq!(looked_up.path, "a.mp3");
        let candidates = match looked_up.outcome {
            Outcome::Matched { candidates } => candidates,
            other => unreachable!("expected a match, got {other:?}"),
        };
        assert_eq!(
            candidates[0].fields.get("label").map(String::as_str),
            Some("Virgin")
        );
        assert!(
            candidates[0]
                .changes
                .iter()
                .any(|c| c.field == "label" && c.from.is_none())
        );
        assert_eq!(*source.releases.borrow(), vec![release_id(RELEASE)]);
    }

    #[tokio::test]
    async fn a_cover_is_offered_only_with_the_best_match_and_only_when_its_release_has_one() {
        let mut second = found(
            OTHER_RECORDING,
            "Around the World",
            "Daft Punk",
            Some(205_000),
        );
        second.releases = vec![release(OTHER_RELEASE, "Alive 2007")];
        let both = || {
            vec![
                found(RECORDING, "Around the World", "Daft Punk", Some(240_000)),
                second.clone(),
            ]
        };
        // (what, the song has a cover, the release has one, the cover offered)
        let cases = [
            ("a song without a cover", false, true, Some(RELEASE)),
            (
                "a song that has a cover can swap it",
                true,
                true,
                Some(RELEASE),
            ),
            ("a release without a cover", false, false, None),
        ];
        for (what, has_cover, front_cover, expected) in cases {
            let db = library();
            let mut source = Scripted::with(both());
            source.front_cover = front_cover;
            let song = Song {
                has_cover,
                ..tagged(DAFT_PUNK)
            };
            let query = Query::from_tags(&song.fields, song.duration_ms).expect("query");
            let ranked = candidates(&source, &Cache::new(&db, 0), &query, &song, false)
                .await
                .expect("candidates");
            assert_eq!(ranked.len(), 2, "{what}");
            assert_eq!(ranked[0].cover, expected.map(release_id), "{what}");
            assert_eq!(ranked[1].cover, None, "{what}: only the best match");
        }
    }

    #[tokio::test]
    async fn a_saved_answer_is_used_until_it_ages_out_or_a_refresh_is_asked_for() {
        let db = library();
        let source = Scripted::with(album_result());
        let day = 24 * 60 * 60;
        // (what, when, refresh, searches and release pages asked for so far)
        let steps = [
            ("the first lookup asks", 0, false, (1, 1)),
            (
                "the next one is answered from the cache",
                day,
                false,
                (1, 1),
            ),
            ("as is one 30 days on", 30 * day, false, (1, 1)),
            ("a refresh asks again", 30 * day, true, (2, 2)),
            (
                "an aged answer is asked for again",
                61 * day + 1,
                false,
                (3, 3),
            ),
        ];
        for (what, now, refresh, expected) in steps {
            let cache = Cache::new(&db, now);
            let looked_up = song_alone(
                &source,
                &cache,
                Path::new("a.mp3"),
                Some(tagged(DAFT_PUNK)),
                refresh,
            )
            .await;
            assert!(
                matches!(looked_up.outcome, Outcome::Matched { .. }),
                "{what}"
            );
            assert_eq!(source.requests(), expected, "{what}");
        }
    }

    #[tokio::test]
    async fn songs_tagged_alike_share_one_search() {
        let db = library();
        let source = Scripted::with(album_result());
        let cache = Cache::new(&db, 0);
        let tagged_alike: [&[(&str, &str)]; 2] = [
            DAFT_PUNK,
            &[
                ("title", "around the world (Original Mix)"),
                ("artist", "DAFT PUNK"),
            ],
        ];
        for tags in tagged_alike {
            song_alone(
                &source,
                &cache,
                Path::new("a.mp3"),
                Some(tagged(tags)),
                false,
            )
            .await;
        }
        assert_eq!(source.requests(), (1, 1));
    }

    #[tokio::test]
    async fn every_song_gets_an_outcome() {
        let db = library();
        let cache = Cache::new(&db, 0);
        let nothing_like_it = Scripted::with(vec![found(
            RECORDING,
            "One More Time",
            "Someone Else",
            Some(320_000),
        )]);
        let mut down = Scripted::with(Vec::new());
        down.fails = true;
        // (what, the source, the song, the outcome, searches made)
        let cases = [
            (
                "a file that cannot be read",
                Scripted::with(album_result()),
                None,
                Outcome::Failed {
                    message: "this file's tags cannot be read".to_owned(),
                },
                0,
            ),
            (
                "a song with no artist",
                Scripted::with(album_result()),
                Some(tagged(&[("title", "Around the World")])),
                Outcome::NotEnoughTags,
                0,
            ),
            (
                "a song the source has nothing for",
                Scripted::with(Vec::new()),
                Some(tagged(&[("title", "Unreleased"), ("artist", "Nobody")])),
                Outcome::NoMatch,
                1,
            ),
            (
                "a song the source only has other songs for",
                nothing_like_it,
                Some(tagged(&[("title", "Rare Dub"), ("artist", "Obscure")])),
                Outcome::NoMatch,
                1,
            ),
            (
                "a source that is down",
                down,
                Some(tagged(&[("title", "Offline"), ("artist", "Band")])),
                Outcome::Failed {
                    message: "the source is not answering".to_owned(),
                },
                1,
            ),
        ];
        for (what, source, tags, expected, searches) in cases {
            let looked_up = song_alone(&source, &cache, Path::new("a.mp3"), tags, false).await;
            assert_eq!(looked_up.outcome, expected, "{what}");
            assert_eq!(source.requests().0, searches, "{what}");
        }
    }

    #[tokio::test]
    async fn a_failed_search_is_not_saved() {
        let db = library();
        let cache = Cache::new(&db, 0);
        let mut down = Scripted::with(Vec::new());
        down.fails = true;
        song_alone(
            &down,
            &cache,
            Path::new("a.mp3"),
            Some(tagged(DAFT_PUNK)),
            false,
        )
        .await;

        let up = Scripted::with(album_result());
        let looked_up = song_alone(
            &up,
            &cache,
            Path::new("a.mp3"),
            Some(tagged(DAFT_PUNK)),
            false,
        )
        .await;
        assert!(matches!(looked_up.outcome, Outcome::Matched { .. }));
        assert_eq!(up.requests().0, 1, "asked again once the source is back");
    }

    #[tokio::test]
    async fn a_lookup_says_whether_the_song_has_a_cover_to_lose() {
        let db = library();
        let cache = Cache::new(&db, 0);
        let source = Scripted::with(album_result());
        for has_cover in [true, false] {
            let song_read = Song {
                has_cover,
                ..tagged(DAFT_PUNK)
            };
            let looked_up =
                song_alone(&source, &cache, Path::new("a.mp3"), Some(song_read), false).await;
            assert_eq!(looked_up.has_cover, has_cover);
        }
        let unread = song_alone(&source, &cache, Path::new("a.mp3"), None, false).await;
        assert!(!unread.has_cover);
    }

    #[test]
    fn a_cover_search_goes_by_album_and_album_artist() {
        /// A song's tags, by field.
        type Tags<'a> = &'a [(&'a str, &'a str)];
        /// The album and artist a cover is searched by.
        type Searched<'a> = (&'a str, &'a str);
        let cases: [(Tags, Option<Searched>); 7] = [
            (
                &[
                    ("album", "Homework"),
                    ("albumArtist", "Daft Punk"),
                    ("artist", "Guest"),
                ],
                Some(("Homework", "Daft Punk")),
            ),
            (
                &[("album", "Homework"), ("artist", "Daft Punk")],
                Some(("Homework", "Daft Punk")),
            ),
            (
                &[("album", "Homework"), ("artist", "Daft Punk; Guest")],
                Some(("Homework", "Daft Punk")),
            ),
            (
                &[("title", "One More Time"), ("artist", "Daft Punk")],
                Some(("One More Time", "Daft Punk")),
            ),
            (
                &[
                    ("album", " "),
                    ("title", "One More Time"),
                    ("artist", "Daft Punk"),
                ],
                Some(("One More Time", "Daft Punk")),
            ),
            (&[("album", "Homework")], None),
            (&[("artist", "Daft Punk")], None),
        ];
        for (tags, expected) in cases {
            let terms = ReleaseTerms::from_tags(&fields(tags));
            let read = terms
                .as_ref()
                .map(|t| (t.album.as_str(), t.artist.as_str()));
            assert_eq!(read, expected, "{tags:?}");
        }
    }

    #[tokio::test]
    async fn cover_options_are_the_album_s_releases_official_and_earliest_first() {
        let pressing = |id: &str, title: &str, official: bool, year: Option<u16>| Release {
            official,
            year: year.map(Year),
            country: Some("FR".to_owned()),
            format: Some("CD".to_owned()),
            ..release(id, title)
        };
        let reissue = "11111111-1111-4111-8111-111111111111";
        let bootleg = "22222222-2222-4222-8222-222222222222";
        let other = "33333333-3333-4333-8333-333333333333";
        let mut source = Scripted::with(Vec::new());
        source.albums = vec![
            pressing(bootleg, "Homework", false, Some(1996)),
            pressing(reissue, "Homework", true, Some(2022)),
            pressing(other, "Discovery", true, Some(2001)),
            pressing(RELEASE, "homework", true, Some(1997)),
            pressing(OTHER_RELEASE, "Homework", true, None),
        ];
        let db = library();
        let terms = || ReleaseTerms {
            album: "Homework".to_owned(),
            artist: "Daft Punk".to_owned(),
        };
        let found = cover_search_alone(&source, &Cache::new(&db, 0), terms(), false)
            .await
            .expect("search");
        assert_eq!(
            (found.album.as_str(), found.artist.as_str()),
            ("Homework", "Daft Punk")
        );
        let order: Vec<String> = found
            .options
            .iter()
            .map(|o| o.release.to_string())
            .collect();
        assert_eq!(
            order,
            [RELEASE, reissue, OTHER_RELEASE, bootleg],
            "another album is left out"
        );
        assert_eq!(found.options[0].country.as_deref(), Some("FR"));
        assert_eq!(found.options[0].format.as_deref(), Some("CD"));

        cover_search_alone(&source, &Cache::new(&db, 60), terms(), false)
            .await
            .expect("search");
        assert_eq!(
            source.release_searches.get(),
            1,
            "the second search is answered from the cache"
        );
        cover_search_alone(&source, &Cache::new(&db, 60), terms(), true)
            .await
            .expect("search");
        assert_eq!(source.release_searches.get(), 2, "a refresh asks again");
    }

    #[test]
    fn outcomes_are_sent_to_the_app_by_kind() {
        let cases = [
            (Outcome::NoMatch, r#"{"kind":"noMatch"}"#),
            (Outcome::NotEnoughTags, r#"{"kind":"notEnoughTags"}"#),
            (
                Outcome::Failed {
                    message: "busy".to_owned(),
                },
                r#"{"kind":"failed","message":"busy"}"#,
            ),
            (
                Outcome::Matched {
                    candidates: Vec::new(),
                },
                r#"{"kind":"matched","candidates":[]}"#,
            ),
        ];
        for (outcome, expected) in cases {
            assert_eq!(serde_json::to_string(&outcome).expect("json"), expected);
        }
    }

    /// A second source, whose answers are cached apart from the first's.
    struct Second(Scripted);

    impl Source for Second {
        const NAME: &'static str = "second";

        fn search(&self, terms: &SearchTerms) -> impl Future<Output = Result<Vec<Found>, Error>> {
            self.0.search(terms)
        }

        fn releases(
            &self,
            terms: &ReleaseTerms,
        ) -> impl Future<Output = Result<Vec<Release>, Error>> {
            self.0.releases(terms)
        }

        fn release(&self, id: &ReleaseId) -> impl Future<Output = Result<ReleaseDetails, Error>> {
            self.0.release(id)
        }

        fn cover(
            &self,
            id: &ReleaseId,
            size: CoverSize,
        ) -> impl Future<Output = Result<Vec<u8>, Error>> {
            self.0.cover(id, size)
        }
    }

    const DISCOGS_RELEASE: &str = "discogs-27651";

    /// What a second source finds for the song in [`album_result`]: titled `title`, on `album`.
    fn second_result(title: &str, album: &str) -> Second {
        let mut found = found("discogs-27651-6", title, "Daft Punk", Some(240_000));
        found.releases = vec![release(DISCOGS_RELEASE, album)];
        let mut source = Scripted::with(vec![found]);
        source.label = Some("Soma");
        source.genres = vec!["House", "Techno"];
        Second(source)
    }

    async fn both(first: &Scripted, second: &Second, tags: &[(&str, &str)]) -> Outcome {
        let db = library();
        song(
            first,
            Some(second),
            &Cache::new(&db, 0),
            Path::new("a.mp3"),
            Some(tagged(tags)),
            false,
        )
        .await
        .outcome
    }

    fn matched(outcome: Outcome) -> Vec<Candidate> {
        match outcome {
            Outcome::Matched { candidates } => candidates,
            _ => Vec::new(),
        }
    }

    #[tokio::test]
    async fn a_song_both_sources_know_is_one_match_that_says_more() {
        let mut first = Scripted::with(album_result());
        first.front_cover = false;
        let found = matched(
            both(
                &first,
                &second_result("Around The World", "Homework"),
                DAFT_PUNK,
            )
            .await,
        );
        assert_eq!(found.len(), 1, "the same song is shown once");
        let only = &found[0];
        assert!(only.likely);
        assert_eq!(only.recording, recording_id(RECORDING));
        assert_eq!(
            only.field("title"),
            "Around the World",
            "the first source's spelling stays"
        );
        assert_eq!(only.field("label"), "Virgin", "and its label");
        assert_eq!(
            only.field("genre"),
            "House; Techno",
            "the second adds what it lacks"
        );
        assert_eq!(
            only.cover,
            Some(release_id(DISCOGS_RELEASE)),
            "and its cover, when the first has none"
        );
        assert!(only.changes.iter().any(|c| c.field == "genre"));
    }

    #[tokio::test]
    async fn another_album_in_the_second_source_gives_no_album_tags() {
        let mut first = Scripted::with(album_result());
        first.label = None;
        let found = matched(
            both(
                &first,
                &second_result("Around the World", "Club Hits 97"),
                DAFT_PUNK,
            )
            .await,
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].field("album"), "Homework");
        assert_eq!(
            found[0].field("label"),
            "",
            "that label is another release's"
        );
        assert_eq!(
            found[0].field("genre"),
            "House; Techno",
            "the style is the song's"
        );
    }

    #[tokio::test]
    async fn a_song_only_the_second_source_knows_is_its_own_match() {
        let first = Scripted::with(album_result());
        let second = second_result("Around the World (Radio Edit)", "Homework");
        let found = matched(both(&first, &second, DAFT_PUNK).await);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].recording, recording_id(RECORDING));
        assert!(found[0].likely, "the exact title is still the sure one");
        assert_eq!(found[0].field("genre"), "");
        assert_eq!(found[1].recording, recording_id("discogs-27651-6"));
        assert!(!found[1].likely);
    }

    #[tokio::test]
    async fn one_source_failing_does_not_lose_what_the_other_found() {
        let failing = || {
            let mut source = Scripted::with(Vec::new());
            source.fails = true;
            source
        };
        let nothing = || Scripted::with(Vec::new());
        // (what, the first source, the second, the outcome's kind)
        let cases = [
            (
                "only the second answers",
                failing(),
                Second(Scripted::with(album_result())),
                "matched",
            ),
            (
                "only the first answers",
                Scripted::with(album_result()),
                Second(failing()),
                "matched",
            ),
            (
                "both find it",
                Scripted::with(album_result()),
                Second(Scripted::with(album_result())),
                "matched",
            ),
            ("neither answers", failing(), Second(failing()), "failed"),
            (
                "the first fails and the second has nothing",
                failing(),
                Second(nothing()),
                "failed",
            ),
            (
                "the first has nothing and the second fails",
                nothing(),
                Second(failing()),
                "failed",
            ),
            (
                "neither knows the song",
                nothing(),
                Second(nothing()),
                "noMatch",
            ),
        ];
        for (what, first, second, expected) in cases {
            let outcome = both(&first, &second, DAFT_PUNK).await;
            let kind = match outcome {
                Outcome::Matched { .. } => "matched",
                Outcome::Failed { .. } => "failed",
                Outcome::NoMatch => "noMatch",
                Outcome::NotEnoughTags => "notEnoughTags",
            };
            assert_eq!(kind, expected, "{what}");
        }
    }

    #[tokio::test]
    async fn a_cover_search_asks_both_sources_and_puts_known_pictures_first() {
        let mut first = Scripted::with(Vec::new());
        first.albums = vec![release(RELEASE, "Homework")];
        let mut pictured = release(DISCOGS_RELEASE, "Homework");
        pictured.pictured = true;
        pictured.year = Some(Year(2001));
        let mut second = Scripted::with(Vec::new());
        second.albums = vec![pictured, release("discogs-5", "Discovery")];
        let second = Second(second);
        let db = library();
        let terms = || ReleaseTerms {
            album: "Homework".to_owned(),
            artist: "Daft Punk".to_owned(),
        };
        let found = cover_search(&first, Some(&second), &Cache::new(&db, 0), terms(), false)
            .await
            .expect("search");
        let order: Vec<String> = found
            .options
            .iter()
            .map(|o| o.release.to_string())
            .collect();
        assert_eq!(order, [DISCOGS_RELEASE, RELEASE]);

        first.fails = true;
        let found = cover_search(&first, Some(&second), &Cache::new(&db, 0), terms(), true)
            .await
            .expect("search");
        assert_eq!(
            found.options.len(),
            2,
            "releases search does not fail in this source"
        );
    }

    fn picture(width: u32, height: u32, format: image::ImageFormat) -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(width, height)
            .write_to(&mut bytes, format)
            .expect("encoded");
        bytes.into_inner()
    }

    #[test]
    fn a_cover_is_brought_down_to_size_and_never_up() {
        use image::ImageFormat::{Jpeg, Png};
        // (what, width, height, format, size written; `None` when written as it came)
        let cases = [
            ("a large square", 1200, 1200, Jpeg, Some((800, 800))),
            ("a large PNG", 1000, 1000, Png, Some((800, 800))),
            (
                "a wide one keeps its shape",
                1600,
                800,
                Jpeg,
                Some((800, 400)),
            ),
            (
                "a tall one keeps its shape",
                500,
                1000,
                Jpeg,
                Some((400, 800)),
            ),
            ("one pixel over", 801, 801, Jpeg, Some((800, 800))),
            ("exactly the size", 800, 800, Jpeg, None),
            ("a small one", 500, 500, Jpeg, None),
            ("a small PNG stays a PNG", 300, 200, Png, None),
        ];
        for (what, width, height, format, expected) in cases {
            let original = picture(width, height, format);
            let fitted = fit_cover(original.clone()).expect("fitted");
            match expected {
                None => assert_eq!(fitted, original, "{what}"),
                Some(size) => {
                    let read = image::load_from_memory(&fitted).expect("readable");
                    assert_eq!((read.width(), read.height()), size, "{what}");
                    assert_eq!(image::guess_format(&fitted).ok(), Some(Jpeg), "{what}");
                }
            }
        }
        for not_a_picture in [&b""[..], b"<html>busy</html>", &[0xff, 0xd8, 0xff]] {
            assert!(fit_cover(not_a_picture.to_vec()).is_err());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn requests_are_spaced_out() {
        let pace = Pace::default();
        let started = Instant::now();
        pace.turn().await;
        assert_eq!(started.elapsed(), Duration::ZERO, "the first goes at once");
        pace.turn().await;
        pace.turn().await;
        assert_eq!(started.elapsed(), SPACING * 2);
    }
}
