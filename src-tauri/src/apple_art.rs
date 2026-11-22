//! Covers for songs bought from Apple. Their `.m4a` files often carry no picture (Music keeps
//! the artwork in its own cache), but every one carries the album's id in Apple's catalogue (the
//! `plID` atom), and Apple's public lookup gives the album's official cover for that id. Only the
//! id is sent. Behind the `appleCovers` service switch, off until switched on.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use crate::error::Error;

/// The service switch that allows asking Apple for covers.
pub const SERVICE: &str = "appleCovers";

/// Lookups name this many albums at once.
const PER_REQUEST: usize = 100;
/// Side of the cover asked for, in pixels; Apple scales its master to it.
const SIZE: u32 = 1000;

/// An album's id in Apple's catalogue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AlbumId(pub u64);

/// The album id a bought song carries: the value of its `plID` atom
/// (`size "plID" size "data" type locale value`, the value a big-endian u64).
pub fn album_id(file: &[u8]) -> Option<AlbumId> {
    let at = file.windows(4).position(|w| w == b"plID")?;
    let data = file.get(at + 8..at + 12)?;
    if data != b"data" {
        return None;
    }
    let value: [u8; 8] = file.get(at + 20..at + 28)?.try_into().ok()?;
    let id = u64::from_be_bytes(value);
    (id > 0).then_some(AlbumId(id))
}

/// Whether the file carries a cover picture of its own (an `.m4a`'s `covr` atom).
pub fn has_cover(file: &[u8]) -> bool {
    file.windows(4).any(|w| w == b"covr")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lookup {
    results: Vec<Album>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Album {
    collection_id: Option<u64>,
    artwork_url100: Option<String>,
}

/// Apple's 100-pixel artwork address asked for at [`SIZE`] instead.
fn sized(url: &str) -> String {
    url.replace("100x100bb", &format!("{SIZE}x{SIZE}bb"))
}

/// Each album's cover, as image bytes. Albums Apple does not know, or whose cover could not be
/// fetched, are left out: a song without a cover is no worse than before.
pub async fn covers(
    client: &reqwest::Client,
    ids: &HashSet<AlbumId>,
) -> Result<HashMap<AlbumId, Vec<u8>>, Error> {
    let ids: Vec<AlbumId> = ids.iter().copied().collect();
    let mut out = HashMap::new();
    for chunk in ids.chunks(PER_REQUEST) {
        let list = chunk
            .iter()
            .map(|id| id.0.to_string())
            .collect::<Vec<_>>()
            .join(",");
        // Ids are digits and commas, so they need no escaping.
        let found: Lookup = client
            .get(format!(
                "https://itunes.apple.com/lookup?id={list}&entity=album"
            ))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        for album in found.results {
            let (Some(id), Some(url)) = (album.collection_id, album.artwork_url100) else {
                continue;
            };
            let Ok(response) = client.get(sized(&url)).send().await else {
                continue;
            };
            if let Ok(bytes) = response.error_for_status().map(reqwest::Response::bytes)
                && let Ok(bytes) = bytes.await
            {
                out.insert(AlbumId(id), bytes.to_vec());
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `plID` atom as Music writes it, with `value` as the album id.
    fn pl_id(value: u64) -> Vec<u8> {
        let mut atom = Vec::new();
        atom.extend_from_slice(&32u32.to_be_bytes());
        atom.extend_from_slice(b"plID");
        atom.extend_from_slice(&24u32.to_be_bytes());
        atom.extend_from_slice(b"data");
        atom.extend_from_slice(&[0, 0, 0, 0x15, 0, 0, 0, 0]);
        atom.extend_from_slice(&value.to_be_bytes());
        atom
    }

    #[test]
    fn album_ids_are_read_from_the_pl_id_atom() {
        let mut file = b"....ftypM4A ....moov....".to_vec();
        file.extend(pl_id(6_809_833_080));
        file.extend_from_slice(b"....purd....");
        let cases: [(&str, Vec<u8>, Option<AlbumId>); 4] = [
            ("a bought song", file, Some(AlbumId(6_809_833_080))),
            ("no atom", b"....ftypM4A ....".to_vec(), None),
            ("cut short", pl_id(5)[..20].to_vec(), None),
            ("a zero id", pl_id(0), None),
        ];
        for (name, bytes, expected) in cases {
            assert_eq!(album_id(&bytes), expected, "{name}");
        }
    }

    #[test]
    fn covers_are_found_by_their_atom() {
        assert!(has_cover(b"....covr....data"));
        assert!(!has_cover(b"....plID....data"));
    }

    #[test]
    fn artwork_is_asked_for_large() {
        assert_eq!(
            sized("https://is1-ssl.mzstatic.com/image/thumb/x/artwork.jpg/100x100bb.jpg"),
            "https://is1-ssl.mzstatic.com/image/thumb/x/artwork.jpg/1000x1000bb.jpg"
        );
    }
}
