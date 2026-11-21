//! Discogs as a lookup source: its release search and its release pages, read as JSON. Discogs
//! knows the label, the styles of music and the cover of most dance records, which is where
//! `MusicBrainz` is thinnest. Searching needs a personal access token from the user's own
//! Discogs account, which is kept in the keychain; without one Discogs is not asked.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Deserializer};

use super::{
    CoverSize, DiscogsRelease, Found, Milliseconds, Pace, Permille, RecordingId, Release,
    ReleaseDetails, ReleaseId, ReleaseTerms, SearchTerms, Source, Year, similarity,
};
use crate::error::Error;

const BASE: &str = "https://api.discogs.com";
const USER_AGENT: &str = concat!("manplay/", env!("CARGO_PKG_VERSION"));
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const KEYCHAIN_SERVICE: &str = "manplay-discogs";
const KEYCHAIN_ACCOUNT: &str = "token";
/// A song search answers with releases, and each one's songs are on its own page: a request
/// each. This many pages are read for one song.
const PAGES_READ: usize = 3;
const SONG_SEARCH_LIMIT: &str = "5";
/// An album has many pressings; this many gives a choice of covers.
const RELEASE_LIMIT: &str = "25";
/// A track named less like the song than this is another song on the same release.
const SAME_SONG_FROM: Permille = 600;
/// Discogs keeps covers at 600 pixels; anything near this size is not one.
const LARGEST_COVER_BYTES: usize = 5 * 1024 * 1024;
/// What Discogs puts in place of a picture a release does not have.
const NO_PICTURE: &str = "spacer.gif";

/// A personal access token from the user's Discogs account.
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    pub fn parse(raw: &str) -> Result<Self, Error> {
        let token = raw.trim();
        if token.is_empty() {
            return Err(Error::Msg("enter the Discogs token".to_owned()));
        }
        // It goes into a header value as it is.
        if !token.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(Error::Msg(
                "a Discogs token is letters and numbers only".to_owned(),
            ));
        }
        Ok(Self(token.to_owned()))
    }
}

/// What is known of the saved token without asking the keychain again.
#[derive(Default)]
enum Remembered {
    /// The keychain has not been read yet.
    #[default]
    Unread,
    /// The token as last read or saved; `None` when there is none.
    Known(Option<Token>),
}

fn remembered() -> &'static Mutex<Remembered> {
    static TOKEN: OnceLock<Mutex<Remembered>> = OnceLock::new();
    TOKEN.get_or_init(Mutex::default)
}

fn remember(token: Option<Token>) {
    if let Ok(mut kept) = remembered().lock() {
        *kept = Remembered::Known(token);
    }
}

fn entry() -> Result<keyring::Entry, Error> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| Error::Msg(format!("keychain: {e}")))
}

pub fn save_token(token: &Token) -> Result<(), Error> {
    entry()?
        .set_password(&token.0)
        .map_err(|e| Error::Msg(format!("keychain: {e}")))?;
    remember(Some(token.clone()));
    Ok(())
}

/// The saved token; `None` when there is none.
pub fn load_token() -> Result<Option<Token>, Error> {
    // Read the keychain once per launch; macOS prompts on every read otherwise.
    if let Ok(kept) = remembered().lock()
        && let Remembered::Known(token) = &*kept
    {
        return Ok(token.clone());
    }
    let stored = match entry()?.get_password() {
        Ok(stored) => Token::parse(&stored).ok(),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => return Err(Error::Msg(format!("keychain: {e}"))),
    };
    remember(stored.clone());
    Ok(stored)
}

pub fn forget_token() {
    if let Ok(entry) = entry() {
        let _ = entry.delete_credential();
    }
    remember(None);
}

/// The release pages read while the app runs. One album's songs are all on one page, so
/// looking the album up reads it once.
pub type Pages = Mutex<HashMap<DiscogsRelease, Page>>;

pub struct Discogs<'a> {
    http: &'a Client,
    pace: &'a Pace,
    pages: &'a Pages,
    token: Token,
}

