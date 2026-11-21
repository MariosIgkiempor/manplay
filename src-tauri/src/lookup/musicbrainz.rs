//! `MusicBrainz` as a lookup source: its recording search and its release pages, read as JSON.
//! No account is needed; `MusicBrainz` allows each client one request a second.

use std::time::Duration;

use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Deserializer};

use super::{
    CoverSize, Found, Mbid, Milliseconds, Pace, RecordingId, Release, ReleaseDetails, ReleaseId,
    ReleaseTerms, SPACING, SearchTerms, Source, Year,
};
use crate::error::Error;

const BASE: &str = "https://musicbrainz.org/ws/2";
const USER_AGENT: &str = concat!("manplay/", env!("CARGO_PKG_VERSION"));
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// How many times a request is sent before giving up on a busy `MusicBrainz`.
const ATTEMPTS: u32 = 5;
/// The longest one wait between those attempts.
const LONGEST_WAIT: Duration = Duration::from_secs(5);
const SEARCH_LIMIT: &str = "10";
/// An album has many pressings; this many gives a choice of covers.
const RELEASE_LIMIT: &str = "25";
/// The Cover Art Archive, which holds the covers of `MusicBrainz` releases.
const COVERS: &str = "https://coverartarchive.org";
/// A 1200 pixel cover is well under this; anything larger is not what was asked for.
const LARGEST_COVER_BYTES: usize = 5 * 1024 * 1024;

pub struct MusicBrainz<'a> {
    http: &'a Client,
    pace: &'a Pace,
}

impl<'a> MusicBrainz<'a> {
    pub fn new(http: &'a Client, pace: &'a Pace) -> Self {
        Self { http, pace }
    }

    /// A request to `MusicBrainz` itself, which is the service the pace is for. `MusicBrainz`
    /// turns requests away whenever the whole service is over its shared limit, which is often
    /// and has nothing to do with this app, so a refusal is waited out and asked again.
    async fn get(&self, url: Url) -> Result<Vec<u8>, Error> {
        for _ in 1..ATTEMPTS {
            self.pace.turn().await;
            match self.send(url.clone(), "application/json").await? {
                Answer::Body(body) => return Ok(body),
                Answer::Busy(wait) => tokio::time::sleep(wait).await,
            }
        }
        self.pace.turn().await;
        self.fetch(url, "application/json").await
    }

    /// One request; being turned away is an error.
    async fn fetch(&self, url: Url, accept: &str) -> Result<Vec<u8>, Error> {
        match self.send(url, accept).await? {
            Answer::Body(body) => Ok(body),
            Answer::Busy(_) => Err(Error::Msg(
                "MusicBrainz is busy. Try again in a minute.".to_owned(),
            )),
        }
    }

    async fn send(&self, url: Url, accept: &str) -> Result<Answer, Error> {
        let response = self
            .http
            .get(url)
            .header("User-Agent", USER_AGENT)
            .header("Accept", accept)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    Error::Msg("MusicBrainz is not answering".to_owned())
                } else {
                    Error::Http(e)
                }
            })?;
        match response.status() {
            s if s.is_success() => Ok(Answer::Body(response.bytes().await?.to_vec())),
            StatusCode::NOT_FOUND => Err(Error::Msg("MusicBrainz has nothing there".to_owned())),
            StatusCode::SERVICE_UNAVAILABLE | StatusCode::TOO_MANY_REQUESTS => {
                let asked_for = response
                    .headers()
                    .get("Retry-After")
                    .and_then(|v| v.to_str().ok());
                Ok(Answer::Busy(retry_after(asked_for)))
            }
            s => Err(Error::Msg(format!("MusicBrainz answered {s}"))),
        }
    }
}

/// What came back from one request.
enum Answer {
    Body(Vec<u8>),
    /// Turned away for now; ask again after this long.
    Busy(Duration),
}

