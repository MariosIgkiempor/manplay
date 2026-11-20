//! A Jellyfin server that scans a destination: where it is, its API key (in the OS keychain),
//! and the calls manplay makes to it. Songs reach Jellyfin as files on the destination; only
//! playlists go through this API (see `docs/plans/shared-library/08-jellyfin-playlists.md`).

pub mod matching;
pub mod push;

use std::time::Duration;

use reqwest::{Client, Method, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::Error;

const KEYCHAIN_SERVICE: &str = "manplay-jellyfin";

/// A slow server answers within this; past it the call fails instead of hanging the page.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// A server's base address, e.g. `http://nas:8096` or `https://example.com/jellyfin`, with no
/// trailing slash.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ServerUrl(String);

impl ServerUrl {
    /// Accepts what people type: a missing scheme means `http://`, a trailing slash is dropped.
    pub fn parse(raw: &str) -> Result<Self, Error> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err(Error::Msg("enter the Jellyfin server address".to_owned()));
        }
        let with_scheme = if raw.contains("://") {
            raw.to_owned()
        } else {
            format!("http://{raw}")
        };
        let invalid = || Error::Msg(format!("not a server address: {raw}"));
        let url = Url::parse(&with_scheme).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(Error::Msg(
                "the server address must start with http:// or https://".to_owned(),
            ));
        }
        if url.host_str().is_none_or(str::is_empty)
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
        {
            return Err(invalid());
        }
        Ok(Self(url.as_str().trim_end_matches('/').to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The stored address, as saved by [`ServerUrl::parse`].
    pub fn from_stored(stored: String) -> Self {
        Self(stored)
    }
}

/// An API key made in Jellyfin's Dashboard → API Keys. Never serialised: it only lives in the
/// keychain and in request headers.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey(String);

impl ApiKey {
    pub fn parse(raw: &str) -> Result<Self, Error> {
        let key = raw.trim();
        if key.is_empty() {
            return Err(Error::Msg("enter the Jellyfin API key".to_owned()));
        }
        // It goes inside a quoted header value.
        if key
            .chars()
            .any(|c| c == '"' || c == '\\' || c.is_whitespace() || c.is_control())
        {
            return Err(Error::Msg("that is not a Jellyfin API key".to_owned()));
        }
        Ok(Self(key.to_owned()))
    }
}

impl std::fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApiKey(…)")
    }
}

/// A Jellyfin user's id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UserId(pub String);

/// A Jellyfin library's id (`ItemId` of a virtual folder).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LibraryId(pub String);

/// A song's id in Jellyfin. Kept apart from playlist ids: deleting an item by id deletes its file.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AudioId(pub String);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: UserId,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub id: LibraryId,
    pub name: String,
    /// Folders the library scans, as paths on the server.
    pub locations: Vec<String>,
}

/// What a server offers, read with its API key: shown while choosing the user and library.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub name: String,
    pub version: String,
    pub users: Vec<User>,
    /// Libraries that can hold songs (music and mixed ones).
    pub libraries: Vec<Library>,
}

/// The Jellyfin server saved for a destination.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub url: ServerUrl,
    pub server_name: String,
    pub user: User,
    /// The library that scans the destination.
    pub library: LibraryRef,
    /// Who else sees the playlists manplay makes.
    pub visibility: Visibility,
}

/// Who sees the playlists manplay makes, besides the user they belong to.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Visibility {
    #[default]
    OnlyMe,
    /// Every user on the server (`IsPublic`).
    Everyone,
    /// These users, who can play but not edit them.
    Users { users: Vec<UserId> },
}

