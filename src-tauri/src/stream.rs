//! Streams audio from a destination to the player through the `remote://` scheme, one range at a
//! time, so a song starts playing without downloading it first.
//!
//! URLs look like `remote://localhost/<destination id>/<folder>/<file>`.

use percent_encoding::percent_decode_str;
use tauri::http::Response;
use tauri::{AppHandle, Manager};

use crate::{AppState, db, sync};

/// Most bytes sent per request; the player asks again as it plays.
const CHUNK: u64 = 2 * 1024 * 1024;

/// Destination id and file path (relative to the destination folder) from a request path.
fn parse_path(uri_path: &str) -> Option<(i64, Vec<String>)> {
    let decoded = percent_decode_str(uri_path.trim_start_matches('/'))
        .decode_utf8()
        .ok()?;
    let mut parts = decoded.split('/');
    let id = parts.next()?.parse().ok()?;
    let rel: Vec<String> = parts.map(str::to_owned).collect();
    let safe = !rel.is_empty() && rel.iter().all(|s| !s.is_empty() && s != "." && s != "..");
    safe.then_some((id, rel))
}

/// The inclusive byte range to serve for a `Range` header on a file of `size` bytes, capped to
/// [`CHUNK`]. `None` when the range cannot be satisfied.
fn byte_range(header: Option<&str>, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let spec = header.and_then(|h| h.strip_prefix("bytes="));
    let (start, wanted_end) = match spec.and_then(|s| s.split(',').next()?.split_once('-')) {
        // No (usable) header: serve from the start.
        None => (0, u64::MAX),
        Some(("", suffix)) => (size.saturating_sub(suffix.parse().ok()?), u64::MAX),
        Some((from, to)) => (
            from.parse().ok()?,
            if to.is_empty() {
                u64::MAX
            } else {
                to.parse().ok()?
            },
        ),
    };
    if start >= size || wanted_end < start {
        return None;
    }
    let end = wanted_end.min(start + CHUNK - 1).min(size - 1);
    Some((start, end))
}

fn mime(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "aif" | "aiff" => "audio/aiff",
        "m4a" => "audio/mp4",
        _ => "application/octet-stream",
    }
}

fn status(code: u16) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .body(Vec::new())
        .unwrap_or_default()
}

pub async fn respond(app: &AppHandle, uri_path: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let Some((id, rel)) = parse_path(uri_path) else {
        return status(400);
    };
    let state = app.state::<AppState>();
    let target = {
        let Ok(conn) = state.db.lock() else {
            return status(500);
        };
        match db::get_targets(&conn, Some(&[id])) {
            Ok(t) => t.into_iter().next(),
            Err(_) => return status(500),
        }
    };
    let Some(target) = target else {
        return status(404);
    };
    let size = match sync::remote_file_size(&state.http, &target, &rel).await {
        Ok(Some(size)) => size,
        Ok(None) => return status(404),
        Err(e) => {
            log::warn!("remote stream size: {e}");
            return status(502);
        }
    };
    let Some((start, end)) = byte_range(range, size) else {
        return Response::builder()
            .status(416)
            .header("Content-Range", format!("bytes */{size}"))
            .body(Vec::new())
            .unwrap_or_default();
    };
    match sync::read_remote_range(&state.http, &target, &rel, start, end - start + 1).await {
        Ok(bytes) => Response::builder()
            .status(206)
            .header("Content-Type", mime(rel.last().map_or("", String::as_str)))
            .header("Accept-Ranges", "bytes")
            .header("Content-Range", format!("bytes {start}-{end}/{size}"))
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .unwrap_or_default(),
        Err(e) => {
            log::warn!("remote stream read: {e}");
            status(502)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_destination_and_path() {
        assert_eq!(
            parse_path("/7/Techno%20Set/a%26b.mp3"),
            Some((7, vec!["Techno Set".into(), "a&b.mp3".into()]))
        );
        assert_eq!(parse_path("/7"), None);
        assert_eq!(parse_path("/x/a.mp3"), None);
        assert_eq!(parse_path("/7/../a.mp3"), None);
        assert_eq!(parse_path("/7/a//b.mp3"), None);
    }

    #[test]
    fn ranges_are_capped_and_clamped() {
        let size = 10 * CHUNK;
        assert_eq!(byte_range(Some("bytes=0-"), size), Some((0, CHUNK - 1)));
        assert_eq!(byte_range(None, 100), Some((0, 99)));
        assert_eq!(byte_range(Some("bytes=10-19"), 100), Some((10, 19)));
        assert_eq!(byte_range(Some("bytes=90-500"), 100), Some((90, 99)));
        assert_eq!(byte_range(Some("bytes=-10"), 100), Some((90, 99)));
        assert_eq!(byte_range(Some("bytes=100-"), 100), None);
        assert_eq!(byte_range(Some("bytes=20-10"), 100), None);
        assert_eq!(byte_range(Some("bytes=0-"), 0), None);
    }

    #[test]
    fn knows_audio_types() {
        assert_eq!(mime("a.FLAC"), "audio/flac");
        assert_eq!(mime("a.txt"), "application/octet-stream");
    }
}