/// How long to wait before asking again: what the `Retry-After` header says in seconds, at
/// least the usual spacing and at most [`LONGEST_WAIT`]; a second when it says nothing usable.
fn retry_after(header: Option<&str>) -> Duration {
    header
        .and_then(|seconds| seconds.trim().parse::<u64>().ok())
        .map_or(Duration::from_secs(1), Duration::from_secs)
        .clamp(SPACING, LONGEST_WAIT)
}

impl Source for MusicBrainz<'_> {
    const NAME: &'static str = "musicbrainz";

    async fn search(&self, terms: &SearchTerms) -> Result<Vec<Found>, Error> {
        parse_search(&self.get(search_url(terms)?).await?)
    }

    async fn releases(&self, terms: &ReleaseTerms) -> Result<Vec<Release>, Error> {
        parse_releases(&self.get(releases_url(terms)?).await?)
    }

    async fn release(&self, id: &ReleaseId) -> Result<ReleaseDetails, Error> {
        parse_release(&self.get(release_url(own(id)?)?).await?)
    }

    async fn cover(&self, id: &ReleaseId, size: CoverSize) -> Result<Vec<u8>, Error> {
        let image = self
            .fetch(cover_url(own(id)?, size)?, "image/jpeg, image/png")
            .await?;
        if image.len() > LARGEST_COVER_BYTES {
            return Err(Error::Msg("that cover is too large to use".to_owned()));
        }
        Ok(image)
    }
}

/// The `MusicBrainz` identifier in `id`; a release of another source is not one to ask for here.
fn own(id: &ReleaseId) -> Result<&Mbid, Error> {
    match id {
        ReleaseId::MusicBrainz(id) => Ok(id),
        ReleaseId::Discogs(_) => Err(Error::Msg(
            "that release is not one of MusicBrainz's".to_owned(),
        )),
    }
}

fn address(e: impl std::fmt::Display) -> Error {
    Error::Msg(format!("MusicBrainz address: {e}"))
}