impl Visibility {
    /// The same choice in a stable form: users sorted and once each, the owner left out (they
    /// see their playlists anyway), and an empty list meaning only the owner.
    #[must_use]
    pub fn normalised(self, owner: &UserId) -> Self {
        match self {
            Self::Users { users } => {
                let mut users: Vec<UserId> = users.into_iter().filter(|u| u != owner).collect();
                users.sort_by(|a, b| a.0.cmp(&b.0));
                users.dedup();
                if users.is_empty() {
                    Self::OnlyMe
                } else {
                    Self::Users { users }
                }
            }
            other => other,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRef {
    pub id: LibraryId,
    pub name: String,
}

// ---- server replies ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawSystemInfo {
    server_name: Option<String>,
    version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawUser {
    id: UserId,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawVirtualFolder {
    name: String,
    item_id: Option<LibraryId>,
    collection_type: Option<String>,
    #[serde(default)]
    locations: Vec<String>,
}

/// Music libraries, and mixed ones (no type), can hold songs; films, shows, books and the like
/// cannot.
fn holds_songs(collection_type: Option<&str>) -> bool {
    matches!(collection_type, None | Some("music" | "mixed" | ""))
}

fn libraries_from(folders: Vec<RawVirtualFolder>) -> Vec<Library> {
    folders
        .into_iter()
        .filter(|f| holds_songs(f.collection_type.as_deref()))
        .filter_map(|f| {
            Some(Library {
                id: f.item_id?,
                name: f.name,
                locations: f.locations,
            })
        })
        .collect()
}

fn parse<T: DeserializeOwned>(bytes: &[u8], what: &str) -> Result<T, Error> {
    serde_json::from_slice(bytes)
        .map_err(|e| Error::Msg(format!("Jellyfin sent an unexpected {what} reply: {e}")))
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawItemsPage {
    #[serde(default)]
    items: Vec<RawAudio>,
    total_record_count: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawAudio {
    id: AudioId,
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawPlaylistPage {
    #[serde(default)]
    items: Vec<RawPlaylist>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawPlaylist {
    id: PlaylistId,
    name: String,
    child_count: Option<usize>,
}

/// A playlist already on the server.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPlaylist {
    pub id: PlaylistId,
    pub name: String,
    pub songs: usize,
}

/// A Jellyfin playlist's id. Its own type, so only a playlist id can reach
/// [`Jellyfin::delete_playlist`].
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PlaylistId(pub String);

/// One place in a playlist (`PlaylistItemId`): the same song twice has two.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EntryId(pub String);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub entry: EntryId,
    pub song: AudioId,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawEntryPage {
    #[serde(default)]
    items: Vec<RawEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawEntry {
    id: AudioId,
    playlist_item_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct CreatePlaylist<'a> {
    name: &'a str,
    ids: &'a [AudioId],
    user_id: &'a UserId,
    media_type: &'a str,
    is_public: bool,
    users: Vec<PlaylistUser<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct PlaylistUser<'a> {
    user_id: &'a UserId,
    can_edit: bool,
}

fn create_body<'a>(
    name: &'a str,
    songs: &'a [AudioId],
    owner: &'a UserId,
    visibility: &'a Visibility,
) -> CreatePlaylist<'a> {
    let users = match visibility {
        Visibility::Users { users } => users
            .iter()
            .map(|user_id| PlaylistUser {
                user_id,
                can_edit: false,
            })
            .collect(),
        Visibility::OnlyMe | Visibility::Everyone => Vec::new(),
    };
    CreatePlaylist {
        name,
        ids: songs,
        user_id: owner,
        media_type: "Audio",
        is_public: matches!(visibility, Visibility::Everyone),
        users,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct MediaUpdates<'a> {
    updates: Vec<MediaUpdate<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct MediaUpdate<'a> {
    path: &'a str,
    update_type: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawCreated {
    id: PlaylistId,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawKindPage {
    #[serde(default)]
    items: Vec<RawKind>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawKind {
    id: String,
    #[serde(rename = "Type")]
    kind: Option<String>,
}

/// Exactly one item came back, it has this id, and the server calls it a playlist.
fn is_only_this_playlist(items: &[RawKind], playlist: &PlaylistId) -> bool {
    matches!(items, [only] if only.id == playlist.0 && only.kind.as_deref() == Some("Playlist"))
}

/// Ids put in one request's address.
const IDS_PER_REQUEST: usize = 50;

/// Ids come from the server; this keeps a strange one from changing the path.
fn path_segment(id: &str) -> String {
    percent_encoding::utf8_percent_encode(id, percent_encoding::NON_ALPHANUMERIC).to_string()
}

/// Songs read per request.
const ITEMS_PAGE: usize = 1000;

// ---- calls -------------------------------------------------------------------------------------

/// One server, reached with one API key.
pub struct Jellyfin<'a> {
    http: &'a Client,
    url: &'a ServerUrl,
    key: &'a ApiKey,
}

impl<'a> Jellyfin<'a> {
    pub fn new(http: &'a Client, url: &'a ServerUrl, key: &'a ApiKey) -> Self {
        Self { http, url, key }
    }

    async fn get(&self, path: &str, what: &str) -> Result<Vec<u8>, Error> {
        self.get_with(path, &[], what).await
    }

    /// A GET with query parameters, encoded.
    async fn get_with(
        &self,
        path: &str,
        query: &[(&str, &str)],
        what: &str,
    ) -> Result<Vec<u8>, Error> {
        self.request(Method::GET, path, query, None, what).await
    }

    /// One call to the server; `body` is sent as JSON.
    async fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<Vec<u8>>,
        what: &str,
    ) -> Result<Vec<u8>, Error> {
        let mut url = Url::parse(&format!("{}{path}", self.url.as_str()))
            .map_err(|e| Error::Msg(format!("Jellyfin address: {e}")))?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let mut request = self
            .http
            .request(method, url)
            .header(
                "Authorization",
                format!("MediaBrowser Token=\"{}\"", self.key.0),
            )
            .header("Accept", "application/json")
            .timeout(REQUEST_TIMEOUT);
        if let Some(body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(body);
        }
        let resp = request.send().await.map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                Error::Msg(format!(
                    "Jellyfin at {} is not answering",
                    self.url.as_str()
                ))
            } else {
                Error::Http(e)
            }
        })?;
        match resp.status() {
            s if s.is_success() => Ok(resp.bytes().await?.to_vec()),
            StatusCode::UNAUTHORIZED => {
                Err(Error::Msg("Jellyfin did not accept the API key".to_owned()))
            }
            StatusCode::FORBIDDEN => Err(Error::Msg(
                "the API key cannot read the server's libraries: make it in Dashboard → API Keys"
                    .to_owned(),
            )),
            s => Err(Error::Msg(format!("Jellyfin {what}: {s}"))),
        }
    }

    /// The songs of one playlist in order, with each entry's own id (needed to take it out).
    pub async fn playlist_entries(
        &self,
        playlist: &PlaylistId,
        user: &UserId,
    ) -> Result<Vec<Entry>, Error> {
        let page: RawEntryPage = parse(
            &self
                .get_with(
                    &format!("/Playlists/{}/Items", path_segment(&playlist.0)),
                    &[
                        ("userId", user.0.as_str()),
                        ("enableImages", "false"),
                        ("enableUserData", "false"),
                    ],
                    "playlist songs",
                )
                .await?,
            "playlist songs",
        )?;
        Ok(page
            .items
            .into_iter()
            .filter_map(|e| {
                Some(Entry {
                    entry: EntryId(e.playlist_item_id?),
                    song: e.id,
                })
            })
            .collect())
    }

    /// The folders a library scans, as paths on the server.
    pub async fn library_locations(&self, library: &LibraryId) -> Result<Vec<String>, Error> {
        let folders: Vec<RawVirtualFolder> = parse(
            &self.get("/Library/VirtualFolders", "libraries").await?,
            "libraries",
        )?;
        Ok(folders
            .into_iter()
            .find(|f| f.item_id.as_ref() == Some(library))
            .map(|f| f.locations)
            .unwrap_or_default())
    }

    /// Tells Jellyfin these files are new, so it scans them now instead of at its next scan.
    pub async fn report_new_files(&self, paths: &[String]) -> Result<(), Error> {
        for chunk in paths.chunks(200) {
            let updates: Vec<MediaUpdate> = chunk
                .iter()
                .map(|path| MediaUpdate {
                    path,
                    update_type: "Created",
                })
                .collect();
            let body = serde_json::to_vec(&MediaUpdates { updates })
                .map_err(|e| Error::Msg(e.to_string()))?;
            self.request(
                Method::POST,
                "/Library/Media/Updated",
                &[],
                Some(body),
                "new files",
            )
            .await?;
        }
        Ok(())
    }

    /// Makes a playlist for the user with these songs, in order.
    pub async fn create_playlist(
        &self,
        name: &str,
        songs: &[AudioId],
        user: &UserId,
        visibility: &Visibility,
    ) -> Result<PlaylistId, Error> {
        let body = serde_json::to_vec(&create_body(name, songs, user, visibility))
            .map_err(|e| Error::Msg(e.to_string()))?;
        let reply: RawCreated = parse(
            &self
                .request(Method::POST, "/Playlists", &[], Some(body), "new playlist")
                .await?,
            "new playlist",
        )?;
        Ok(reply.id)
    }

    /// Adds songs to the end of a playlist, a few per request so the address stays short.
    pub async fn add_songs(
        &self,
        playlist: &PlaylistId,
        songs: &[AudioId],
        user: &UserId,
    ) -> Result<(), Error> {
        for chunk in songs.chunks(IDS_PER_REQUEST) {
            let ids = chunk
                .iter()
                .map(|s| s.0.as_str())
                .collect::<Vec<_>>()
                .join(",");
            self.request(
                Method::POST,
                &format!("/Playlists/{}/Items", path_segment(&playlist.0)),
                &[("ids", &ids), ("userId", user.0.as_str())],
                None,
                "adding songs",
            )
            .await?;
        }
        Ok(())
    }

    /// Takes entries out of a playlist. The songs themselves stay on the server.
    pub async fn remove_entries(
        &self,
        playlist: &PlaylistId,
        entries: &[EntryId],
    ) -> Result<(), Error> {
        for chunk in entries.chunks(IDS_PER_REQUEST) {
            let ids = chunk
                .iter()
                .map(|e| e.0.as_str())
                .collect::<Vec<_>>()
                .join(",");
            self.request(
                Method::DELETE,
                &format!("/Playlists/{}/Items", path_segment(&playlist.0)),
                &[("entryIds", &ids)],
                None,
                "removing songs",
            )
            .await?;
        }
        Ok(())
    }

    /// Deletes a playlist. Jellyfin's delete removes any item *and its file*, so the server is
    /// first asked what the id is, and nothing happens unless it is exactly this one playlist.
    pub async fn delete_playlist(&self, playlist: &PlaylistId, user: &UserId) -> Result<(), Error> {
        let found: RawKindPage = parse(
            &self
                .get_with(
                    "/Items",
                    &[
                        ("ids", playlist.0.as_str()),
                        ("userId", user.0.as_str()),
                        ("recursive", "true"),
                        ("enableImages", "false"),
                        ("enableUserData", "false"),
                    ],
                    "checking a playlist",
                )
                .await?,
            "checking a playlist",
        )?;
        if !is_only_this_playlist(&found.items, playlist) {
            return Err(Error::Msg(format!(
                "Jellyfin item {} is not a playlist; it was not deleted",
                playlist.0
            )));
        }
        self.request(
            Method::DELETE,
            &format!("/Items/{}", path_segment(&playlist.0)),
            &[],
            None,
            "deleting a playlist",
        )
        .await?;
        Ok(())
    }

    /// The user's playlists on the server, by name, with how many songs each holds.
    pub async fn playlists(&self, user: &UserId) -> Result<Vec<ServerPlaylist>, Error> {
        let page: RawPlaylistPage = parse(
            &self
                .get_with(
                    "/Items",
                    &[
                        ("userId", user.0.as_str()),
                        ("recursive", "true"),
                        ("includeItemTypes", "Playlist"),
                        ("fields", "ChildCount"),
                        ("sortBy", "SortName"),
                        ("enableImages", "false"),
                        ("enableUserData", "false"),
                    ],
                    "playlists",
                )
                .await?,
            "playlists",
        )?;
        Ok(page
            .items
            .into_iter()
            .map(|p| ServerPlaylist {
                id: p.id,
                name: p.name,
                songs: p.child_count.unwrap_or(0),
            })
            .collect())
    }

    /// Every song in a library, with its path on the server, read a page at a time.
    pub async fn audio_items(
        &self,
        library: &LibraryId,
        user: &UserId,
    ) -> Result<Vec<matching::ServerItem>, Error> {
        let mut items = Vec::new();
        let mut offset = 0;
        let page_size = ITEMS_PAGE.to_string();
        loop {
            let start = offset.to_string();
            let page: RawItemsPage = parse(
                &self
                    .get_with(
                        "/Items",
                        &[
                            ("parentId", library.0.as_str()),
                            ("userId", user.0.as_str()),
                            ("recursive", "true"),
                            ("includeItemTypes", "Audio"),
                            ("fields", "Path"),
                            ("enableImages", "false"),
                            ("enableUserData", "false"),
                            ("sortBy", "SortName"),
                            ("startIndex", &start),
                            ("limit", &page_size),
                        ],
                        "songs",
                    )
                    .await?,
                "songs",
            )?;
            let count = page.items.len();
            offset += count;
            items.extend(page.items.into_iter().filter_map(|i| {
                Some(matching::ServerItem {
                    id: i.id,
                    path: i.path?,
                })
            }));
            if count < ITEMS_PAGE || page.total_record_count.is_some_and(|t| offset >= t) {
                return Ok(items);
            }
        }
    }

    /// The server's name and version, its users and the libraries that can hold songs.
    pub async fn server(&self) -> Result<Server, Error> {
        let info: RawSystemInfo = parse(&self.get("/System/Info", "server info").await?, "info")?;
        let users: Vec<RawUser> = parse(&self.get("/Users", "users").await?, "users")?;
        let folders: Vec<RawVirtualFolder> = parse(
            &self.get("/Library/VirtualFolders", "libraries").await?,
            "libraries",
        )?;
        Ok(Server {
            name: info.server_name.unwrap_or_else(|| "Jellyfin".to_owned()),
            version: info.version.unwrap_or_default(),
            users: users
                .into_iter()
                .map(|u| User {
                    id: u.id,
                    name: u.name,
                })
                .collect(),
            libraries: libraries_from(folders),
        })
    }
}

// ---- keychain ----------------------------------------------------------------------------------

fn cache() -> &'static std::sync::Mutex<std::collections::HashMap<i64, String>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<i64, String>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn entry(target_id: i64) -> Result<keyring::Entry, Error> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &format!("target-{target_id}"))
        .map_err(|e| Error::Msg(format!("keychain: {e}")))
}

pub fn save_key(target_id: i64, key: &ApiKey) -> Result<(), Error> {
    entry(target_id)?
        .set_password(&key.0)
        .map_err(|e| Error::Msg(format!("keychain: {e}")))?;
    if let Ok(mut c) = cache().lock() {
        c.insert(target_id, key.0.clone());
    }
    Ok(())
}

pub fn load_key(target_id: i64) -> Result<ApiKey, Error> {
    // Read the keychain once per launch; macOS prompts on every read otherwise.
    if let Some(key) = cache().lock().ok().and_then(|c| c.get(&target_id).cloned()) {
        return Ok(ApiKey(key));
    }
    let stored = entry(target_id)?.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => {
            Error::Msg("no Jellyfin API key saved: enter it again".to_owned())
        }
        e => Error::Msg(format!("keychain: {e}")),
    })?;
    if let Ok(mut c) = cache().lock() {
        c.insert(target_id, stored.clone());
    }
    Ok(ApiKey(stored))
}

pub fn forget_key(target_id: i64) {
    if let Ok(mut c) = cache().lock() {
        c.remove(&target_id);
    }
    if let Ok(e) = entry(target_id) {
        let _ = e.delete_credential();
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    #[test]
    fn server_addresses_are_read_as_typed() {
        let cases = [
            ("nas:8096", Some("http://nas:8096")),
            ("  http://nas:8096/  ", Some("http://nas:8096")),
            (
                "https://music.example.com/jellyfin/",
                Some("https://music.example.com/jellyfin"),
            ),
            ("http://100.64.0.1:8096", Some("http://100.64.0.1:8096")),
            ("nas.tail1234.ts.net", Some("http://nas.tail1234.ts.net")),
            ("", None),
            ("   ", None),
            ("ftp://nas", None),
            ("http://", None),
            ("http://nas:8096/?x=1", None),
            ("http://nas:8096/#top", None),
            ("http://me:pw@nas:8096", None),
            ("http://nas:99999", None),
        ];
        for (raw, expected) in cases {
            let parsed = ServerUrl::parse(raw).ok();
            assert_eq!(parsed.as_ref().map(ServerUrl::as_str), expected, "{raw:?}");
        }
    }

    #[test]
    fn api_keys_are_checked() {
        let cases = [
            ("0123456789abcdef0123456789abcdef", true),
            ("  0123456789abcdef  ", true),
            ("", false),
            ("   ", false),
            ("abc def", false),
            ("abc\"def", false),
            ("abc\\def", false),
            ("abc\ndef", false),
        ];
        for (raw, ok) in cases {
            assert_eq!(ApiKey::parse(raw).is_ok(), ok, "{raw:?}");
        }
    }

    #[test]
    fn api_keys_stay_out_of_debug_output() {
        let key = ApiKey::parse("secret123").expect("key");
        assert!(!format!("{key:?}").contains("secret123"));
    }

    #[test]
    fn libraries_that_hold_songs_are_kept() {
        let cases = [
            (Some("music"), true),
            (Some("mixed"), true),
            (None, true),
            (Some("movies"), false),
            (Some("tvshows"), false),
            (Some("books"), false),
            (Some("musicvideos"), false),
            (Some("playlists"), false),
        ];
        for (kind, kept) in cases {
            assert_eq!(holds_songs(kind), kept, "{kind:?}");
        }
    }

    /// Shapes as Jellyfin 12.4.0 sends them (trimmed to the fields manplay reads plus a few it
    /// ignores).
    #[test]
    fn server_replies_parse() {
        let info: RawSystemInfo = parse(
            br#"{"LocalAddress":"http://192.168.1.2:8096","ServerName":"nas","Version":"12.4.0",
                "Id":"f2c1e4a0b6b84f5c9d3e2a1b0c9d8e7f","OperatingSystem":"Darwin"}"#,
            "info",
        )
        .expect("info");
        assert_eq!(info.server_name.as_deref(), Some("nas"));
        assert_eq!(info.version.as_deref(), Some("12.4.0"));

        let users: Vec<RawUser> = parse(
            br#"[{"Name":"mario","ServerId":"f2c1","Id":"5d3a9c1e2b7f4e8a9c0d1e2f3a4b5c6d",
                 "HasPassword":true,"Policy":{"IsAdministrator":true}}]"#,
            "users",
        )
        .expect("users");
        assert_eq!(users[0].name, "mario");
        assert_eq!(
            users[0].id,
            UserId("5d3a9c1e2b7f4e8a9c0d1e2f3a4b5c6d".to_owned())
        );

        let folders: Vec<RawVirtualFolder> = parse(
            br#"[{"Name":"Music","Locations":["/Volumes/KINGSTON/media/music"],
                  "CollectionType":"music","ItemId":"7e64e319657a9516ec78490da03edccb",
                  "RefreshStatus":"Idle","LibraryOptions":{}},
                 {"Name":"Films","Locations":["/Volumes/KINGSTON/media/films"],
                  "CollectionType":"movies","ItemId":"f137a2dd21bbc1b99aa5c0f6bf02a805"},
                 {"Name":"Mixed","Locations":[],"ItemId":"0c41907140d802bb58430fed7e2cd79e"},
                 {"Name":"Broken","CollectionType":"music"}]"#,
            "libraries",
        )
        .expect("libraries");
        let libraries = libraries_from(folders);
        assert_eq!(
            libraries,
            vec![
                Library {
                    id: LibraryId("7e64e319657a9516ec78490da03edccb".to_owned()),
                    name: "Music".to_owned(),
                    locations: vec!["/Volumes/KINGSTON/media/music".to_owned()],
                },
                Library {
                    id: LibraryId("0c41907140d802bb58430fed7e2cd79e".to_owned()),
                    name: "Mixed".to_owned(),
                    locations: vec![],
                },
            ]
        );
    }

    #[test]
    fn song_pages_parse() {
        let page: RawItemsPage = parse(
            br#"{"Items":[
                  {"Name":"'95 Jazz Lick","Id":"9a1b","Type":"Audio",
                   "Path":"/Volumes/KINGSTON/media/music/Sub Code Records/Lavery - '95 Jazz Lick.mp3"},
                  {"Name":"No path","Id":"9a1c","Type":"Audio"}],
                "TotalRecordCount":2,"StartIndex":0}"#,
            "songs",
        )
        .expect("page");
        assert_eq!(page.total_record_count, Some(2));
        assert_eq!(page.items[0].id, AudioId("9a1b".to_owned()));
        assert!(
            page.items[0]
                .path
                .as_deref()
                .is_some_and(|p| p.ends_with("Jazz Lick.mp3"))
        );
        assert_eq!(page.items[1].path, None);
    }

    #[test]
    fn playlist_pages_parse() {
        let page: RawPlaylistPage = parse(
            br#"{"Items":[{"Name":"manplay test","Id":"p1","Type":"Playlist","ChildCount":2},
                          {"Name":"Empty","Id":"p2","Type":"Playlist"}],"TotalRecordCount":2}"#,
            "playlists",
        )
        .expect("page");
        assert_eq!(page.items[0].name, "manplay test");
        assert_eq!(page.items[0].id, PlaylistId("p1".to_owned()));
        assert_eq!(page.items[0].child_count, Some(2));
        assert_eq!(page.items[1].child_count, None);
    }

    #[test]
    fn only_a_playlist_with_that_id_may_be_deleted() {
        let kind = |id: &str, kind: Option<&str>| RawKind {
            id: id.to_owned(),
            kind: kind.map(str::to_owned),
        };
        let playlist = PlaylistId("p1".to_owned());
        let cases = [
            ("the playlist", vec![kind("p1", Some("Playlist"))], true),
            (
                "a song with that id",
                vec![kind("p1", Some("Audio"))],
                false,
            ),
            ("no type", vec![kind("p1", None)], false),
            (
                "another playlist",
                vec![kind("p2", Some("Playlist"))],
                false,
            ),
            ("nothing found", vec![], false),
            (
                "more than one",
                vec![kind("p1", Some("Playlist")), kind("p1", Some("Playlist"))],
                false,
            ),
        ];
        for (name, items, ok) in cases {
            assert_eq!(is_only_this_playlist(&items, &playlist), ok, "{name}");
        }
    }

    #[test]
    fn entries_and_new_playlists_parse() {
        let page: RawEntryPage = parse(
            br#"{"Items":[{"Name":"x","Id":"s1","PlaylistItemId":"e1","Type":"Audio"},
                          {"Name":"y","Id":"s2","Type":"Audio"}]}"#,
            "playlist songs",
        )
        .expect("entries");
        assert_eq!(page.items[0].playlist_item_id.as_deref(), Some("e1"));
        assert_eq!(page.items[1].playlist_item_id, None);
        let created: RawCreated = parse(br#"{"Id":"p9"}"#, "new playlist").expect("created");
        assert_eq!(created.id, PlaylistId("p9".to_owned()));
    }

    #[test]
    fn new_playlists_carry_who_sees_them() {
        let owner = UserId("u1".to_owned());
        let songs = [AudioId("s1".to_owned())];
        let cases = [
            (
                Visibility::OnlyMe,
                r#"{"Name":"House","Ids":["s1"],"UserId":"u1","MediaType":"Audio","IsPublic":false,"Users":[]}"#,
            ),
            (
                Visibility::Everyone,
                r#"{"Name":"House","Ids":["s1"],"UserId":"u1","MediaType":"Audio","IsPublic":true,"Users":[]}"#,
            ),
            (
                Visibility::Users {
                    users: vec![UserId("u2".to_owned())],
                },
                r#"{"Name":"House","Ids":["s1"],"UserId":"u1","MediaType":"Audio","IsPublic":false,"Users":[{"UserId":"u2","CanEdit":false}]}"#,
            ),
        ];
        for (visibility, expected) in cases {
            let body = serde_json::to_string(&create_body("House", &songs, &owner, &visibility))
                .expect("json");
            assert_eq!(body, expected, "{visibility:?}");
        }
    }

    #[test]
    fn visibility_is_stored_in_one_form() {
        let owner = UserId("me".to_owned());
        let users = |ids: &[&str]| Visibility::Users {
            users: ids.iter().map(|i| UserId((*i).to_owned())).collect(),
        };
        let cases = [
            (Visibility::OnlyMe, Visibility::OnlyMe),
            (Visibility::Everyone, Visibility::Everyone),
            (users(&["b", "a", "b"]), users(&["a", "b"])),
            (users(&["me", "a"]), users(&["a"])),
            (users(&["me"]), Visibility::OnlyMe),
            (users(&[]), Visibility::OnlyMe),
        ];
        for (given, expected) in cases {
            assert_eq!(given.clone().normalised(&owner), expected, "{given:?}");
        }
    }

    #[test]
    fn visibility_reads_as_the_page_sends_it() {
        let cases = [
            (r#"{"kind":"onlyMe"}"#, Some(Visibility::OnlyMe)),
            (r#"{"kind":"everyone"}"#, Some(Visibility::Everyone)),
            (
                r#"{"kind":"users","users":["u2"]}"#,
                Some(Visibility::Users {
                    users: vec![UserId("u2".to_owned())],
                }),
            ),
            (r#"{"kind":"users"}"#, None),
            (r#"{"kind":"public"}"#, None),
            (r#""everyone""#, None),
        ];
        for (json, expected) in cases {
            assert_eq!(
                serde_json::from_str::<Visibility>(json).ok(),
                expected,
                "{json}"
            );
        }
    }

    #[test]
    fn unexpected_replies_are_errors() {
        let cases: [&[u8]; 4] = [
            b"",
            b"<html>",
            br#"{"Name":"x"}"#,
            br#"[{"Id":1,"Name":"x"}]"#,
        ];
        for bytes in cases {
            assert!(parse::<Vec<RawUser>>(bytes, "users").is_err(), "{bytes:?}");
        }
    }
}