impl<'a> Discogs<'a> {
    pub fn new(http: &'a Client, pace: &'a Pace, pages: &'a Pages, token: Token) -> Self {
        Self {
            http,
            pace,
            pages,
            token,
        }
    }

    /// Asks Discogs whose token this is, which fails when it is not one Discogs gave out.
    pub async fn check_token(&self) -> Result<(), Error> {
        let url = Url::parse(&format!("{BASE}/oauth/identity")).map_err(address)?;
        self.get(url).await.map(|_| ())
    }

    /// A request to Discogs itself, which is what the pace and the token are for.
    async fn get(&self, url: Url) -> Result<Vec<u8>, Error> {
        self.pace.turn().await;
        let request = self
            .http
            .get(url)
            .header("Authorization", format!("Discogs token={}", self.token.0))
            .header("Accept", "application/json");
        send(request).await
    }

    async fn page(&self, release: DiscogsRelease) -> Result<Page, Error> {
        let read = |pages: &Pages| pages.lock().ok().and_then(|p| p.get(&release).cloned());
        if let Some(page) = read(self.pages) {
            return Ok(page);
        }
        let page = parse_page(&self.get(page_url(release)?).await?)?;
        if let Ok(mut pages) = self.pages.lock() {
            pages.insert(release, page.clone());
        }
        Ok(page)
    }
}

async fn send(request: reqwest::RequestBuilder) -> Result<Vec<u8>, Error> {
    let response = request
        .header("User-Agent", USER_AGENT)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                Error::Msg("Discogs is not answering".to_owned())
            } else {
                Error::Http(e)
            }
        })?;
    match response.status() {
        s if s.is_success() => Ok(response.bytes().await?.to_vec()),
        StatusCode::UNAUTHORIZED => Err(Error::Msg(
            "Discogs did not accept the token. Enter it again in Settings.".to_owned(),
        )),
        StatusCode::NOT_FOUND => Err(Error::Msg("Discogs has nothing there".to_owned())),
        StatusCode::TOO_MANY_REQUESTS => Err(Error::Msg(
            "Discogs is busy. Try again in a minute.".to_owned(),
        )),
        s => Err(Error::Msg(format!("Discogs answered {s}"))),
    }
}

impl Source for Discogs<'_> {
    const NAME: &'static str = "discogs";

    async fn search(&self, terms: &SearchTerms) -> Result<Vec<Found>, Error> {
        let listed = parse_listing(&self.get(song_search_url(terms)?).await?)?;
        let mut found = Vec::new();
        for entry in listed.into_iter().take(PAGES_READ) {
            let page = self.page(entry.release).await?;
            found.extend(page.song(entry.release, &terms.title));
        }
        Ok(found)
    }

    async fn releases(&self, terms: &ReleaseTerms) -> Result<Vec<Release>, Error> {
        let listed = parse_listing(&self.get(release_search_url(terms)?).await?)?;
        Ok(listed
            .into_iter()
            .filter(|entry| entry.pictured)
            .map(Listed::into_release)
            .collect())
    }

    async fn release(&self, id: &ReleaseId) -> Result<ReleaseDetails, Error> {
        let page = self.page(own(id)?).await?;
        Ok(ReleaseDetails {
            label: page.label,
            genres: page.genres,
            front_cover: page.picture.is_some(),
        })
    }

    /// Discogs keeps one size worth showing, so both sizes are the same picture.
    async fn cover(&self, id: &ReleaseId, _size: CoverSize) -> Result<Vec<u8>, Error> {
        let page = self.page(own(id)?).await?;
        let picture = page
            .picture
            .as_deref()
            .and_then(picture_url)
            .ok_or_else(|| Error::Msg("Discogs has no cover for that release".to_owned()))?;
        // The picture is public and on another host, so the token is not sent with it.
        let request = self
            .http
            .get(picture)
            .header("Accept", "image/jpeg, image/png");
        let image = send(request).await?;
        if image.len() > LARGEST_COVER_BYTES {
            return Err(Error::Msg("that cover is too large to use".to_owned()));
        }
        Ok(image)
    }
}