/// `text` as a quoted phrase in the search's Lucene syntax.
fn phrase(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

fn search_url(terms: &SearchTerms) -> Result<Url, Error> {
    let query = format!(
        "recording:{} AND artist:{}",
        phrase(&terms.title),
        phrase(&terms.artist)
    );
    Url::parse_with_params(
        &format!("{BASE}/recording"),
        [
            ("query", query.as_str()),
            ("fmt", "json"),
            ("limit", SEARCH_LIMIT),
        ],
    )
    .map_err(address)
}

fn releases_url(terms: &ReleaseTerms) -> Result<Url, Error> {
    let query = format!(
        "release:{} AND artist:{}",
        phrase(&terms.album),
        phrase(&terms.artist)
    );
    Url::parse_with_params(
        &format!("{BASE}/release"),
        [
            ("query", query.as_str()),
            ("fmt", "json"),
            ("limit", RELEASE_LIMIT),
        ],
    )
    .map_err(address)
}

fn release_url(id: &Mbid) -> Result<Url, Error> {
    Url::parse_with_params(
        &format!("{BASE}/release/{}", id.as_str()),
        [("inc", "labels"), ("fmt", "json")],
    )
    .map_err(address)
}

fn cover_url(id: &Mbid, size: CoverSize) -> Result<Url, Error> {
    let pixels = match size {
        CoverSize::Thumbnail => 250,
        CoverSize::Embedded => 1200,
    };
    Url::parse(&format!("{COVERS}/release/{}/front-{pixels}", id.as_str())).map_err(address)
}

/// A list that `MusicBrainz` may leave out or send as `null`.
fn or_empty<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Deserialize)]
struct SearchPage {
    recordings: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
struct RecordingJson {
    id: Mbid,
    title: String,
    length: Option<Milliseconds>,
    #[serde(default, deserialize_with = "or_empty")]
    artist_credit: Vec<CreditJson>,
    first_release_date: Option<String>,
    #[serde(default, deserialize_with = "or_empty")]
    isrcs: Vec<String>,
    #[serde(default, deserialize_with = "or_empty")]
    releases: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct CreditJson {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
struct ReleaseJson {
    id: Mbid,
    title: String,
    status: Option<String>,
    date: Option<String>,
    country: Option<String>,
    #[serde(default, deserialize_with = "or_empty")]
    artist_credit: Vec<CreditJson>,
    release_group: Option<GroupJson>,
    #[serde(default, deserialize_with = "or_empty")]
    media: Vec<MediumJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
struct GroupJson {
    #[serde(default, deserialize_with = "or_empty")]
    secondary_types: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
struct MediumJson {
    format: Option<String>,
    track_count: Option<u32>,
    #[serde(default, deserialize_with = "or_empty")]
    track: Vec<TrackJson>,
}

#[derive(Deserialize)]
struct TrackJson {
    /// Text, because vinyl sides are numbered `A1`, `B2`.
    number: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
struct ReleasePage {
    #[serde(default, deserialize_with = "or_empty")]
    label_info: Vec<LabelInfoJson>,
    cover_art_archive: Option<CoverArtJson>,
}

#[derive(Deserialize)]
struct CoverArtJson {
    #[serde(default)]
    front: bool,
}

#[derive(Deserialize)]
struct LabelInfoJson {
    label: Option<LabelJson>,
}

#[derive(Deserialize)]
struct LabelJson {
    name: String,
}

fn names(credit: Vec<CreditJson>) -> Vec<String> {
    credit
        .into_iter()
        .map(|c| c.name.trim().to_owned())
        .filter(|n| !n.is_empty())
        .collect()
}

fn release(json: ReleaseJson) -> Release {
    let medium = json.media.into_iter().next();
    let track = medium
        .as_ref()
        .and_then(|m| m.track.first())
        .and_then(|t| t.number.as_deref())
        .and_then(|n| n.trim().parse().ok());
    Release {
        id: ReleaseId::MusicBrainz(json.id),
        pictured: false,
        title: json.title.trim().to_owned(),
        album_artists: names(json.artist_credit),
        official: json.status.as_deref() == Some("Official"),
        compilation: json
            .release_group
            .is_some_and(|g| g.secondary_types.iter().any(|t| t == "Compilation")),
        year: json.date.as_deref().and_then(Year::from_date),
        track,
        track_total: medium.as_ref().and_then(|m| m.track_count),
        country: json.country.filter(|c| !c.trim().is_empty()),
        format: medium
            .and_then(|m| m.format)
            .filter(|f| !f.trim().is_empty()),
    }
}

fn found(json: RecordingJson) -> Found {
    Found {
        recording: RecordingId::MusicBrainz(json.id),
        title: json.title.trim().to_owned(),
        artists: names(json.artist_credit),
        duration_ms: json.length,
        first_released: json.first_release_date.as_deref().and_then(Year::from_date),
        isrc: json.isrcs.into_iter().next(),
        releases: json
            .releases
            .into_iter()
            .filter_map(|r| serde_json::from_value(r).ok())
            .map(release)
            .collect(),
    }
}

fn unreadable(e: &serde_json::Error) -> Error {
    Error::Msg(format!(
        "MusicBrainz sent an answer manplay cannot read: {e}"
    ))
}

/// The recordings in a search answer. One that lacks an id or a title is left out, so a
/// single odd entry does not lose the rest; so is a release that lacks them.
fn parse_search(body: &[u8]) -> Result<Vec<Found>, Error> {
    let page: SearchPage = serde_json::from_slice(body).map_err(|e| unreadable(&e))?;
    Ok(page
        .recordings
        .into_iter()
        .filter_map(|r| serde_json::from_value::<RecordingJson>(r).ok())
        .filter(|r| !r.title.trim().is_empty())
        .map(found)
        .collect())
}

#[derive(Deserialize)]
struct ReleasesPage {
    releases: Vec<serde_json::Value>,
}

/// The releases in a release search answer; one that lacks an id or a title is left out.
fn parse_releases(body: &[u8]) -> Result<Vec<Release>, Error> {
    let page: ReleasesPage = serde_json::from_slice(body).map_err(|e| unreadable(&e))?;
    Ok(page
        .releases
        .into_iter()
        .filter_map(|r| serde_json::from_value::<ReleaseJson>(r).ok())
        .filter(|r| !r.title.trim().is_empty())
        .map(release)
        .collect())
}

fn parse_release(body: &[u8]) -> Result<ReleaseDetails, Error> {
    let page: ReleasePage = serde_json::from_slice(body).map_err(|e| unreadable(&e))?;
    Ok(ReleaseDetails {
        label: page
            .label_info
            .into_iter()
            .filter_map(|info| info.label)
            .map(|label| label.name.trim().to_owned())
            .find(|name| !name.is_empty()),
        genres: Vec::new(),
        front_cover: page.cover_art_archive.is_some_and(|art| art.front),
    })
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    const RECORDING: &str = "de0c999d-ddd0-494b-8a52-463333df64fd";
    const RELEASE: &str = "170d8783-40b3-4b0b-879d-0ef6055dfeb3";

    /// A search answer cut down from a real one.
    fn search_answer() -> String {
        format!(
            r#"{{
              "created": "2026-11-21T10:00:00.000Z", "count": 113, "offset": 0,
              "recordings": [{{
                "id": "{RECORDING}", "score": 100, "title": "Around the World",
                "length": 240000, "video": null,
                "artist-credit": [
                  {{"name": "Daft Punk", "joinphrase": " feat. ", "artist": {{"id": "x", "name": "Daft Punk"}}}},
                  {{"name": "Someone", "artist": {{"id": "y", "name": "Someone"}}}}
                ],
                "first-release-date": "1997-03-17",
                "isrcs": ["GBDUW0000059"],
                "releases": [{{
                  "id": "{RELEASE}", "title": "Homework", "status": "Official",
                  "date": "1997-01-20", "track-count": 16,
                  "artist-credit": [{{"name": "Daft Punk"}}],
                  "release-group": {{"primary-type": "Album", "secondary-types": ["Compilation"]}},
                  "media": [{{"position": 1, "format": "CD", "track-count": 16, "track-offset": 6,
                             "track": [{{"id": "t", "number": "7", "title": "Around the World"}}]}}]
                }}]
              }}]
            }}"#
        )
    }

    fn mbid() -> Mbid {
        Mbid::try_from(RELEASE.to_owned()).expect("id")
    }

    fn release_id() -> ReleaseId {
        ReleaseId::MusicBrainz(mbid())
    }

    #[test]
    fn a_search_answer_is_read_in_full() {
        let found = parse_search(search_answer().as_bytes()).expect("parsed");
        assert_eq!(
            found,
            vec![Found {
                recording: RecordingId::try_from(RECORDING.to_owned()).expect("id"),
                title: "Around the World".to_owned(),
                artists: vec!["Daft Punk".to_owned(), "Someone".to_owned()],
                duration_ms: Some(240_000),
                first_released: Some(Year(1997)),
                isrc: Some("GBDUW0000059".to_owned()),
                releases: vec![Release {
                    id: release_id(),
                    title: "Homework".to_owned(),
                    album_artists: vec!["Daft Punk".to_owned()],
                    official: true,
                    compilation: true,
                    year: Some(Year(1997)),
                    track: Some(7),
                    track_total: Some(16),
                    country: None,
                    format: Some("CD".to_owned()),
                    pictured: false,
                }],
            }]
        );
    }

    #[test]
    fn search_answers_are_checked() {
        let recording = |body: &str| format!(r#"{{"recordings": [{body}]}}"#);
        // (what, answer, recordings read; `None` when the whole answer is refused)
        let cases = [
            ("no recordings", r#"{"recordings": []}"#.to_owned(), Some(0)),
            (
                "only the required fields",
                recording(&format!(r#"{{"id": "{RECORDING}", "title": "Song"}}"#)),
                Some(1),
            ),
            (
                "lists sent as null",
                recording(&format!(
                    r#"{{"id": "{RECORDING}", "title": "Song", "length": null,
                        "artist-credit": null, "isrcs": null, "releases": null}}"#
                )),
                Some(1),
            ),
            (
                "an id that is not a UUID",
                recording(r#"{"id": "../release", "title": "Song"}"#),
                Some(0),
            ),
            ("no id", recording(r#"{"title": "Song"}"#), Some(0)),
            (
                "no title",
                recording(&format!(r#"{{"id": "{RECORDING}"}}"#)),
                Some(0),
            ),
            (
                "a blank title",
                recording(&format!(r#"{{"id": "{RECORDING}", "title": "  "}}"#)),
                Some(0),
            ),
            (
                "a length that is not a number",
                recording(&format!(
                    r#"{{"id": "{RECORDING}", "title": "Song", "length": "long"}}"#
                )),
                Some(0),
            ),
            (
                "recordings is not a list",
                r#"{"recordings": 3}"#.to_owned(),
                None,
            ),
            ("no recordings key", r#"{"count": 0}"#.to_owned(), None),
            ("not JSON", "<html>busy</html>".to_owned(), None),
            ("empty", String::new(), None),
        ];
        for (what, answer, expected) in cases {
            let read = parse_search(answer.as_bytes())
                .ok()
                .map(|found| found.len());
            assert_eq!(read, expected, "{what}");
        }
    }

    #[test]
    fn a_release_is_read_leniently_where_it_can_be() {
        let release = |fields: &str| {
            let answer = format!(
                r#"{{"recordings": [{{"id": "{RECORDING}", "title": "Song",
                    "releases": [{{{fields}}}]}}]}}"#
            );
            parse_search(answer.as_bytes())
                .expect("parsed")
                .remove(0)
                .releases
                .pop()
        };
        let id = format!(r#""id": "{RELEASE}", "title": "Album""#);
        // (what, release fields, (official, compilation, year, track, track total))
        let cases = [
            (
                "the required fields",
                id.clone(),
                Some((false, false, None, None, None)),
            ),
            (
                "a bootleg",
                format!(r#"{id}, "status": "Bootleg""#),
                Some((false, false, None, None, None)),
            ),
            (
                "a year alone",
                format!(r#"{id}, "status": "Official", "date": "1999""#),
                Some((true, false, Some(Year(1999)), None, None)),
            ),
            (
                "an empty date",
                format!(r#"{id}, "date": """#),
                Some((false, false, None, None, None)),
            ),
            (
                "a vinyl side",
                format!(r#"{id}, "media": [{{"track-count": 4, "track": [{{"number": "A1"}}]}}]"#),
                Some((false, false, None, None, Some(4))),
            ),
            (
                "a numbered track",
                format!(r#"{id}, "media": [{{"track-count": 12, "track": [{{"number": "5"}}]}}]"#),
                Some((false, false, None, Some(5), Some(12))),
            ),
            (
                "a live album is not a compilation",
                format!(r#"{id}, "release-group": {{"secondary-types": ["Live"]}}"#),
                Some((false, false, None, None, None)),
            ),
            ("no title", format!(r#""id": "{RELEASE}""#), None),
            (
                "an id that is not a UUID",
                r#""id": "abc", "title": "Album""#.to_owned(),
                None,
            ),
        ];
        for (what, fields, expected) in cases {
            let read = release(&fields)
                .map(|r| (r.official, r.compilation, r.year, r.track, r.track_total));
            assert_eq!(read, expected, "{what}");
        }
    }

    #[test]
    fn a_release_page_gives_its_first_named_label_and_whether_it_has_a_cover() {
        // (what, answer, (label, front cover); `None` when the answer is refused)
        let cases = [
            (
                "one label",
                r#"{"label-info": [{"label": {"name": "Virgin"}, "catalog-number": "V1"}]}"#,
                Some((Some("Virgin"), false)),
            ),
            (
                "a label entry with no label",
                r#"{"label-info": [{"label": null}, {"label": {"name": " Soma "}}]}"#,
                Some((Some("Soma"), false)),
            ),
            ("no labels", r#"{"label-info": []}"#, Some((None, false))),
            (
                "labels sent as null",
                r#"{"label-info": null}"#,
                Some((None, false)),
            ),
            ("no label key", r#"{"title": "Album"}"#, Some((None, false))),
            (
                "a front cover",
                r#"{"cover-art-archive": {"artwork": true, "front": true, "back": false}}"#,
                Some((None, true)),
            ),
            (
                "artwork, but no front cover",
                r#"{"cover-art-archive": {"artwork": true, "front": false, "back": true}}"#,
                Some((None, false)),
            ),
            (
                "cover art sent as null",
                r#"{"cover-art-archive": null}"#,
                Some((None, false)),
            ),
            (
                "cover art with no front key",
                r#"{"cover-art-archive": {}}"#,
                Some((None, false)),
            ),
            (
                "a front cover flag that is not a flag",
                r#"{"cover-art-archive": {"front": "yes"}}"#,
                None,
            ),
            (
                "a label with no name",
                r#"{"label-info": [{"label": {}}]}"#,
                None,
            ),
            ("not JSON", "busy", None),
        ];
        for (what, answer, expected) in cases {
            let read = parse_release(answer.as_bytes())
                .ok()
                .map(|d| (d.label, d.front_cover));
            let expected = expected.map(|(label, cover)| (label.map(str::to_owned), cover));
            assert_eq!(read, expected, "{what}");
        }
    }

    #[test]
    fn a_search_sends_the_title_and_artist_as_quoted_phrases() {
        let cases = [
            (
                ("Around the World", "Daft Punk"),
                r#"recording:"Around the World" AND artist:"Daft Punk""#,
            ),
            (
                (r#"Say "Yes""#, r"AC\DC"),
                r#"recording:"Say \"Yes\"" AND artist:"AC\\DC""#,
            ),
            (
                ("Title) OR recording:(x", "A & B"),
                r#"recording:"Title) OR recording:(x" AND artist:"A & B""#,
            ),
        ];
        for ((title, artist), expected) in cases {
            let url = search_url(&SearchTerms {
                title: title.to_owned(),
                artist: artist.to_owned(),
            })
            .expect("url");
            let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
            assert_eq!(url.path(), "/ws/2/recording");
            assert_eq!(
                pairs,
                vec![
                    ("query".to_owned(), expected.to_owned()),
                    ("fmt".to_owned(), "json".to_owned()),
                    ("limit".to_owned(), "10".to_owned()),
                ]
            );
        }
    }

    #[test]
    fn a_release_is_asked_for_with_its_labels() {
        let url = release_url(&mbid()).expect("url");
        assert_eq!(
            url.as_str(),
            format!("https://musicbrainz.org/ws/2/release/{RELEASE}?inc=labels&fmt=json")
        );
    }

    #[test]
    fn a_release_search_is_read_and_checked() {
        // Cut down from a real answer.
        let sample = format!(
            r#"{{"created": "2026-11-21T10:00:00.000Z", "count": 40, "offset": 0, "releases": [
                {{"id": "{RELEASE}", "score": 100, "title": "Homework",
                  "artist-credit": [{{"name": "Daft Punk"}}],
                  "release-group": {{"primary-type": "Album"}},
                  "date": "1997", "country": "JP", "track-count": 16,
                  "media": [{{"format": "CD", "disc-count": 1, "track-count": 16}}]}}
            ]}}"#
        );
        let read = parse_releases(sample.as_bytes()).expect("parsed");
        assert_eq!(read.len(), 1);
        let pressing = &read[0];
        assert_eq!(pressing.id, release_id());
        assert_eq!(pressing.album_artists, ["Daft Punk"]);
        assert_eq!(pressing.year, Some(Year(1997)));
        assert_eq!(pressing.country.as_deref(), Some("JP"));
        assert_eq!(pressing.format.as_deref(), Some("CD"));
        assert_eq!(pressing.track, None, "a release search names no song");
        assert!(!pressing.official, "no status given");

        // (what, answer, releases read; `None` when the whole answer is refused)
        let cases = [
            ("no releases", r#"{"releases": []}"#.to_owned(), Some(0)),
            (
                "one without a title is left out",
                format!(
                    r#"{{"releases": [{{"id": "{RELEASE}"}}, {{"id": "{RELEASE}", "title": "A"}}]}}"#
                ),
                Some(1),
            ),
            (
                "an id that is not a UUID",
                r#"{"releases": [{"id": "x", "title": "A"}]}"#.to_owned(),
                Some(0),
            ),
            (
                "a blank country and format are no value",
                format!(
                    r#"{{"releases": [{{"id": "{RELEASE}", "title": "A", "country": "",
                        "media": [{{"format": " "}}]}}]}}"#
                ),
                Some(1),
            ),
            (
                "releases is not a list",
                r#"{"releases": {}}"#.to_owned(),
                None,
            ),
            (
                "a recordings answer",
                r#"{"recordings": []}"#.to_owned(),
                None,
            ),
            ("not JSON", "busy".to_owned(), None),
        ];
        for (what, answer, expected) in cases {
            let read = parse_releases(answer.as_bytes()).ok();
            assert_eq!(read.as_ref().map(Vec::len), expected, "{what}");
            if what.starts_with("a blank") {
                let only = read.as_ref().and_then(|r| r.first()).expect("one");
                assert_eq!((&only.country, &only.format), (&None, &None), "{what}");
            }
        }
    }

    #[test]
    fn a_release_search_sends_the_album_and_artist_as_quoted_phrases() {
        let url = releases_url(&ReleaseTerms {
            album: r#"The "Best" Of"#.to_owned(),
            artist: "Daft Punk".to_owned(),
        })
        .expect("url");
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert_eq!(url.path(), "/ws/2/release");
        assert_eq!(
            pairs,
            vec![
                (
                    "query".to_owned(),
                    r#"release:"The \"Best\" Of" AND artist:"Daft Punk""#.to_owned()
                ),
                ("fmt".to_owned(), "json".to_owned()),
                ("limit".to_owned(), "25".to_owned()),
            ]
        );
    }

    #[test]
    fn a_release_of_another_source_is_not_asked_for() {
        let theirs = ReleaseId::try_from("discogs-249504".to_owned()).expect("id");
        assert!(own(&theirs).is_err());
        assert_eq!(own(&release_id()).ok(), Some(&mbid()));
    }

    #[test]
    fn a_cover_is_asked_for_by_release_and_size() {
        let cases = [
            (CoverSize::Thumbnail, "front-250"),
            (CoverSize::Embedded, "front-1200"),
        ];
        for (size, file) in cases {
            let url = cover_url(&mbid(), size).expect("url");
            assert_eq!(
                url.as_str(),
                format!("https://coverartarchive.org/release/{RELEASE}/{file}")
            );
        }
    }

    #[test]
    fn a_busy_answer_is_waited_out_for_as_long_as_it_asks_within_limits() {
        let cases = [
            (Some("1"), SPACING),
            (Some("2"), Duration::from_secs(2)),
            (Some(" 3 "), Duration::from_secs(3)),
            (Some("5"), LONGEST_WAIT),
            (Some("3600"), LONGEST_WAIT),
            (Some("0"), SPACING),
            (Some("soon"), SPACING),
            (Some("-1"), SPACING),
            (Some("Sat, 21 Nov 2026 18:00:00 GMT"), SPACING),
            (Some(""), SPACING),
            (None, SPACING),
        ];
        for (header, expected) in cases {
            assert_eq!(retry_after(header), expected, "{header:?}");
        }
    }
}
