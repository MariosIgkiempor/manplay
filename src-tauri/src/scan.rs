use std::path::Path;

use lofty::file::TaggedFileExt;
use lofty::read_from_path;
use lofty::tag::Accessor;
use walkdir::WalkDir;

use crate::db::NewTrack;

const EXTENSIONS: &[&str] = &["wav", "flac", "mp3", "aif", "aiff", "m4a"];

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Library layout is `root/artist/album/track.ext`. Folder names win when the
/// file sits at that depth; otherwise fall back to tags, then "Unknown".
pub fn scan(root: &Path) -> Vec<NewTrack> {
    WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && is_audio(e.path()))
        .filter_map(|e| {
            let path = e.path();
            let rel = path.strip_prefix(root).ok()?;
            let parts: Vec<&str> = rel.iter().filter_map(|p| p.to_str()).collect();
            let tagged = read_from_path(path).ok();
            let tag = tagged.as_ref().and_then(|f| f.primary_tag());
            let tag_text = |get: fn(&lofty::tag::Tag) -> Option<std::borrow::Cow<'_, str>>| {
                tag.and_then(get).map(std::borrow::Cow::into_owned)
            };
            let (artist, album) = match parts.as_slice() {
                [artist, album, _] => ((*artist).to_owned(), (*album).to_owned()),
                _ => (
                    tag_text(Accessor::artist).unwrap_or_else(|| "Unknown".to_owned()),
                    tag_text(Accessor::album).unwrap_or_else(|| "Unknown".to_owned()),
                ),
            };
            let stem = path.file_stem()?.to_str()?.to_owned();
            let title = tag_text(Accessor::title).unwrap_or(stem);
            Some(NewTrack {
                path: path.to_str()?.to_owned(),
                artist,
                album,
                title,
                size: i64::try_from(e.metadata().ok()?.len()).ok()?,
            })
        })
        .collect()
}