/// The Discogs release in `id`; a release of another source is not one to ask for here.
fn own(id: &ReleaseId) -> Result<DiscogsRelease, Error> {
    match id {
        ReleaseId::Discogs(release) => Ok(*release),
        ReleaseId::MusicBrainz(_) => Err(Error::Msg(
            "that release is not one of Discogs's".to_owned(),
        )),
    }
}

fn address(e: impl std::fmt::Display) -> Error {
    Error::Msg(format!("Discogs address: {e}"))
}

fn search_url(terms: [(&str, &str); 2], limit: &str) -> Result<Url, Error> {
    Url::parse_with_params(
        &format!("{BASE}/database/search"),
        [("type", "release"), terms[0], terms[1], ("per_page", limit)],
    )
    .map_err(address)
}

fn song_search_url(terms: &SearchTerms) -> Result<Url, Error> {
    search_url(
        [("artist", &terms.artist), ("track", &terms.title)],
        SONG_SEARCH_LIMIT,
    )
}

fn release_search_url(terms: &ReleaseTerms) -> Result<Url, Error> {
    search_url(
        [("artist", &terms.artist), ("release_title", &terms.album)],
        RELEASE_LIMIT,
    )
}

fn page_url(release: DiscogsRelease) -> Result<Url, Error> {
    Url::parse(&format!("{BASE}/releases/{}", release.0)).map_err(address)
}

/// A picture's address, when it is one Discogs serves: an answer could name any address, and
/// the app fetches only from Discogs.
fn picture_url(address: &str) -> Option<Url> {
    let url = Url::parse(address).ok()?;
    let host = url.host_str()?;
    let discogs = host == "discogs.com" || host.ends_with(".discogs.com");
    (url.scheme() == "https" && discogs).then_some(url)
}

/// A name as Discogs writes it, without what Discogs adds: the number that tells two acts of
/// one name apart, as in `Orbit (3)`, and the `*` that marks a name spelt another way on the
/// record.
fn plain_name(name: &str) -> String {
    let name = name.trim().trim_end_matches('*').trim_end();
    let numbered = name.rsplit_once(" (").and_then(|(before, number)| {
        let number = number.strip_suffix(')')?;
        super::digits::<u32>(number).map(|_| before)
    });
    numbered.unwrap_or(name).trim().to_owned()
}

/// A length written `7:09` or `1:02:03`, in milliseconds.
fn length(written: &str) -> Option<Milliseconds> {
    let parts: Vec<&str> = written.trim().split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let mut seconds: Milliseconds = 0;
    for part in parts {
        seconds = seconds.checked_mul(60)?.checked_add(super::digits(part)?)?;
    }
    (seconds > 0).then(|| seconds.checked_mul(1000)).flatten()
}

/// A text Discogs may leave out, send as `null` or send empty.
fn filled(text: Option<String>) -> Option<String> {
    text.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty())
}

/// A list that Discogs may leave out or send as `null`.
fn or_empty<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}

/// A year, which Discogs sends as text in a search and as a number on a page, and as 0 or
/// nothing when it does not know.
fn year<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Year>, D::Error> {
    let written = match Option::<serde_json::Value>::deserialize(deserializer)? {
        Some(serde_json::Value::String(text)) => text,
        Some(serde_json::Value::Number(number)) => number.to_string(),
        _ => return Ok(None),
    };
    Ok(Year::from_date(&written).filter(|year| year.0 > 0))
}

#[derive(Deserialize)]
struct ListingJson {
    results: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct ListedJson {
    id: u64,
    /// The artist and the release's name as one text: `Daft Punk - Homework`.
    title: String,
    #[serde(default, deserialize_with = "year")]
    year: Option<Year>,
    country: Option<String>,
    #[serde(default, deserialize_with = "or_empty")]
    format: Vec<String>,
    cover_image: Option<String>,
}

/// One release in a search answer.
#[derive(Debug, PartialEq, Eq)]
struct Listed {
    release: DiscogsRelease,
    title: String,
    artist: Option<String>,
    year: Option<Year>,
    country: Option<String>,
    format: Option<String>,
    compilation: bool,
    pictured: bool,
}

impl Listed {
    fn new(json: ListedJson) -> Self {
        let (artist, title) = match json.title.split_once(" - ") {
            Some((artist, title)) => (Some(plain_name(artist)), title),
            None => (None, json.title.as_str()),
        };
        Self {
            release: DiscogsRelease(json.id),
            title: title.trim().to_owned(),
            artist: artist.filter(|a| !a.is_empty()),
            year: json.year,
            country: filled(json.country),
            compilation: json.format.iter().any(|f| f == "Compilation"),
            format: filled(json.format.into_iter().next()),
            pictured: filled(json.cover_image).is_some_and(|p| !p.contains(NO_PICTURE)),
        }
    }

