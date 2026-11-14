//! Tag editor backend: reads the tags shared by a file or a whole folder, and writes edits to
//! one file or to every song under a folder. Writes follow the same rule as library health
//! fixes: the new file is built beside the old one, checked, then swapped in.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::read_from_path;
use lofty::tag::{ItemKey, Tag, TagExt, TagType};
use serde::Serialize;
use walkdir::WalkDir;

use crate::audit::{FixFailure, FixReport, is_mp3, replace_file};
use crate::error::Error;
use crate::fsops;
use crate::scan::is_audio;

/// Editable fields: the id the UI uses and the tag item it maps to. Covers what Jellyfin reads
/// (titles, artists, album artist, sort names, genre, year, numbering, compilation) and what
/// rekordbox shows (BPM, key, label, remixer, grouping, comment, mix name).
const FIELDS: &[(&str, ItemKey)] = &[
    ("title", ItemKey::TrackTitle),
    ("subtitle", ItemKey::TrackSubtitle),
    ("artist", ItemKey::TrackArtist),
    ("albumArtist", ItemKey::AlbumArtist),
    ("album", ItemKey::AlbumTitle),
    ("composer", ItemKey::Composer),
    ("remixer", ItemKey::Remixer),
    ("lyricist", ItemKey::Lyricist),
    ("conductor", ItemKey::Conductor),
    ("originalArtist", ItemKey::OriginalArtist),
    ("genre", ItemKey::Genre),
    ("mood", ItemKey::Mood),
    ("year", ItemKey::RecordingDate),
    ("track", ItemKey::TrackNumber),
    ("trackTotal", ItemKey::TrackTotal),
    ("disc", ItemKey::DiscNumber),
    ("discTotal", ItemKey::DiscTotal),
    ("bpm", ItemKey::IntegerBpm),
    ("key", ItemKey::InitialKey),
    ("label", ItemKey::Label),
    ("grouping", ItemKey::ContentGroup),
    ("comment", ItemKey::Comment),
    ("isrc", ItemKey::Isrc),
    ("copyright", ItemKey::CopyrightMessage),
    ("language", ItemKey::Language),
    ("compilation", ItemKey::FlagCompilation),
    ("sortTitle", ItemKey::TrackTitleSortOrder),
    ("sortArtist", ItemKey::TrackArtistSortOrder),
    ("sortAlbum", ItemKey::AlbumTitleSortOrder),
    ("sortAlbumArtist", ItemKey::AlbumArtistSortOrder),
];

/// How several names are stored in one MP3 text frame. A plain `;` is read as a list separator
/// by Jellyfin and displays harmlessly on older Pioneer players, which cannot read ID3v2.4
/// multi-value frames.
pub const SEPARATOR: &str = "; ";

/// Fields that hold a list of names (stored joined by [`SEPARATOR`]).
pub const MULTI: &[&str] = &["artist", "albumArtist", "genre", "composer", "remixer"];

/// Fields whose existing values are remembered, to offer them again in the editor.
pub const SUGGEST: &[&str] = &[
    "artist",
    "albumArtist",
    "genre",
    "composer",
    "remixer",
    "label",
    "grouping",
    "mood",
    "language",
];

/// Names in a list field: split on `;`, trimmed, empty ones dropped.
pub fn split_names(value: &str) -> Vec<String> {
    value
        .split(';')
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_owned)
        .collect()
}

fn item_key(field: &str) -> Option<ItemKey> {
    FIELDS.iter().find(|(id, _)| *id == field).map(|(_, k)| *k)
}

/// Every item key a field can be found under. ID3 keeps label and publisher in one frame (TPUB)
/// and lofty reads that frame back as `Publisher`, so looking for `Label` alone never finds a
/// label that is already in the file.
fn item_keys(field: &str) -> &'static [ItemKey] {
    if field == "label" {
        return &[ItemKey::Label, ItemKey::Publisher];
    }
    FIELDS
        .iter()
        .find(|(id, _)| *id == field)
        .map_or(&[], |(_, k)| std::slice::from_ref(k))
}

/// The key a new value is written under for this kind of tag (the one it reads back as).
fn write_key(field: &str, tag_type: TagType) -> Option<ItemKey> {
    if field == "label" && tag_type == TagType::Id3v2 {
        return Some(ItemKey::Publisher);
    }
    item_keys(field).first().copied()
}

/// A field's value in `tag`, trying every key it may be stored under.
pub fn read_field(tag: Option<&Tag>, field: &str) -> Option<String> {
    item_keys(field).iter().find_map(|k| read_value(tag, *k))
}

