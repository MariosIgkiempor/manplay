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
use serde::{Deserialize, Serialize};
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

/// Fields copied into the library database on every scan, so lists can show and filter them.
/// BPM and key are kept apart (`tag_bpm`, `tag_key`) because detection can override them.
pub const LISTED: &[&str] = &[
    "year",
    "genre",
    "artist",
    "albumArtist",
    "label",
    "grouping",
    "composer",
    "remixer",
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
fn songs_at(root: &Path, path: &Path) -> Result<Vec<PathBuf>, Error> {
    let target = fsops::inside(root, path)?;
    if target.is_file() {
        return Ok(if is_audio(&target) {
            vec![target]
        } else {
            vec![]
        });
    }
    Ok(WalkDir::new(&target)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && is_audio(e.path()))
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(walkdir::DirEntry::into_path)
        .collect())
}

/// Audio files at or under each of `paths` (songs and/or folders), once each, in path order.
pub fn songs(root: &Path, paths: &[PathBuf]) -> Result<Vec<PathBuf>, Error> {
    let mut out = Vec::new();
    for path in paths {
        out.extend(songs_at(root, path)?);
    }
    out.sort();
    out.dedup();
    Ok(out)
}

fn read_value(tag: Option<&Tag>, key: ItemKey) -> Option<String> {
    let v = tag?.get_string(key)?.trim();
    (!v.is_empty()).then(|| v.to_owned())
}

/// What the editor shows: each field's shared value across the songs at or under `paths`.
pub fn read(root: &Path, paths: &[PathBuf]) -> Result<TagView, Error> {
    let files = songs(root, paths)?;
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

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
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

/// Every field that differs between two tags, as a change from `from` to `to`. Lists compare
/// name by name, so `A;B` and `A; B` are the same.
pub fn diff(from: Option<&Tag>, to: Option<&Tag>) -> Vec<Change> {
    FIELDS
        .iter()
        .filter_map(|(field, _)| {
            let old = read_field(from, field).map(|v| normalized(field, &v));
            let new = read_field(to, field).map(|v| normalized(field, &v));
            (old != new).then(|| Change {
                field: (*field).to_owned(),
                from: old,
                to: new,
            })
        })
        .collect()
}

/// Every field a tag holds, as stored (lists normalised); fields it lacks are left out.
pub fn field_values(tag: Option<&Tag>) -> BTreeMap<String, String> {
    FIELDS
        .iter()
        .filter_map(|(field, _)| {
            let v = normalized(field, &read_field(tag, field)?);
            (!v.is_empty()).then(|| ((*field).to_owned(), v))
        })
        .collect()
}

/// The fields of the file at `path`, or `None` when its tags cannot be read.
pub fn file_fields(path: &Path) -> Option<BTreeMap<String, String>> {
    use lofty::config::ParseOptions;
    let file = lofty::probe::Probe::open(path)
        .ok()?
        .options(ParseOptions::new().read_properties(false))
        .read()
        .ok()?;
    Some(field_values(file.primary_tag()))
}

/// [`file_fields`] as JSON, for the sync base.
pub fn fields_json(path: &Path) -> Option<String> {
    serde_json::to_string(&file_fields(path)?).ok()
}

/// Fields stored by [`fields_json`].
pub fn parse_fields(json: &str) -> Option<BTreeMap<String, String>> {
    serde_json::from_str(json).ok()
}

/// One side of a two-sided edit.
#[derive(Serialize, serde::Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Mine,
    Theirs,
}

/// A field that differs between the library file and the destination copy, with the common
/// ancestor and which side wins when only one of them changed it.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FieldMerge {
    pub field: String,
    pub base: Option<String>,
    pub mine: Option<String>,
    pub theirs: Option<String>,
    /// `None` when both sides changed the field: someone has to choose.
    pub side: Option<Side>,
}

/// Three-way merge per field: a field only one side changed takes that side's value; a field
/// both changed differently is a conflict (`side` is `None`). Fields equal on both sides are left out.
pub fn merge(
    base: &BTreeMap<String, String>,
    mine: &BTreeMap<String, String>,
    theirs: &BTreeMap<String, String>,
) -> Vec<FieldMerge> {
    FIELDS
        .iter()
        .filter_map(|(field, _)| {
            let key = *field;
            let (b, m, t) = (base.get(key), mine.get(key), theirs.get(key));
            if m == t {
                return None;
            }
            let side = if m == b {
                Some(Side::Theirs)
            } else if t == b {
                Some(Side::Mine)
            } else {
                None
            };
            Some(FieldMerge {
                field: key.to_owned(),
                base: b.cloned(),
                mine: m.cloned(),
                theirs: t.cloned(),
                side,
            })
        })
        .collect()
}