    fn into_release(self) -> Release {
        Release {
            id: ReleaseId::Discogs(self.release),
            title: self.title,
            album_artists: self.artist.into_iter().collect(),
            // Discogs lists what was pressed and sold; it has no word for a bootleg here.
            official: true,
            compilation: self.compilation,
            year: self.year,
            track: None,
            track_total: None,
            country: self.country,
            format: self.format,
            pictured: self.pictured,
        }
    }
}

fn unreadable(e: &serde_json::Error) -> Error {
    Error::Msg(format!("Discogs sent an answer manplay cannot read: {e}"))
}

/// The releases in a search answer. One that lacks an id or a title is left out, so a single
/// odd entry does not lose the rest.
fn parse_listing(body: &[u8]) -> Result<Vec<Listed>, Error> {
    let listing: ListingJson = serde_json::from_slice(body).map_err(|e| unreadable(&e))?;
    Ok(listing
        .results
        .into_iter()
        .filter_map(|r| serde_json::from_value::<ListedJson>(r).ok())
        .map(Listed::new)
        .filter(|listed| !listed.title.is_empty())
        .collect())
}

#[derive(Deserialize)]
struct PageJson {
    title: String,
    #[serde(default, deserialize_with = "or_empty")]
    artists: Vec<NamedJson>,
    #[serde(default, deserialize_with = "year")]
    year: Option<Year>,
    country: Option<String>,
    #[serde(default, deserialize_with = "or_empty")]
    labels: Vec<NamedJson>,
    #[serde(default, deserialize_with = "or_empty")]
    genres: Vec<String>,
    #[serde(default, deserialize_with = "or_empty")]
    styles: Vec<String>,
    #[serde(default, deserialize_with = "or_empty")]
    formats: Vec<FormatJson>,
    #[serde(default, deserialize_with = "or_empty")]
    tracklist: Vec<TrackJson>,
    #[serde(default, deserialize_with = "or_empty")]
    images: Vec<ImageJson>,
}

#[derive(Deserialize)]
struct NamedJson {
    name: String,
}

#[derive(Deserialize)]
struct FormatJson {
    name: Option<String>,
    #[serde(default, deserialize_with = "or_empty")]
    descriptions: Vec<String>,
}

#[derive(Deserialize)]
struct TrackJson {
    /// `track` for a song; a heading or an index line is not one.
    #[serde(rename = "type_")]
    kind: Option<String>,
    /// Text, because vinyl sides are numbered `A1`, `B2`.
    position: Option<String>,
    title: Option<String>,
    duration: Option<String>,
    #[serde(default, deserialize_with = "or_empty")]
    artists: Vec<NamedJson>,
}

#[derive(Deserialize)]
struct ImageJson {
    #[serde(rename = "type")]
    kind: Option<String>,
    uri: Option<String>,
}

/// What a release's page says that a lookup uses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page {
    title: String,
    artists: Vec<String>,
    year: Option<Year>,
    country: Option<String>,
    format: Option<String>,
    compilation: bool,
    label: Option<String>,
    /// Its styles, such as `House`; its broader genres, such as `Electronic`, when it has no
    /// styles.
    genres: Vec<String>,
    tracks: Vec<Track>,
    /// The address of its main picture.
    picture: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Track {
    /// Its number on the release, when it is a plain number.
    number: Option<u32>,
    title: String,
    /// Its own artists, which a compilation gives; empty when they are the release's.
    artists: Vec<String>,
    duration_ms: Option<Milliseconds>,
}

fn names(named: Vec<NamedJson>) -> Vec<String> {
    named
        .into_iter()
        .map(|n| plain_name(&n.name))
        .filter(|n| !n.is_empty())
        .collect()
}

fn parse_page(body: &[u8]) -> Result<Page, Error> {
    let json: PageJson = serde_json::from_slice(body).map_err(|e| unreadable(&e))?;
    let tracks = json
        .tracklist
        .into_iter()
        .filter(|t| t.kind.as_deref().is_none_or(|kind| kind == "track"))
        .filter_map(|t| {
            Some(Track {
                title: filled(t.title)?,
                number: t.position.as_deref().and_then(|p| super::digits(p.trim())),
                artists: names(t.artists),
                duration_ms: t.duration.as_deref().and_then(length),
            })
        })
        .collect();
    let main = |image: &&ImageJson| image.kind.as_deref() == Some("primary");
    let picture = json
        .images
        .iter()
        .find(main)
        .or(json.images.first())
        .and_then(|image| filled(image.uri.clone()));
    let styles = if json.styles.is_empty() {
        json.genres
    } else {
        json.styles
    };
    Ok(Page {
        title: json.title.trim().to_owned(),
        artists: names(json.artists),
        year: json.year,
        country: filled(json.country),
        compilation: json
            .formats
            .iter()
            .any(|f| f.descriptions.iter().any(|d| d == "Compilation")),
        format: json.formats.into_iter().find_map(|f| filled(f.name)),
        label: names(json.labels).into_iter().next(),
        genres: styles.into_iter().filter_map(|s| filled(Some(s))).collect(),
        tracks,
        picture,
    })
}

impl Page {
    /// The track of this release named most like `title`, as a found song; `None` when no
    /// track is that song.
    fn song(&self, release: DiscogsRelease, title: &str) -> Option<Found> {
        let (place, track) = self
            .tracks
            .iter()
            .enumerate()
            .rev()
            .max_by_key(|(_, track)| similarity(title, &track.title))
            .filter(|(_, track)| similarity(title, &track.title) >= SAME_SONG_FROM)?;
        Some(Found {
            recording: RecordingId::Discogs {
                release,
                track: u32::try_from(place).ok()?,
            },
            title: track.title.clone(),
            artists: if track.artists.is_empty() {
                self.artists.clone()
            } else {
                track.artists.clone()
            },
            duration_ms: track.duration_ms,
            // A page gives the year of this pressing, which is the release's year below.
            first_released: None,
            isrc: None,
            releases: vec![Release {
                id: ReleaseId::Discogs(release),
                title: self.title.clone(),
                album_artists: self.artists.clone(),
                official: true,
                compilation: self.compilation,
                year: self.year,
                track: track.number,
                track_total: u32::try_from(self.tracks.len()).ok(),
                country: self.country.clone(),
                format: self.format.clone(),
                pictured: self.picture.is_some(),
            }],
        })
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    const HOMEWORK: DiscogsRelease = DiscogsRelease(27_651);

    /// A release page cut down from a real one.
    const PAGE: &str = r#"{
      "id": 27651, "status": "Accepted", "year": 1997, "title": "Homework",
      "artists": [{"name": "Daft Punk", "anv": "", "join": "", "id": 1289}],
      "labels": [{"name": "Virgin", "catno": "V 2821", "id": 750}],
      "formats": [{"name": "Vinyl", "qty": "2", "descriptions": ["LP", "Album"]}],
      "country": "UK", "released": "1997-01-20",
      "genres": ["Electronic"], "styles": ["House", "Techno"],
      "tracklist": [
        {"position": "", "type_": "heading", "title": "Side A", "duration": ""},
        {"position": "A1", "type_": "track", "title": "Daftendirekt", "duration": "2:44"},
        {"position": "7", "type_": "track", "title": "Around The World", "duration": "7:09"}
      ],
      "images": [
        {"type": "secondary", "uri": "https://i.discogs.com/back.jpeg", "width": 600},
        {"type": "primary", "uri": "https://i.discogs.com/front.jpeg", "width": 600}
      ]
    }"#;