fn err(msg: impl Into<String>) -> Error {
    Error::Msg(msg.into())
}

/// One field across the selected songs.
#[derive(Serialize, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Shared {
    /// The value every song has; `None` when none has one or they differ.
    pub value: Option<String>,
    /// Songs disagree (some differ or some lack it).
    pub mixed: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TagView {
    /// Songs the edit would touch.
    pub count: usize,
    pub fields: BTreeMap<String, Shared>,
}

/// Audio files at `path` (a file), or under it (a folder), in path order.
fn songs(root: &Path, path: &Path) -> Result<Vec<PathBuf>, Error> {
    let target = fsops::inside(root, path)?;
    if target.is_file() {
        return Ok(if is_audio(&target) {
            vec![target]
        } else {
            vec![]
        });
    }
    let mut out: Vec<PathBuf> = WalkDir::new(&target)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && is_audio(e.path()))
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(walkdir::DirEntry::into_path)
        .collect();
    out.sort();
    Ok(out)
}

fn read_value(tag: Option<&Tag>, key: ItemKey) -> Option<String> {
    let v = tag?.get_string(key)?.trim();
    (!v.is_empty()).then(|| v.to_owned())
}

/// What the editor shows: each field's shared value across the songs under `path`.
pub fn read(root: &Path, path: &Path) -> Result<TagView, Error> {
    let files = songs(root, path)?;
    let mut per_field: BTreeMap<&str, Vec<Option<String>>> = BTreeMap::new();
    for file in &files {
        let tagged = read_from_path(file).ok();
        let tag = tagged.as_ref().and_then(|f| f.primary_tag());
        for (id, _) in FIELDS {
            per_field.entry(id).or_default().push(read_field(tag, id));
        }
    }
    let fields = FIELDS
        .iter()
        .map(|(id, _)| {
            let values = per_field.get(id).map(Vec::as_slice).unwrap_or_default();
            let first = values.first().cloned().flatten();
            let mixed = values.iter().any(|v| *v != first);
            let shared = Shared {
                value: if mixed { None } else { first },
                mixed,
            };
            ((*id).to_owned(), shared)
        })
        .collect();
    Ok(TagView {
        count: files.len(),
        fields,
    })
}

