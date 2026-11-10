//! Minimal `WebDAV` client for Taildrive, which tailscaled exposes locally.

use std::path::Path;

use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use reqwest::{Body, Client, Method, StatusCode, header};
use serde::Serialize;

use crate::error::Error;

const DEFAULT_BASE: &str = "http://100.100.100.100:8080";

fn base() -> String {
    std::env::var("MANPLAY_DAV_BASE").unwrap_or_else(|_| DEFAULT_BASE.to_owned())
}
const DAV_NS: &str = "DAV:";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
}

fn url(segments: &[String]) -> String {
    let mut out = base();
    for s in segments {
        out.push('/');
        out.push_str(&utf8_percent_encode(s, NON_ALPHANUMERIC).to_string());
    }
    out
}

fn method(name: &str) -> Result<Method, Error> {
    Method::from_bytes(name.as_bytes()).map_err(|e| Error::Msg(e.to_string()))
}

async fn propfind(
    client: &Client,
    segments: &[String],
    depth: &str,
) -> Result<Option<String>, Error> {
    let resp = client
        .request(method("PROPFIND")?, url(segments))
        .header("Depth", depth)
        .send()
        .await?;
    match resp.status() {
        StatusCode::NOT_FOUND => Ok(None),
        s if s.is_success() => Ok(Some(resp.text().await?)),
        s => Err(Error::Msg(format!("webdav PROPFIND {s}"))),
    }
}

/// Whether the folder exists and the Taildrive machine is reachable.
pub async fn exists(client: &Client, segments: &[String]) -> Result<bool, Error> {
    Ok(propfind(client, segments, "0").await?.is_some())
}

pub async fn list(client: &Client, segments: &[String]) -> Result<Vec<Entry>, Error> {
    let Some(body) = propfind(client, segments, "1").await? else {
        return Ok(Vec::new());
    };
    let doc = roxmltree::Document::parse(&body).map_err(|e| Error::Msg(e.to_string()))?;
    let own = segments.join("/");
    let mut entries: Vec<Entry> = doc
        .descendants()
        .filter(|n| n.has_tag_name((DAV_NS, "response")))
        .filter_map(|resp| {
            let href = resp
                .children()
                .find(|n| n.has_tag_name((DAV_NS, "href")))?
                .text()?;
            let decoded = percent_decode_str(href).decode_utf8_lossy().into_owned();
            let trimmed = decoded.trim_matches('/');
            if trimmed == own {
                return None;
            }
            let name = trimmed.rsplit('/').next()?.to_owned();
            let is_dir = resp
                .descendants()
                .any(|n| n.has_tag_name((DAV_NS, "collection")));
            Some(Entry { name, is_dir })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Size of the remote file, or `None` if it does not exist.
pub async fn remote_size(client: &Client, segments: &[String]) -> Result<Option<u64>, Error> {
    let Some(body) = propfind(client, segments, "0").await? else {
        return Ok(None);
    };
    let doc = roxmltree::Document::parse(&body).map_err(|e| Error::Msg(e.to_string()))?;
    Ok(doc
        .descendants()
        .find(|n| n.has_tag_name((DAV_NS, "getcontentlength")))
        .and_then(|n| n.text())
        .and_then(|t| t.trim().parse().ok()))
}

pub async fn mkcol(client: &Client, segments: &[String]) -> Result<(), Error> {
    let resp = client
        .request(method("MKCOL")?, url(segments))
        .send()
        .await?;
    match resp.status() {
        // 405 = already exists
        StatusCode::METHOD_NOT_ALLOWED => Ok(()),
        s if s.is_success() => Ok(()),
        s => Err(Error::Msg(format!("webdav MKCOL {s}"))),
    }
}

/// Deletes a single remote file. A file that is already gone counts as success.
pub async fn delete(client: &Client, segments: &[String]) -> Result<(), Error> {
    let resp = client.delete(url(segments)).send().await?;
    match resp.status() {
        StatusCode::NOT_FOUND => Ok(()),
        s if s.is_success() => Ok(()),
        s => Err(Error::Msg(format!("webdav DELETE {s}"))),
    }
}

pub async fn put(client: &Client, segments: &[String], file: &Path) -> Result<(), Error> {
    let handle = tokio::fs::File::open(file).await?;
    let len = handle.metadata().await?.len();
    let resp = client
        .put(url(segments))
        .header(header::CONTENT_LENGTH, len)
        .body(Body::from(handle))
        .send()
        .await?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(Error::Msg(format!("webdav PUT {}", resp.status())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs only when `MANPLAY_DAV_BASE` points at a scratch `WebDAV` server.
    #[tokio::test]
    async fn roundtrip_against_local_server() {
        if std::env::var("MANPLAY_DAV_BASE").is_err() {
            return;
        }
        let client = Client::new();
        let seg = |parts: &[&str]| parts.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        let dir = std::env::temp_dir().join("manplay-dav-test.txt");
        std::fs::write(&dir, "hello").unwrap_or_default();

        mkcol(&client, &seg(&["tn", "m", "share", "Ärtist"]))
            .await
            .unwrap_or_default();
        mkcol(&client, &seg(&["tn", "m", "share", "Ärtist"]))
            .await
            .unwrap_or_default(); // idempotent
        let file = seg(&["tn", "m", "share", "Ärtist", "a b#1.txt"]);
        assert_eq!(remote_size(&client, &file).await.ok(), Some(None));
        put(&client, &file, &dir).await.unwrap_or_default();
        assert_eq!(remote_size(&client, &file).await.ok(), Some(Some(5)));

        let shares = list(&client, &seg(&["tn", "m"])).await.unwrap_or_default();
        assert_eq!(
            shares.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["share"]
        );
        let inner = list(&client, &seg(&["tn", "m", "share", "Ärtist"]))
            .await
            .unwrap_or_default();
        assert_eq!(inner.len(), 1);
        assert_eq!(inner.first().map(|e| e.name.as_str()), Some("a b#1.txt"));

        delete(&client, &file).await.unwrap_or_default();
        assert_eq!(remote_size(&client, &file).await.ok(), Some(None));
        // Deleting something already gone is fine, and leaves the folder alone.
        assert!(delete(&client, &file).await.is_ok());
        assert!(
            exists(&client, &seg(&["tn", "m", "share", "Ärtist"]))
                .await
                .unwrap_or(false)
        );
    }
}