    #[test]
    fn a_release_page_is_read_in_full() {
        assert_eq!(
            parse_page(PAGE.as_bytes()).expect("parsed"),
            Page {
                title: "Homework".to_owned(),
                artists: vec!["Daft Punk".to_owned()],
                year: Some(Year(1997)),
                country: Some("UK".to_owned()),
                format: Some("Vinyl".to_owned()),
                compilation: false,
                label: Some("Virgin".to_owned()),
                genres: vec!["House".to_owned(), "Techno".to_owned()],
                tracks: vec![
                    Track {
                        number: None,
                        title: "Daftendirekt".to_owned(),
                        artists: Vec::new(),
                        duration_ms: Some(164_000),
                    },
                    Track {
                        number: Some(7),
                        title: "Around The World".to_owned(),
                        artists: Vec::new(),
                        duration_ms: Some(429_000),
                    },
                ],
                picture: Some("https://i.discogs.com/front.jpeg".to_owned()),
            }
        );
    }

    #[test]
    fn release_pages_are_checked() {
        // (what, answer, (label, genres, tracks, has a picture); `None` when refused)
        let cases = [
            (
                "only a title",
                r#"{"title": "Album"}"#,
                Some((None, vec![], 0, false)),
            ),
            (
                "lists sent as null",
                r#"{"title": "Album", "artists": null, "labels": null, "genres": null,
                    "styles": null, "formats": null, "tracklist": null, "images": null}"#,
                Some((None, vec![], 0, false)),
            ),
            (
                "genres stand in when there are no styles",
                r#"{"title": "Album", "genres": ["Electronic"], "styles": []}"#,
                Some((None, vec!["Electronic"], 0, false)),
            ),
            (
                "a numbered label name",
                r#"{"title": "Album", "labels": [{"name": "Soma (2)"}, {"name": "Other"}]}"#,
                Some((Some("Soma"), vec![], 0, false)),
            ),
            (
                "a track without a title is left out",
                r#"{"title": "Album", "tracklist": [{"title": " "}, {"title": "Song"}]}"#,
                Some((None, vec![], 1, false)),
            ),
            (
                "the first picture when none is the main one",
                r#"{"title": "Album", "images": [{"type": "secondary", "uri": "https://i.discogs.com/a.jpeg"}]}"#,
                Some((None, vec![], 0, true)),
            ),
            (
                "a picture with no address",
                r#"{"title": "Album", "images": [{"type": "primary", "uri": ""}]}"#,
                Some((None, vec![], 0, false)),
            ),
            (
                "a year of 0 is no year",
                r#"{"title": "Album", "year": 0}"#,
                Some((None, vec![], 0, false)),
            ),
            ("no title", r#"{"year": 1997}"#, None),
            (
                "a label with no name",
                r#"{"title": "Album", "labels": [{}]}"#,
                None,
            ),
            (
                "tracks that are not a list",
                r#"{"title": "Album", "tracklist": 3}"#,
                None,
            ),
            ("not JSON", "<html>busy</html>", None),
            ("empty", "", None),
        ];
        for (what, answer, expected) in cases {
            let read = parse_page(answer.as_bytes()).ok().map(|page| {
                (
                    page.label,
                    page.genres,
                    page.tracks.len(),
                    page.picture.is_some(),
                )
            });
            let expected =
                expected.map(|(label, genres, tracks, picture): (_, Vec<&str>, _, _)| {
                    (
                        label.map(str::to_owned),
                        genres.into_iter().map(str::to_owned).collect(),
                        tracks,
                        picture,
                    )
                });
            assert_eq!(read, expected, "{what}");
        }
    }