/// Value as it will be stored: lists are normalised to `A; B`, everything else trimmed.
fn normalized(field: &str, value: &str) -> String {
    if MULTI.contains(&field) {
        split_names(value).join(SEPARATOR)
    } else {
        value.trim().to_owned()
    }
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub field: String,
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChanges {
    pub path: String,
    pub changes: Vec<Change>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// Songs the edit reaches.
    pub total: usize,
    /// Only the songs where at least one tag would actually change.
    pub files: Vec<FileChanges>,
}

/// What `edits` would change in each song at or under `path`, without writing anything.
pub fn preview(
    root: &Path,
    path: &Path,
    edits: &BTreeMap<String, String>,
) -> Result<Preview, Error> {
    if let Some(bad) = edits.keys().find(|k| item_key(k).is_none()) {
        return Err(err(format!("unknown tag field: {bad}")));
    }
    let songs = songs(root, path)?;
    let mut files = Vec::new();
    for song in &songs {
        let tagged = read_from_path(song).ok();
        let tag = tagged.as_ref().and_then(|f| f.primary_tag());
        let changes: Vec<Change> = edits
            .iter()
            .filter_map(|(field, value)| {
                item_key(field)?;
                let from = read_field(tag, field);
                let to = Some(normalized(field, value)).filter(|v| !v.is_empty());
                (from != to).then(|| Change {
                    field: field.clone(),
                    from,
                    to,
                })
            })
            .collect();
        if !changes.is_empty() {
            files.push(FileChanges {
                path: song.to_string_lossy().into_owned(),
                changes,
            });
        }
    }
    Ok(Preview {
        total: songs.len(),
        files,
    })
}

/// Applies `edits` to `tag`: a non-empty value sets the field, an empty one clears it.
fn apply(tag: &mut Tag, edits: &BTreeMap<String, String>) -> Result<(), Error> {
    for (field, value) in edits {
        let Some(key) = write_key(field, tag.tag_type()) else {
            continue;
        };
        let value = normalized(field, value);
        for k in item_keys(field) {
            tag.remove_key(*k);
        }
        if !value.is_empty() && !tag.insert_text(key, value) {
            return Err(err(format!(
                "this file format cannot store the {field} tag"
            )));
        }
    }
    Ok(())
}

/// Checks the rewritten file really holds what was asked for, so a tag the format silently
/// dropped is reported instead of shown as saved.
fn verify(tag: Option<&Tag>, edits: &BTreeMap<String, String>) -> Result<(), Error> {
    for (field, value) in edits {
        let Some(key) = item_key(field) else { continue };
        let want = normalized(field, value);
        let got = read_field(tag, field).unwrap_or_default();
        let exact = !key.is_numeric() && field != "compilation";
        if want.is_empty() != got.is_empty() || (exact && want != got) {
            return Err(err(format!("the {field} tag did not stick in this file")));
        }
    }
    Ok(())
}

/// A hidden scratch copy beside `file`. It keeps the extension: lofty picks the format from it.
fn scratch_copy(file: &Path) -> PathBuf {
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("mp3");
    file.with_file_name(format!(".manplay-tags-{}.{ext}", std::process::id()))
}

fn write_one(
    file: &Path,
    change: &dyn Fn(&mut Tag) -> Result<(), Error>,
    check: &dyn Fn(Option<&Tag>) -> Result<(), Error>,
) -> Result<(), Error> {
    let tmp = scratch_copy(file);
    std::fs::copy(file, &tmp)?;
    let result = (|| -> Result<(), Error> {
        let tagged = read_from_path(&tmp).map_err(|e| err(format!("unreadable tags: {e}")))?;
        let mut tag = tagged
            .primary_tag()
            .cloned()
            .unwrap_or_else(|| Tag::new(tagged.primary_tag_type()));
        change(&mut tag)?;
        // Library convention: MP3s carry ID3v2.3 tags.
        let options = WriteOptions::default().use_id3v23(is_mp3(file));
        tag.save_to_path(&tmp, options)
            .map_err(|e| err(format!("could not write tags: {e}")))?;
        let after =
            read_from_path(&tmp).map_err(|e| err(format!("rewritten file is unreadable: {e}")))?;
        if after.properties().duration() != tagged.properties().duration() {
            return Err(err("rewritten file changed length"));
        }
        check(after.primary_tag())?;
        Ok(())
    })();
    match result {
        Ok(()) => replace_file(file, &tmp, false).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        }),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn write_edits(file: &Path, edits: &BTreeMap<String, String>) -> Result<(), Error> {
    write_one(file, &|tag| apply(tag, edits), &|tag| verify(tag, edits))
}

/// Writes `edits` to the song at `path`, or to every song under it when it is a folder.
/// Failures are reported per file and never undo the rest.
pub fn write(
    root: &Path,
    path: &Path,
    edits: &BTreeMap<String, String>,
) -> Result<FixReport, Error> {
    if let Some(bad) = edits.keys().find(|k| item_key(k).is_none()) {
        return Err(err(format!("unknown tag field: {bad}")));
    }
    let mut report = FixReport::default();
    if edits.is_empty() {
        return Ok(report);
    }
    for file in songs(root, path)? {
        match write_edits(&file, edits) {
            Ok(()) => report.fixed += 1,
            Err(e) => report.failed.push(FixFailure {
                path: file.to_string_lossy().into_owned(),
                error: e.to_string(),
            }),
        }
    }
    Ok(report)
}

/// What a field holds once every name in `from` becomes `to` (or is dropped when `to` is `None`).
/// Names match ignoring case. `None` when nothing changes.
pub fn migrated(field: &str, current: &str, from: &[String], to: Option<&str>) -> Option<String> {
    let hit = |n: &str| from.iter().any(|f| f.trim().eq_ignore_ascii_case(n.trim()));
    if !MULTI.contains(&field) {
        return hit(current).then(|| to.unwrap_or_default().trim().to_owned());
    }
    let names = split_names(current);
    let mut out: Vec<String> = Vec::new();
    for name in &names {
        let next = if hit(name) {
            to.map(str::trim)
        } else {
            Some(name.as_str())
        };
        if let Some(n) = next.filter(|n| !n.is_empty())
            && !out.iter().any(|o| o.eq_ignore_ascii_case(n))
        {
            out.push(n.to_owned());
        }
    }
    (out != names).then(|| out.join(SEPARATOR))
}

/// Replaces every name in `from` with `to` (or removes it) in `field`, across every song in the
/// library. Failures are reported per file and never undo the rest.
pub fn migrate(
    root: &Path,
    field: &str,
    from: &[String],
    to: Option<&str>,
) -> Result<FixReport, Error> {
    if !SUGGEST.contains(&field) {
        return Err(err(format!("cannot manage values of: {field}")));
    }
    let mut report = FixReport::default();
    for file in songs(root, root)? {
        let tagged = read_from_path(&file).ok();
        let current = read_field(tagged.as_ref().and_then(|f| f.primary_tag()), field);
        let Some(new) = current.and_then(|c| migrated(field, &c, from, to)) else {
            continue;
        };
        let edits = BTreeMap::from([(field.to_owned(), new)]);
        match write_edits(&file, &edits) {
            Ok(()) => report.fixed += 1,
            Err(e) => report.failed.push(FixFailure {
                path: file.to_string_lossy().into_owned(),
                error: e.to_string(),
            }),
        }
    }
    Ok(report)
}

/// Checks `bytes` is a JPEG or PNG and returns its mime type.
fn cover_mime(bytes: &[u8]) -> Result<MimeType, Error> {
    let mime = if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        MimeType::Jpeg
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        MimeType::Png
    } else {
        return Err(err("cover must be a JPEG or PNG image"));
    };
    image::load_from_memory(bytes).map_err(|e| err(format!("unreadable image: {e}")))?;
    Ok(mime)
}