/// Writes `edits` into the one file at `file` (an empty value clears the field).
pub fn write_file(file: &Path, edits: &BTreeMap<String, String>) -> Result<(), Error> {
    if let Some(bad) = edits.keys().find(|k| item_key(k).is_none()) {
        return Err(err(format!("unknown tag field: {bad}")));
    }
    if edits.is_empty() {
        return Ok(());
    }
    write_edits(file, edits)
}

/// What `edits` would change in each song at or under `paths`, without writing anything.
pub fn preview(
    root: &Path,
    paths: &[PathBuf],
    edits: &BTreeMap<String, String>,
) -> Result<Preview, Error> {
    if let Some(bad) = edits.keys().find(|k| item_key(k).is_none()) {
        return Err(err(format!("unknown tag field: {bad}")));
    }
    let songs = songs(root, paths)?;
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

/// Writes `edits` to every song at or under `paths` (songs and/or folders).
/// Failures are reported per file and never undo the rest.
pub fn write(
    root: &Path,
    paths: &[PathBuf],
    edits: &BTreeMap<String, String>,
) -> Result<FixReport, Error> {
    if let Some(bad) = edits.keys().find(|k| item_key(k).is_none()) {
        return Err(err(format!("unknown tag field: {bad}")));
    }
    let mut report = FixReport::default();
    if edits.is_empty() {
        return Ok(report);
    }
    for file in songs(root, paths)? {
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
    for file in songs(root, &[root.to_path_buf()])? {
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

/// How long a replaced cover is kept in the backups folder.
const COVER_BACKUPS_KEPT_FOR: std::time::Duration =
    std::time::Duration::from_secs(30 * 24 * 60 * 60);

/// The name of a replaced cover's file in the backups folder: the hash of the picture and its
/// kind, so songs that shared a cover share one backup. Checked on the way in from the app,
/// because it is joined onto a folder path.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(try_from = "String", into = "String")]
pub struct CoverBackupName(String);

impl CoverBackupName {
    fn of(picture: &Picture) -> Self {
        let extension = if picture.mime_type() == Some(&MimeType::Png) {
            "png"
        } else {
            "jpg"
        };
        Self(format!(
            "{}.{extension}",
            blake3::hash(picture.data()).to_hex()
        ))
    }
}

impl TryFrom<String> for CoverBackupName {
    type Error = String;

    fn try_from(raw: String) -> Result<Self, Self::Error> {
        let named_by_hash = raw
            .strip_suffix(".jpg")
            .or_else(|| raw.strip_suffix(".png"))
            .is_some_and(|hash| {
                hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            });
        if named_by_hash {
            Ok(Self(raw))
        } else {
            Err(format!("{raw:?} is not a cover backup"))
        }
    }
}

impl From<CoverBackupName> for String {
    fn from(name: CoverBackupName) -> Self {
        name.0
    }
}

/// A song's front cover as it was before a new one was written, to put it back with.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviousCover {
    pub path: String,
    /// The saved picture; `None` when the song had no front cover.
    pub backup: Option<CoverBackupName>,
}

/// What a cover write did, and what each rewritten song held before.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CoverReport {
    pub fixed: usize,
    pub failed: Vec<FixFailure>,
    pub previous: Vec<PreviousCover>,
}

/// Saves the song's front cover into `backups`, unless that picture is there already.
fn back_up_cover(file: &Path, backups: &Path) -> Result<Option<CoverBackupName>, Error> {
    let tagged = read_from_path(file).map_err(|e| err(format!("unreadable tags: {e}")))?;
    let Some(picture) = tagged
        .primary_tag()
        .and_then(|tag| tag.get_picture_type(PictureType::CoverFront))
    else {
        return Ok(None);
    };
    let name = CoverBackupName::of(picture);
    let saved = backups.join(&name.0);
    if !saved.exists() {
        std::fs::create_dir_all(backups)?;
        std::fs::write(&saved, picture.data())?;
    }
    Ok(Some(name))
}

/// Deletes backups older than [`COVER_BACKUPS_KEPT_FOR`]. Best effort: a backup that cannot
/// be read or deleted is left for next time.
fn prune_cover_backups(backups: &Path) {
    let Ok(entries) = std::fs::read_dir(backups) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|at| at.elapsed().ok())
            .is_some_and(|age| age > COVER_BACKUPS_KEPT_FOR);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Puts `bytes` (a JPEG or PNG) in as a song's front cover, for a song just imported.
pub fn embed_cover(file: &Path, bytes: &[u8]) -> Result<(), Error> {
    let mime = cover_mime(bytes)?;
    set_front_cover(file, Some((bytes, &mime)))
}

/// Puts `cover` in as the song's front cover, or takes the front cover out when `None`.
fn set_front_cover(file: &Path, cover: Option<(&[u8], &MimeType)>) -> Result<(), Error> {
    let change = |tag: &mut Tag| {
        tag.remove_picture_type(PictureType::CoverFront);
        if let Some((bytes, mime)) = cover {
            tag.push_picture(
                Picture::unchecked(bytes.to_vec())
                    .pic_type(PictureType::CoverFront)
                    .mime_type(mime.clone())
                    .build(),
            );
        }
        Ok(())
    };
    write_one(file, &change, &|_| Ok(()))
}

fn failure(file: &Path, error: &Error) -> FixFailure {
    FixFailure {
        path: file.to_string_lossy().into_owned(),
        error: error.to_string(),
    }
}

/// Sets the front cover of every song at or under `paths` (songs and/or folders). The cover a
/// song had is saved into `backups` first, and a song whose cover cannot be saved keeps it.
/// Failures are reported per file and never undo the rest.
pub fn write_cover(
    root: &Path,
    paths: &[PathBuf],
    bytes: &[u8],
    backups: &Path,
) -> Result<(Vec<PathBuf>, CoverReport), Error> {
    let mime = cover_mime(bytes)?;
    let files = songs(root, paths)?;
    prune_cover_backups(backups);
    let mut report = CoverReport::default();
    for file in &files {
        let written = back_up_cover(file, backups).and_then(|backup| {
            set_front_cover(file, Some((bytes, &mime)))?;
            Ok(backup)
        });
        match written {
            Ok(backup) => {
                report.fixed += 1;
                report.previous.push(PreviousCover {
                    path: file.to_string_lossy().into_owned(),
                    backup,
                });
            }
            Err(e) => report.failed.push(failure(file, &e)),
        }
    }
    Ok((files, report))
}

/// Puts back the covers a cover write replaced: each song gets its saved picture again, or
/// loses its front cover when it had none.
pub fn restore_covers(
    root: &Path,
    previous: &[PreviousCover],
    backups: &Path,
) -> Result<(Vec<PathBuf>, FixReport), Error> {
    let mut files = Vec::with_capacity(previous.len());
    let mut report = FixReport::default();
    for item in previous {
        let file = fsops::inside(root, Path::new(&item.path))?;
        let restored = match &item.backup {
            None => set_front_cover(&file, None),
            Some(name) => std::fs::read(backups.join(&name.0))
                .map_err(|e| err(format!("the saved cover is gone: {e}")))
                .and_then(|bytes| {
                    let mime = cover_mime(&bytes)?;
                    set_front_cover(&file, Some((&bytes, &mime)))
                }),
        };
        match restored {
            Ok(()) => report.fixed += 1,
            Err(e) => report.failed.push(failure(&file, &e)),
        }
        files.push(file);
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
        write(&root, &[root.join("a.wav")], &house).expect("seed");

        let edits = BTreeMap::from([
            ("genre".to_owned(), "House".to_owned()),
            ("label".to_owned(), String::new()),
        ]);
        let p = preview(&root, std::slice::from_ref(&root), &edits).expect("preview");
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
    fn diff_lists_changed_fields_from_a_partly_read_file() {
        let dir = std::env::temp_dir().join(format!("manplay-tagdiff-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap_or_default();
        let dir = dir.canonicalize().unwrap_or(dir);
        let (old, new) = (dir.join("old.wav"), dir.join("new.wav"));
        std::fs::write(&old, silent_wav()).unwrap_or_default();
        std::fs::write(&new, silent_wav()).unwrap_or_default();
        let base = BTreeMap::from([
            ("genre".to_owned(), "House".to_owned()),
            ("artist".to_owned(), "A;B".to_owned()),
        ]);
        write(&dir, &[old.clone(), new.clone()], &base).expect("seed");
        let edit = BTreeMap::from([("genre".to_owned(), "Techno".to_owned())]);
        write(&dir, std::slice::from_ref(&new), &edit).expect("edit");

        // Read the old copy as a destination would serve it: start and end only.
        let bytes = std::fs::read(&old).expect("read");
        let size = bytes.len() as u64;
        let remote = crate::tag_region::read(size, bytes[..64].to_vec(), bytes[64..].to_vec())
            .expect("remote tag");
        let local = read_from_path(&new).expect("local");
        assert_eq!(
            diff(Some(&remote), local.primary_tag()),
            [Change {
                field: "genre".into(),
                from: Some("House".into()),
                to: Some("Techno".into())
            }]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_field_is_rejected_before_touching_files() {
        let dir = std::env::temp_dir().join(format!("manplay-tags-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap_or_default();
        let edits = BTreeMap::from([("bogus".to_owned(), "x".to_owned())]);
        assert!(write(&dir, std::slice::from_ref(&dir), &edits).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One second of 8-bit mono silence as a WAV file.
    fn picture(red: u8) -> Vec<u8> {
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(2, 2, image::Rgb([red, 0, 0]))
            .write_to(&mut png, image::ImageFormat::Png)
            .expect("png");
        png.into_inner()
    }

    fn front_cover(file: &Path) -> Option<Vec<u8>> {
        let tagged = read_from_path(file).expect("readable");
        tagged
            .primary_tag()
            .and_then(|tag| tag.get_picture_type(PictureType::CoverFront))
            .map(|picture| picture.data().to_vec())
    }

    #[test]
    fn a_replaced_cover_is_backed_up_and_can_be_put_back() {
        let root = std::env::temp_dir().join(format!("manplay-cover-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let backups = root.join("backups");
        let album = root.join("library").join("Artist").join("Album");
        std::fs::create_dir_all(&album).expect("dirs");
        let library = root.join("library");
        let (bare, covered) = (album.join("a.wav"), album.join("b.wav"));
        std::fs::write(&bare, silent_wav()).expect("song");
        std::fs::write(&covered, silent_wav()).expect("song");
        let (first, second) = (picture(10), picture(200));

        let (_, before) =
            write_cover(&library, std::slice::from_ref(&covered), &first, &backups).expect("write");
        assert_eq!(before.previous[0].backup, None, "it had no cover to save");

        let (files, report) =
            write_cover(&library, std::slice::from_ref(&album), &second, &backups).expect("write");
        assert_eq!((files.len(), report.fixed, report.failed.len()), (2, 2, 0));
        assert_eq!(front_cover(&bare), Some(second.clone()));
        assert_eq!(front_cover(&covered), Some(second.clone()));
        let saved: Vec<Option<&CoverBackupName>> =
            report.previous.iter().map(|p| p.backup.as_ref()).collect();
        assert_eq!(saved.iter().filter(|backup| backup.is_some()).count(), 1);
        let name = saved.iter().flatten().next().expect("a backup");
        assert_eq!(
            std::fs::read(backups.join(&name.0)).expect("backup file"),
            first,
            "the old picture is kept as it was"
        );

        let (_, undone) = restore_covers(&library, &report.previous, &backups).expect("restore");
        assert_eq!((undone.fixed, undone.failed.len()), (2, 0));
        assert_eq!(
            front_cover(&bare),
            None,
            "a song that had no cover has none again"
        );
        assert_eq!(front_cover(&covered), Some(first));

        let outside = PreviousCover {
            path: root.join("elsewhere.wav").to_string_lossy().into_owned(),
            backup: None,
        };
        assert!(
            restore_covers(&library, &[outside], &backups).is_err(),
            "only songs in the library are touched"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_cover_backup_is_named_by_its_hash() {
        let hash = "a".repeat(64);
        let cases = [
            (format!("{hash}.jpg"), true),
            (format!("{hash}.png"), true),
            (format!("{hash}.gif"), false),
            (hash.clone(), false),
            (format!("{}.jpg", "a".repeat(63)), false),
            (format!("{}.jpg", "A".repeat(64)), false),
            (format!("../{hash}.jpg"), false),
            (format!("{}/../x.jpg", "a".repeat(56)), false),
            (String::new(), false),
        ];
        for (raw, valid) in cases {
            assert_eq!(
                CoverBackupName::try_from(raw.clone()).is_ok(),
                valid,
                "{raw:?}"
            );
        }
    }

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
        let report = write(&root, std::slice::from_ref(&album), &all).expect("folder write");
        assert_eq!(
            (report.fixed, report.failed.len()),
            (2, 0),
            "{:?}",
            report.failed
        );

        let one = BTreeMap::from([("title".to_owned(), "Solo".to_owned())]);
        write(&root, &[album.join("1.wav")], &one).expect("file write");

        let view = read(&root, std::slice::from_ref(&album)).expect("read");
        assert_eq!(view.count, 2);
        assert_eq!(view.fields["genre"].value.as_deref(), Some("House"));
        assert!(view.fields["title"].mixed, "only one song got a title");
        let single = read(&root, &[album.join("1.wav")]).expect("read one");
        assert_eq!(single.fields["title"].value.as_deref(), Some("Solo"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_list_of_songs_from_different_folders_is_edited_once_each() {
        let root = std::env::temp_dir().join(format!("manplay-taglist-{}", std::process::id()));
        for dir in ["X", "Y", "Z"] {
            std::fs::create_dir_all(root.join(dir)).unwrap_or_default();
            std::fs::write(root.join(dir).join("s.wav"), silent_wav()).unwrap_or_default();
        }
        let root = root.canonicalize().unwrap_or(root);
        // The same song twice, and a folder holding it, still count once.
        let picked = vec![
            root.join("X").join("s.wav"),
            root.join("Y").join("s.wav"),
            root.join("X"),
        ];
        let edits = BTreeMap::from([("album".to_owned(), "Joined".to_owned())]);
        let report = write(&root, &picked, &edits).expect("write");
        assert_eq!(
            (report.fixed, report.failed.len()),
            (2, 0),
            "{:?}",
            report.failed
        );
        let view = read(&root, &picked).expect("read");
        assert_eq!(view.count, 2);
        assert_eq!(view.fields["album"].value.as_deref(), Some("Joined"));
        let other = read(&root, &[root.join("Z")]).expect("read other");
        assert_eq!(
            other.fields["album"].value, None,
            "unpicked song is untouched"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    fn fields(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn edits_to_different_fields_merge_without_a_choice() {
        let base = fields(&[("genre", "House"), ("year", "2020")]);
        let mine = fields(&[("genre", "Techno"), ("year", "2020")]);
        let theirs = fields(&[("genre", "House"), ("year", "2021"), ("label", "X")]);
        let m = merge(&base, &mine, &theirs);
        let side = |f: &str| m.iter().find(|x| x.field == f).map(|x| x.side);
        assert_eq!(side("genre"), Some(Some(Side::Mine)));
        assert_eq!(side("year"), Some(Some(Side::Theirs)));
        assert_eq!(side("label"), Some(Some(Side::Theirs)));
        assert_eq!(m.len(), 3);
    }

    #[test]
    fn the_same_field_edited_differently_is_a_conflict() {
        let base = fields(&[("genre", "House")]);
        let m = merge(
            &base,
            &fields(&[("genre", "Techno")]),
            &fields(&[("genre", "Disco")]),
        );
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].side, None);
        assert_eq!(m[0].base.as_deref(), Some("House"));
    }

    #[test]
    fn the_same_edit_on_both_sides_and_untouched_fields_are_left_out() {
        let base = fields(&[("genre", "House"), ("year", "2020")]);
        let both = fields(&[("genre", "Techno"), ("year", "2020")]);
        assert_eq!(merge(&base, &both, &both), vec![]);
    }

    #[test]
    fn a_cleared_field_counts_as_an_edit() {
        let base = fields(&[("genre", "House")]);
        let m = merge(&base, &fields(&[]), &fields(&[("genre", "House")]));
        assert_eq!(m[0].side, Some(Side::Mine));
        assert_eq!(m[0].mine, None);
    }

    #[test]
    fn merged_fields_written_to_a_file_read_back() {
        let dir = std::env::temp_dir().join(format!("manplay-merge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let file = dir.join("s.wav");
        std::fs::write(&file, silent_wav()).expect("write");
        write_file(&file, &fields(&[("genre", "House"), ("year", "2020")])).expect("w1");
        write_file(&file, &fields(&[("genre", "")])).expect("clear");
        let got = file_fields(&file).expect("fields");
        assert_eq!(got.get("genre"), None);
        assert_eq!(got.get("year").map(String::as_str), Some("2020"));
        let json = fields_json(&file).expect("json");
        assert_eq!(parse_fields(&json), Some(got));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