    #[test]
    fn a_search_answer_is_read_and_checked() {
        // Cut down from a real answer.
        let sample = r#"{"pagination": {"page": 1, "pages": 3, "items": 60}, "results": [
            {"id": 27651, "type": "release", "title": "Daft Punk - Homework", "year": "1997",
             "country": "UK", "format": ["Vinyl", "LP", "Album"], "label": ["Virgin"],
             "genre": ["Electronic"], "style": ["House"], "master_id": 26647,
             "thumb": "https://i.discogs.com/thumb.jpeg",
             "cover_image": "https://i.discogs.com/cover.jpeg"}
        ]}"#;
        assert_eq!(
            parse_listing(sample.as_bytes()).expect("parsed"),
            vec![Listed {
                release: HOMEWORK,
                title: "Homework".to_owned(),
                artist: Some("Daft Punk".to_owned()),
                year: Some(Year(1997)),
                country: Some("UK".to_owned()),
                format: Some("Vinyl".to_owned()),
                compilation: false,
                pictured: true,
            }]
        );

        let one = |fields: &str| format!(r#"{{"results": [{{{fields}}}]}}"#);
        // (what, answer, (title, artist, compilation, pictured) of each release; `None` when
        // the whole answer is refused)
        let cases = [
            ("no results", r#"{"results": []}"#.to_owned(), Some(vec![])),
            (
                "only the required fields",
                one(r#""id": 5, "title": "Album""#),
                Some(vec![("Album", None, false, false)]),
            ),
            (
                "a numbered artist spelt another way",
                one(r#""id": 5, "title": "Orbit (3)* - Album - Remixes""#),
                Some(vec![("Album - Remixes", Some("Orbit"), false, false)]),
            ),
            (
                "a compilation with no picture",
                one(
                    r#""id": 5, "title": "Various - Hits", "format": ["CD", "Compilation"],
                       "cover_image": "https://st.discogs.com/images/spacer.gif""#,
                ),
                Some(vec![("Hits", Some("Various"), true, false)]),
            ),
            (
                "a year that is not one",
                one(r#""id": 5, "title": "Album", "year": "unknown""#),
                Some(vec![("Album", None, false, false)]),
            ),
            (
                "an id that is not a number",
                one(r#""id": "../x", "title": "Album""#),
                Some(vec![]),
            ),
            ("no id", one(r#""title": "Album""#), Some(vec![])),
            ("no title", one(r#""id": 5"#), Some(vec![])),
            (
                "an artist with no release name is left out",
                one(r#""id": 5, "title": "Artist - ""#),
                Some(vec![]),
            ),
            (
                "results is not a list",
                r#"{"results": 3}"#.to_owned(),
                None,
            ),
            ("no results key", r#"{"message": "x"}"#.to_owned(), None),
            ("not JSON", "busy".to_owned(), None),
        ];
        for (what, answer, expected) in cases {
            let read = parse_listing(answer.as_bytes()).ok();
            let read = read.as_ref().map(|listed| {
                listed
                    .iter()
                    .map(|l| {
                        (
                            l.title.as_str(),
                            l.artist.as_deref(),
                            l.compilation,
                            l.pictured,
                        )
                    })
                    .collect::<Vec<_>>()
            });
            assert_eq!(read, expected, "{what}");
        }
    }

    #[test]
    fn a_page_gives_the_track_named_like_the_song() {
        let page = parse_page(PAGE.as_bytes()).expect("parsed");
        let found = page.song(HOMEWORK, "Around the World").expect("found");
        assert_eq!(
            found.recording,
            RecordingId::Discogs {
                release: HOMEWORK,
                track: 1
            }
        );
        assert_eq!(found.title, "Around The World");
        assert_eq!(found.artists, ["Daft Punk"]);
        assert_eq!(found.duration_ms, Some(429_000));
        let release = &found.releases[0];
        assert_eq!(release.id, ReleaseId::Discogs(HOMEWORK));
        assert_eq!((release.track, release.track_total), (Some(7), Some(2)));
        assert!(release.pictured);

        assert_eq!(page.song(HOMEWORK, "One More Time"), None);
    }

    #[test]
    fn a_track_by_its_own_artists_is_credited_to_them() {
        let page = parse_page(
            br#"{"title": "Hits", "artists": [{"name": "Various"}], "tracklist": [
                {"title": "Song", "artists": [{"name": "Orbit (3)"}, {"name": "Guest*"}]}
            ]}"#,
        )
        .expect("parsed");
        let found = page.song(HOMEWORK, "Song").expect("found");
        assert_eq!(found.artists, ["Orbit", "Guest"]);
        assert_eq!(found.releases[0].album_artists, ["Various"]);
    }

    #[test]
    fn names_lose_what_discogs_adds() {
        let cases = [
            ("Daft Punk", "Daft Punk"),
            ("Orbit (3)", "Orbit"),
            ("Orbit (3)*", "Orbit"),
            ("Guest*", "Guest"),
            ("  Spaced  ", "Spaced"),
            ("Sixty (60)", "Sixty"),
            ("The Band (UK)", "The Band (UK)"),
            ("Song (2) Name", "Song (2) Name"),
            ("(3)", "(3)"),
            ("Name ()", "Name ()"),
            ("", ""),
        ];
        for (written, expected) in cases {
            assert_eq!(plain_name(written), expected, "{written:?}");
        }
    }

    #[test]
    fn lengths_are_read() {
        let cases = [
            ("7:09", Some(429_000)),
            ("0:30", Some(30_000)),
            (" 3:00 ", Some(180_000)),
            ("1:02:03", Some(3_723_000)),
            ("", None),
            ("0:00", None),
            ("709", None),
            ("7:xx", None),
            ("-7:09", None),
            ("7:09:00:00", None),
            (":", None),
            ("99999999999999999999:00", None),
        ];
        for (written, expected) in cases {
            assert_eq!(length(written), expected, "{written:?}");
        }
    }

    #[test]
    fn only_pictures_discogs_serves_are_fetched() {
        let cases = [
            ("https://i.discogs.com/front.jpeg", true),
            ("https://discogs.com/front.jpeg", true),
            ("https://img.discogs.com/a/b.jpg?x=1", true),
            ("http://i.discogs.com/front.jpeg", false),
            ("https://discogs.com.example.org/front.jpeg", false),
            ("https://notdiscogs.com/front.jpeg", false),
            ("https://example.org/i.discogs.com/front.jpeg", false),
            ("file:///etc/passwd", false),
            ("front.jpeg", false),
            ("", false),
        ];
        for (address, fetched) in cases {
            assert_eq!(picture_url(address).is_some(), fetched, "{address:?}");
        }
    }

    #[test]
    fn tokens_are_checked() {
        let cases = [
            ("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd", true),
            ("  padded123  ", true),
            ("", false),
            ("   ", false),
            ("two words", false),
            ("quote\"d", false),
            ("line\nbreak", false),
            ("dash-ed", false),
            ("ünï", false),
        ];
        for (raw, accepted) in cases {
            assert_eq!(Token::parse(raw).is_ok(), accepted, "{raw:?}");
        }
    }

    #[test]
    fn searches_send_the_artist_with_the_song_or_the_album() {
        let song = song_search_url(&SearchTerms {
            title: "Around the World".to_owned(),
            artist: "Daft Punk & Co".to_owned(),
        })
        .expect("url");
        let album = release_search_url(&ReleaseTerms {
            album: "Homework".to_owned(),
            artist: "Daft Punk".to_owned(),
        })
        .expect("url");
        let pairs =
            |url: &Url| -> Vec<(String, String)> { url.query_pairs().into_owned().collect() };
        let pair = |name: &str, value: &str| (name.to_owned(), value.to_owned());
        assert_eq!(song.path(), "/database/search");
        assert_eq!(
            pairs(&song),
            vec![
                pair("type", "release"),
                pair("artist", "Daft Punk & Co"),
                pair("track", "Around the World"),
                pair("per_page", "5"),
            ]
        );
        assert_eq!(
            pairs(&album),
            vec![
                pair("type", "release"),
                pair("artist", "Daft Punk"),
                pair("release_title", "Homework"),
                pair("per_page", "25"),
            ]
        );
        assert_eq!(
            page_url(HOMEWORK).expect("url").as_str(),
            "https://api.discogs.com/releases/27651"
        );
    }

    #[test]
    fn a_release_of_another_source_is_not_asked_for() {
        let theirs =
            ReleaseId::try_from("170d8783-40b3-4b0b-879d-0ef6055dfeb3".to_owned()).expect("id");
        assert!(own(&theirs).is_err());
        assert_eq!(own(&ReleaseId::Discogs(HOMEWORK)).ok(), Some(HOMEWORK));
    }
}