/// Sets the front cover of the song at `path`, or of every song under it when it is a folder.
/// Failures are reported per file and never undo the rest.
pub fn write_cover(
    root: &Path,
    path: &Path,
    bytes: &[u8],
) -> Result<(Vec<PathBuf>, FixReport), Error> {
    let mime = cover_mime(bytes)?;
    let files = songs(root, path)?;
    let mut report = FixReport::default();
    for file in &files {
        let change = |tag: &mut Tag| {
            tag.remove_picture_type(PictureType::CoverFront);
            tag.push_picture(
                Picture::unchecked(bytes.to_vec())
                    .pic_type(PictureType::CoverFront)
                    .mime_type(mime.clone())
                    .build(),
            );
            Ok(())
        };
        match write_one(file, &change, &|_| Ok(())) {
            Ok(()) => report.fixed += 1,
            Err(e) => report.failed.push(FixFailure {
                path: file.to_string_lossy().into_owned(),
                error: e.to_string(),
            }),
        }
    }
    Ok((files, report))
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::cast_possible_truncation)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    #[test]
    fn label_is_found_and_replaced_in_an_id3_tag() {
        let set = |tag: &mut Tag, v: &str| {
            let edits = BTreeMap::from([("label".to_owned(), v.to_owned())]);
            apply(tag, &edits).expect("apply");
        };
        let mut tag = Tag::new(TagType::Id3v2);
        set(&mut tag, "Warp");
        // Round trip through the ID3 frame model, as a saved file would.
        let mut tag = Tag::from(lofty::id3::v2::Id3v2Tag::from(tag));
        assert_eq!(read_field(Some(&tag), "label").as_deref(), Some("Warp"));
        set(&mut tag, "Ninja Tune");
        let tag = Tag::from(lofty::id3::v2::Id3v2Tag::from(tag));
        assert_eq!(
            read_field(Some(&tag), "label").as_deref(),
            Some("Ninja Tune")
        );
        assert_eq!(tag.len(), 1, "no stale duplicate left behind");
    }

    #[test]
    fn migrating_names_renames_merges_and_drops() {
        let from = ["hip hop".to_owned(), "Rap".to_owned()];
        let m = |cur: &str, to: Option<&str>| migrated("genre", cur, &from, to);
        assert_eq!(
            m("House; Hip Hop", Some("Hip-Hop")).as_deref(),
            Some("House; Hip-Hop")
        );
        assert_eq!(
            m("Rap; Hip-Hop", Some("Hip-Hop")).as_deref(),
            Some("Hip-Hop")
        );
        assert_eq!(m("House; Rap", None).as_deref(), Some("House"));
        assert_eq!(m("Rap", None).as_deref(), Some(""));
        assert_eq!(m("House", Some("X")), None);
        assert_eq!(
            migrated("label", "warp", &["Warp".to_owned()], Some("Warp Records")).as_deref(),
            Some("Warp Records")
        );
    }

    #[test]
    fn every_field_id_is_unique() {
        let mut ids: Vec<_> = FIELDS.iter().map(|(id, _)| *id).collect();
        ids.sort_unstable();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n);
    }

    #[test]
    fn apply_sets_and_clears() {
        let mut tag = Tag::new(lofty::tag::TagType::Id3v2);
        tag.insert_text(ItemKey::Genre, "Old".to_owned());
        tag.insert_text(ItemKey::Label, "Gone".to_owned());
        let edits = BTreeMap::from([
            ("genre".to_owned(), " House ".to_owned()),
            ("label".to_owned(), String::new()),
            ("nonsense".to_owned(), "x".to_owned()),
        ]);
        apply(&mut tag, &edits).expect("apply");
        assert_eq!(tag.get_string(ItemKey::Genre), Some("House"));
        assert_eq!(tag.get_string(ItemKey::Label), None);
    }

    #[test]
    fn names_are_split_and_rejoined_with_a_plain_semicolon() {
        assert_eq!(split_names(" A ;B;; C "), ["A", "B", "C"]);
        let mut tag = Tag::new(lofty::tag::TagType::Id3v2);
        let edits = BTreeMap::from([("artist".to_owned(), "A;B ;  C".to_owned())]);
        apply(&mut tag, &edits).expect("apply");
        assert_eq!(tag.get_string(ItemKey::TrackArtist), Some("A; B; C"));
    }

    #[test]
    fn preview_lists_only_real_changes_and_writes_nothing() {
        let root = std::env::temp_dir().join(format!("manplay-prev-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap_or_default();
        let root = root.canonicalize().unwrap_or(root);
        std::fs::write(root.join("a.wav"), silent_wav()).unwrap_or_default();
        std::fs::write(root.join("b.wav"), silent_wav()).unwrap_or_default();
        let house = BTreeMap::from([("genre".to_owned(), "House".to_owned())]);
        write(&root, &root.join("a.wav"), &house).expect("seed");

        let edits = BTreeMap::from([
            ("genre".to_owned(), "House".to_owned()),
            ("label".to_owned(), String::new()),
        ]);
        let p = preview(&root, &root, &edits).expect("preview");
        assert_eq!(p.total, 2);
        // a.wav already matches; b.wav only gains the genre (clearing an unset label is no change).
        assert_eq!(p.files.len(), 1);
        assert!(p.files[0].path.ends_with("b.wav"));
        assert_eq!(
            p.files[0].changes,
            [Change {
                field: "genre".into(),
                from: None,
                to: Some("House".into())
            }]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unknown_field_is_rejected_before_touching_files() {
        let dir = std::env::temp_dir().join(format!("manplay-tags-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap_or_default();
        let edits = BTreeMap::from([("bogus".to_owned(), "x".to_owned())]);
        assert!(write(&dir, &dir, &edits).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One second of 8-bit mono silence as a WAV file.
    fn silent_wav() -> Vec<u8> {
        let data = vec![128_u8; 8000];
        let mut w = Vec::new();
        w.extend(b"RIFF");
        w.extend((36 + data.len() as u32).to_le_bytes());
        w.extend(b"WAVEfmt ");
        w.extend(16_u32.to_le_bytes());
        w.extend(1_u16.to_le_bytes()); // PCM
        w.extend(1_u16.to_le_bytes()); // mono
        w.extend(8000_u32.to_le_bytes());
        w.extend(8000_u32.to_le_bytes());
        w.extend(1_u16.to_le_bytes());
        w.extend(8_u16.to_le_bytes());
        w.extend(b"data");
        w.extend((data.len() as u32).to_le_bytes());
        w.extend(data);
        w
    }

    #[test]
    fn folder_write_reaches_every_song_and_file_write_only_one() {
        let root = std::env::temp_dir().join(format!("manplay-tagrt-{}", std::process::id()));
        let album = root.join("A").join("B");
        std::fs::create_dir_all(&album).unwrap_or_default();
        for n in ["1.wav", "2.wav"] {
            std::fs::write(album.join(n), silent_wav()).unwrap_or_default();
        }
        let root = root.canonicalize().unwrap_or(root);
        let album = root.join("A").join("B");

        let all = BTreeMap::from([("genre".to_owned(), "House".to_owned())]);
        let report = write(&root, &album, &all).expect("folder write");
        assert_eq!(
            (report.fixed, report.failed.len()),
            (2, 0),
            "{:?}",
            report.failed
        );

        let one = BTreeMap::from([("title".to_owned(), "Solo".to_owned())]);
        write(&root, &album.join("1.wav"), &one).expect("file write");

        let view = read(&root, &album).expect("read");
        assert_eq!(view.count, 2);
        assert_eq!(view.fields["genre"].value.as_deref(), Some("House"));
        assert!(view.fields["title"].mixed, "only one song got a title");
        let single = read(&root, &album.join("1.wav")).expect("read one");
        assert_eq!(single.fields["title"].value.as_deref(), Some("Solo"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
