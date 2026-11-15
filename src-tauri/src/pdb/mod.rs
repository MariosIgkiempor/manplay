//! Pioneer "Device Library" database (`PIONEER/rekordbox/export.pdb`): the file CDJs and XDJs
//! read off a USB stick to list its tracks and playlists.
//!
//! The layout follows Deep Symmetry's Crate Digger research
//! (<https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/exports.html>). Where that
//! research leaves a field unexplained, the writer copies what rekordbox 7 itself writes into a
//! fresh export.
//!
//! The file is a sequence of 4 KiB pages. Page 0 lists the tables; each table is a linked list of
//! pages that starts with an index page, followed by data pages that hold rows in a heap growing
//! from the front and a row index growing from the back.

#![allow(clippy::cast_possible_truncation)]
// The writer is only reached from tests until the USB export command lands.
#![cfg_attr(not(test), allow(dead_code))]

mod templates;

use serde::Serialize;
use std::collections::HashMap;

pub const PAGE: usize = 4096;
/// Bytes of page header before a data page's row heap.
const HEAP: usize = 0x28;
/// Each group of up to 16 row offsets at the end of a data page takes this many bytes.
const GROUP: usize = 0x24;
/// "No page" in index pages.
const NO_PAGE: u32 = 0x03ff_ffff;
/// Slots for pages with free space in an index page; rekordbox always reserves 1004.
const INDEX_SLOTS: usize = 1004;
const EMPTY_SLOT: u32 = 0x1fff_fff8;

/// Every table rekordbox 7 writes, in its order.
const TABLES: u32 = 20;
const T_TRACKS: u32 = 0;
const T_GENRES: u32 = 1;
const T_ARTISTS: u32 = 2;
const T_ALBUMS: u32 = 3;
const T_KEYS: u32 = 5;
const T_COLORS: u32 = 6;
const T_PLAYLIST_TREE: u32 = 7;
const T_PLAYLIST_ENTRIES: u32 = 8;
const T_ARTWORK: u32 = 13;
const T_COLUMNS: u32 = 16;
const T_MENU: u32 = 17;
const T_MENU_ITEMS: u32 = 18;

/// Number of string slots at the end of every track row, and which slot holds what.
const TRACK_STRINGS: usize = 21;
const S_DATE_ADDED: usize = 10;
const S_ANALYZE_PATH: usize = 14;
const S_ANALYZE_DATE: usize = 15;
const S_COMMENT: usize = 16;
const S_TITLE: usize = 17;
const S_FILENAME: usize = 19;
const S_FILE_PATH: usize = 20;
const TRACK_HEADER: usize = 0x5e + 2 * TRACK_STRINGS;

/// One track as a player sees it. `path` is relative to the stick's root, e.g.
/// `/Contents/Artist/Album/song.mp3`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_field_names)] // `track_number` is the tag's name
pub struct Track {
    pub id: u32,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    /// As shown on the player, e.g. "Am" or "8A".
    pub key: String,
    pub comment: String,
    pub path: String,
    /// Where the beat grid and waveforms live, e.g. `/PIONEER/USBANLZ/P001/00000001/ANLZ0000.DAT`.
    pub analyze_path: String,
    /// `YYYY-MM-DD`.
    pub date_added: String,
    pub duration_secs: u16,
    /// BPM × 100, 0 when unknown.
    pub tempo: u32,
    pub bitrate: u32,
    pub sample_rate: u32,
    pub file_size: u32,
    pub year: u16,
    pub track_number: u32,
    pub file_type: u16,
    pub artwork_id: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: u32,
    /// 0 for the top level.
    pub parent_id: u32,
    pub name: String,
    pub is_folder: bool,
    pub sort_order: u32,
    pub track_ids: Vec<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub tracks: Vec<Track>,
    pub playlists: Vec<Playlist>,
    /// Artwork paths by id, e.g. `/PIONEER/Artwork/00001/a1.jpg`.
    pub artwork: Vec<(u32, String)>,
}

/// Player file type codes.
pub fn file_type(ext: &str) -> u16 {
    match ext.to_ascii_lowercase().as_str() {
        "mp3" => 1,
        "m4a" | "mp4" | "aac" => 4,
        "flac" => 5,
        "wav" => 11,
        "aif" | "aiff" => 12,
        _ => 0,
    }
}

// ---------------------------------------------------------------------------------------------
// Reading

fn u16_at(b: &[u8], o: usize) -> Result<u16, String> {
    b.get(o..o + 2)
        .map(|s| u16::from_le_bytes([s[0], s[1]]))
        .ok_or_else(|| format!("unexpected end of file at {o:#x}"))
}

fn u32_at(b: &[u8], o: usize) -> Result<u32, String> {
    b.get(o..o + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
        .ok_or_else(|| format!("unexpected end of file at {o:#x}"))
}

fn u8_at(b: &[u8], o: usize) -> Result<u8, String> {
    b.get(o)
        .copied()
        .ok_or_else(|| format!("unexpected end of file at {o:#x}"))
}

/// A `DeviceSQL` string: short ASCII, long ASCII or UTF-16LE.
fn string_at(b: &[u8], o: usize) -> Result<String, String> {
    let flags = u8_at(b, o)?;
    if flags & 1 == 1 {
        let len = usize::from(flags >> 1).saturating_sub(1);
        let raw = b
            .get(o + 1..o + 1 + len)
            .ok_or("string runs past the end of the file")?;
        return Ok(String::from_utf8_lossy(raw).into_owned());
    }
    let len = usize::from(u16_at(b, o + 1)?);
    let raw = b
        .get(o + 4..o + len.max(4))
        .ok_or("string runs past the end of the file")?;
    match flags {
        0x40 => Ok(String::from_utf8_lossy(raw).into_owned()),
        0x90 => {
            let units: Vec<u16> = raw
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c))
                .collect();
            Ok(String::from_utf16_lossy(&units))
        }
        _ => Ok(String::new()),
    }
}

/// Absolute offsets of every present row in a data page.
fn page_rows(b: &[u8], page: usize) -> Result<Vec<usize>, String> {
    let base = page * PAGE;
    let packed = u32::from(u8_at(b, base + 0x18)?)
        | u32::from(u8_at(b, base + 0x19)?) << 8
        | u32::from(u8_at(b, base + 0x1a)?) << 16;
    let flags = u8_at(b, base + 0x1b)?;
    if flags & 0x40 != 0 {
        return Ok(Vec::new());
    }
    let offsets = (packed & 0x1fff) as usize;
    let mut rows = Vec::new();
    for group in 0..offsets.div_ceil(16) {
        let end = base + PAGE - group * GROUP;
        let present = u16_at(b, end - 4)?;
        for r in 0..16 {
            if group * 16 + r >= offsets {
                break;
            }
            if present >> r & 1 == 1 {
                rows.push(base + HEAP + usize::from(u16_at(b, end - (6 + 2 * r))?));
            }
        }
    }
    Ok(rows)
}

/// Every present row of each table, by table type.
fn table_rows(b: &[u8]) -> Result<HashMap<u32, Vec<usize>>, String> {
    if b.len() < PAGE || u32_at(b, 4)? as usize != PAGE {
        return Err("not a rekordbox database (unexpected page size)".into());
    }
    let tables = u32_at(b, 8)?;
    let pages = b.len() / PAGE;
    let mut out: HashMap<u32, Vec<usize>> = HashMap::new();
    for t in 0..tables as usize {
        let o = 0x1c + 16 * t;
        let ty = u32_at(b, o)?;
        let (first, last) = (u32_at(b, o + 8)? as usize, u32_at(b, o + 12)? as usize);
        let rows = out.entry(ty).or_default();
        let mut page = first;
        // A table never has more pages than the file; this also stops a corrupt loop.
        for _ in 0..pages {
            if page >= pages {
                break;
            }
            rows.extend(page_rows(b, page)?);
            if page == last {
                break;
            }
            page = u32_at(b, page * PAGE + 12)? as usize;
        }
    }
    Ok(out)
}

/// Parses an `export.pdb` file.
pub fn read(b: &[u8]) -> Result<Library, String> {
    let rows = table_rows(b)?;
    let named = |ty: u32, id_at: usize, name_at: usize| -> Result<HashMap<u32, String>, String> {
        let mut m = HashMap::new();
        for &r in rows.get(&ty).into_iter().flatten() {
            m.insert(u32_at(b, r + id_at)?, string_at(b, r + name_at)?);
        }
        Ok(m)
    };
    let genres = named(T_GENRES, 0, 4)?;
    let keys = named(T_KEYS, 0, 8)?;
    let mut artists = HashMap::new();
    for &r in rows.get(&T_ARTISTS).into_iter().flatten() {
        let name_at = if u16_at(b, r)? == 0x64 {
            usize::from(u16_at(b, r + 0x0a)?)
        } else {
            usize::from(u8_at(b, r + 9)?)
        };
        artists.insert(u32_at(b, r + 4)?, string_at(b, r + name_at)?);
    }
    let mut albums = HashMap::new();
    for &r in rows.get(&T_ALBUMS).into_iter().flatten() {
        let name_at = if u16_at(b, r)? == 0x84 {
            usize::from(u16_at(b, r + 0x16)?)
        } else {
            usize::from(u8_at(b, r + 0x15)?)
        };
        albums.insert(u32_at(b, r + 0x0c)?, string_at(b, r + name_at)?);
    }
    let lookup = |m: &HashMap<u32, String>, id: u32| m.get(&id).cloned().unwrap_or_default();

    let mut tracks = Vec::new();
    for &r in rows.get(&T_TRACKS).into_iter().flatten() {
        let s = |slot: usize| -> Result<String, String> {
            string_at(b, r + usize::from(u16_at(b, r + 0x5e + 2 * slot)?))
        };
        tracks.push(Track {
            id: u32_at(b, r + 0x48)?,
            title: s(S_TITLE)?,
            artist: lookup(&artists, u32_at(b, r + 0x44)?),
            album: lookup(&albums, u32_at(b, r + 0x40)?),
            genre: lookup(&genres, u32_at(b, r + 0x3c)?),
            key: lookup(&keys, u32_at(b, r + 0x20)?),
            comment: s(S_COMMENT)?,
            path: s(S_FILE_PATH)?,
            analyze_path: s(S_ANALYZE_PATH)?,
            date_added: s(S_DATE_ADDED)?,
            duration_secs: u16_at(b, r + 0x54)?,
            tempo: u32_at(b, r + 0x38)?,
            bitrate: u32_at(b, r + 0x30)?,
            sample_rate: u32_at(b, r + 0x08)?,
            file_size: u32_at(b, r + 0x10)?,
            year: u16_at(b, r + 0x50)?,
            track_number: u32_at(b, r + 0x34)?,
            file_type: u16_at(b, r + 0x5a)?,
            artwork_id: u32_at(b, r + 0x1c)?,
        });
    }
    tracks.sort_by_key(|t| t.id);

    let mut entries: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
    for &r in rows.get(&T_PLAYLIST_ENTRIES).into_iter().flatten() {
        let (index, track, list) = (u32_at(b, r)?, u32_at(b, r + 4)?, u32_at(b, r + 8)?);
        entries.entry(list).or_default().push((index, track));
    }
    let mut playlists = Vec::new();
    for &r in rows.get(&T_PLAYLIST_TREE).into_iter().flatten() {
        let id = u32_at(b, r + 12)?;
        let mut members = entries.remove(&id).unwrap_or_default();
        members.sort_unstable();
        playlists.push(Playlist {
            id,
            parent_id: u32_at(b, r)?,
            sort_order: u32_at(b, r + 8)?,
            is_folder: u32_at(b, r + 16)? != 0,
            name: string_at(b, r + 20)?,
            track_ids: members.into_iter().map(|(_, t)| t).collect(),
        });
    }
    playlists.sort_by_key(|p| (p.parent_id, p.sort_order, p.id));

    let mut artwork = Vec::new();
    for &r in rows.get(&T_ARTWORK).into_iter().flatten() {
        artwork.push((u32_at(b, r)?, string_at(b, r + 4)?));
    }
    artwork.sort_unstable();
    Ok(Library {
        tracks,
        playlists,
        artwork,
    })
}

/// The header sequence number, which rekordbox bumps on every edit.
pub fn sequence(b: &[u8]) -> Option<u32> {
    u32_at(b, 0x14).ok()
}

// ---------------------------------------------------------------------------------------------
// Writing

fn put_u16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}

fn put_u32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}

/// Encodes a `DeviceSQL` string the way rekordbox does: short ASCII up to 126 bytes, long ASCII
/// beyond that, UTF-16LE for anything non-ASCII.
fn encode_string(s: &str) -> Vec<u8> {
    if s.is_ascii() {
        if s.len() <= 126 {
            let mut v = vec![((s.len() as u8 + 1) << 1) | 1];
            v.extend_from_slice(s.as_bytes());
            return v;
        }
        let mut v = vec![0x40];
        put_u16(&mut v, (s.len() + 4) as u16);
        v.push(0);
        v.extend_from_slice(s.as_bytes());
        return v;
    }
    let units: Vec<u16> = s.encode_utf16().collect();
    let mut v = vec![0x90];
    put_u16(&mut v, (units.len() * 2 + 4) as u16);
    v.push(0);
    for u in units {
        put_u16(&mut v, u);
    }
    v
}

fn named_row(id: u32, name: &str) -> Vec<u8> {
    let mut v = Vec::new();
    put_u32(&mut v, id);
    v.extend(encode_string(name));
    v
}

fn key_row(id: u32, name: &str) -> Vec<u8> {
    let mut v = Vec::new();
    put_u32(&mut v, id);
    put_u32(&mut v, id);
    v.extend(encode_string(name));
    v
}

/// Artist rows carry their position in the page at bytes 2..4; the pager fills it in.
fn artist_row(id: u32, name: &str) -> Vec<u8> {
    let mut v = vec![0x60, 0, 0, 0];
    put_u32(&mut v, id);
    v.extend([0x03, 0x0a]);
    v.extend(encode_string(name));
    v
}

fn album_row(id: u32, artist_id: u32, name: &str) -> Vec<u8> {
    let mut v = vec![0x80, 0, 0, 0];
    put_u32(&mut v, 0);
    put_u32(&mut v, artist_id);
    put_u32(&mut v, id);
    put_u32(&mut v, 0);
    v.extend([0x03, 0x16]);
    v.extend(encode_string(name));
    v
}

fn color_row(id: u8, name: &str) -> Vec<u8> {
    let mut v = vec![0, 0, 0, 0, id, id, 0, 0];
    v.extend(encode_string(name));
    v
}

fn playlist_row(p: &Playlist) -> Vec<u8> {
    let mut v = Vec::new();
    put_u32(&mut v, p.parent_id);
    put_u32(&mut v, 0);
    put_u32(&mut v, p.sort_order);
    put_u32(&mut v, p.id);
    put_u32(&mut v, u32::from(p.is_folder));
    v.extend(encode_string(&p.name));
    v
}

/// A cheap stable hash; rekordbox stores an unexplained per-track number here.
fn fnv(s: &str) -> u32 {
    s.bytes().fold(0x811c_9dc5_u32, |h, c| {
        (h ^ u32::from(c)).wrapping_mul(0x0100_0193)
    })
}

struct TrackIds {
    artist: u32,
    album: u32,
    genre: u32,
    key: u32,
}

fn track_row(t: &Track, ids: &TrackIds) -> Vec<u8> {
    let filename = t.path.rsplit('/').next().unwrap_or_default();
    let mut strings: [&str; TRACK_STRINGS] = [""; TRACK_STRINGS];
    // Slots rekordbox fills with the same values on every track.
    strings[2] = "2";
    strings[3] = "1";
    strings[6] = "ON";
    strings[7] = "ON";
    strings[S_DATE_ADDED] = &t.date_added;
    strings[S_ANALYZE_PATH] = &t.analyze_path;
    strings[S_ANALYZE_DATE] = if t.analyze_path.is_empty() {
        ""
    } else {
        &t.date_added
    };
    strings[S_COMMENT] = &t.comment;
    strings[S_TITLE] = &t.title;
    strings[S_FILENAME] = filename;
    strings[S_FILE_PATH] = &t.path;

    let mut v = Vec::with_capacity(TRACK_HEADER + 256);
    put_u16(&mut v, 0x24);
    put_u16(&mut v, 0); // index shift, filled in by the pager
    put_u32(&mut v, 0x000c_0700);
    put_u32(&mut v, t.sample_rate);
    put_u32(&mut v, 0); // composer
    put_u32(&mut v, t.file_size);
    put_u32(&mut v, fnv(&t.path));
    put_u16(&mut v, 0x0106);
    put_u16(&mut v, 0x8f7d);
    put_u32(&mut v, t.artwork_id);
    put_u32(&mut v, ids.key);
    put_u32(&mut v, 0); // original artist
    put_u32(&mut v, 0); // label
    put_u32(&mut v, 0); // remixer
    put_u32(&mut v, t.bitrate);
    put_u32(&mut v, t.track_number);
    put_u32(&mut v, t.tempo);
    put_u32(&mut v, ids.genre);
    put_u32(&mut v, ids.album);
    put_u32(&mut v, ids.artist);
    put_u32(&mut v, t.id);
    put_u16(&mut v, 0); // disc
    put_u16(&mut v, 0); // play count
    put_u16(&mut v, t.year);
    put_u16(&mut v, 16); // sample depth
    put_u16(&mut v, t.duration_secs);
    put_u16(&mut v, 41);
    v.push(0); // colour
    v.push(0); // rating
    put_u16(&mut v, t.file_type);
    put_u16(&mut v, 3);
    let mut heap = Vec::new();
    for s in strings {
        put_u16(&mut v, (TRACK_HEADER + heap.len()) as u16);
        heap.extend(encode_string(s));
    }
    v.extend(heap);
    v
}

/// Ids handed out in order of first use, starting at 1.
#[derive(Default)]
struct Interner {
    ids: HashMap<String, u32>,
    rows: Vec<Vec<u8>>,
}

impl Interner {
    fn id(&mut self, key: &str, row: impl FnOnce(u32) -> Vec<u8>) -> u32 {
        if key.is_empty() {
            return 0;
        }
        if let Some(&id) = self.ids.get(key) {
            return id;
        }
        let id = self.rows.len() as u32 + 1;
        self.ids.insert(key.to_owned(), id);
        self.rows.push(row(id));
        id
    }
}

/// Whether rows of this table carry their position in the page at bytes 2..4.
fn has_index_shift(ty: u32) -> bool {
    matches!(ty, T_TRACKS | T_ARTISTS | T_ALBUMS)
}

/// Splits rows into data pages: (heap, row offsets).
fn pack(ty: u32, rows: &[Vec<u8>]) -> Vec<(Vec<u8>, Vec<u16>)> {
    let mut pages: Vec<(Vec<u8>, Vec<u16>)> = Vec::new();
    for row in rows {
        let fits = |heap: &Vec<u8>, offs: &Vec<u16>| {
            let groups = (offs.len() + 1).div_ceil(16);
            heap.len() + row.len() + groups * GROUP <= PAGE - HEAP
        };
        if !pages.last().is_some_and(|(h, o)| fits(h, o)) {
            pages.push((Vec::new(), Vec::new()));
        }
        let Some((heap, offs)) = pages.last_mut() else {
            continue;
        };
        let start = heap.len();
        offs.push(start as u16);
        heap.extend_from_slice(row);
        if has_index_shift(ty) {
            let shift = ((offs.len() - 1) as u16 * 0x20).to_le_bytes();
            heap[start + 2] = shift[0];
            heap[start + 3] = shift[1];
        }
        while heap.len() % 4 != 0 {
            heap.push(0);
        }
    }
    pages
}

struct PageHeader {
    index: u32,
    ty: u32,
    next: u32,
    seq: u32,
}

fn write_header(page: &mut [u8], h: &PageHeader) {
    page[4..8].copy_from_slice(&h.index.to_le_bytes());
    page[8..12].copy_from_slice(&h.ty.to_le_bytes());
    page[12..16].copy_from_slice(&h.next.to_le_bytes());
    page[16..20].copy_from_slice(&h.seq.to_le_bytes());
}

fn index_page(h: &PageHeader, first_data: Option<u32>) -> Vec<u8> {
    let mut p = vec![0u8; PAGE];
    write_header(&mut p, h);
    p[0x1b] = 0x64;
    p[0x20..0x24].copy_from_slice(&[0xff, 0x1f, 0xff, 0x1f]);
    p[0x24..0x26].copy_from_slice(&(INDEX_SLOTS as u16).to_le_bytes());
    let mut body = Vec::new();
    put_u32(&mut body, h.index);
    put_u32(&mut body, first_data.unwrap_or(NO_PAGE));
    put_u32(&mut body, NO_PAGE);
    put_u32(&mut body, 0);
    put_u16(&mut body, 0);
    put_u16(&mut body, 0x1fff);
    for _ in 0..INDEX_SLOTS {
        put_u32(&mut body, EMPTY_SLOT);
    }
    p[HEAP..HEAP + body.len()].copy_from_slice(&body);
    p
}

fn data_page(h: &PageHeader, heap: &[u8], offs: &[u16]) -> Vec<u8> {
    let mut p = vec![0u8; PAGE];
    write_header(&mut p, h);
    let n = offs.len() as u32;
    let packed = n | n << 13;
    p[0x18..0x1b].copy_from_slice(&packed.to_le_bytes()[..3]);
    p[0x1b] = 0x24;
    let free = PAGE - HEAP - heap.len() - (offs.len() * 2 + offs.len().div_ceil(16) * 4);
    p[0x1c..0x1e].copy_from_slice(&(free as u16).to_le_bytes());
    p[0x1e..0x20].copy_from_slice(&(heap.len() as u16).to_le_bytes());
    p[0x20..0x22].copy_from_slice(&(n as u16).to_le_bytes());
    p[HEAP..HEAP + heap.len()].copy_from_slice(heap);
    for (g, chunk) in offs.chunks(16).enumerate() {
        let end = PAGE - g * GROUP;
        let present = if chunk.len() == 16 {
            0xffff_u16
        } else {
            (1u16 << chunk.len()) - 1
        };
        p[end - 4..end - 2].copy_from_slice(&present.to_le_bytes());
        p[end - 2..end].copy_from_slice(&present.to_le_bytes());
        for (r, off) in chunk.iter().enumerate() {
            let at = end - (6 + 2 * r);
            p[at..at + 2].copy_from_slice(&off.to_le_bytes());
        }
    }
    p
}

/// Builds a complete `export.pdb`. `sequence` should be higher than that of any database the
/// stick held before, so players that cache a library notice the change.
#[allow(clippy::too_many_lines)] // one pass per table, kept together so the layout reads top to bottom
pub fn write(lib: &Library, sequence: u32) -> Vec<u8> {
    let mut artists = Interner::default();
    let mut albums = Interner::default();
    let mut genres = Interner::default();
    let mut keys = Interner::default();
    let mut track_rows = Vec::with_capacity(lib.tracks.len());
    for t in &lib.tracks {
        let artist = artists.id(&t.artist, |id| artist_row(id, &t.artist));
        let album = if t.album.is_empty() {
            0
        } else {
            albums.id(&format!("{artist}\u{0}{}", t.album), |id| {
                album_row(id, artist, &t.album)
            })
        };
        let ids = TrackIds {
            artist,
            album,
            genre: genres.id(&t.genre, |id| named_row(id, &t.genre)),
            key: keys.id(&t.key, |id| key_row(id, &t.key)),
        };
        track_rows.push(track_row(t, &ids));
    }
    let colors = [
        "Pink", "Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple",
    ]
    .iter()
    .zip(1u8..)
    .map(|(name, id)| color_row(id, name))
    .collect::<Vec<_>>();
    let playlists = lib.playlists.iter().map(playlist_row).collect::<Vec<_>>();
    let mut entries = Vec::new();
    for p in &lib.playlists {
        for (i, track) in p.track_ids.iter().enumerate() {
            let mut v = Vec::new();
            put_u32(&mut v, i as u32 + 1);
            put_u32(&mut v, *track);
            put_u32(&mut v, p.id);
            entries.push(v);
        }
    }
    let artwork = lib
        .artwork
        .iter()
        .map(|(id, path)| named_row(*id, path))
        .collect::<Vec<_>>();
    let template = |rows: &[&[u8]]| rows.iter().map(|r| r.to_vec()).collect::<Vec<_>>();

    let mut tables: Vec<Vec<Vec<u8>>> = vec![Vec::new(); TABLES as usize];
    tables[T_TRACKS as usize] = track_rows;
    tables[T_GENRES as usize] = genres.rows;
    tables[T_ARTISTS as usize] = artists.rows;
    tables[T_ALBUMS as usize] = albums.rows;
    tables[T_KEYS as usize] = keys.rows;
    tables[T_COLORS as usize] = colors;
    tables[T_PLAYLIST_TREE as usize] = playlists;
    tables[T_PLAYLIST_ENTRIES as usize] = entries;
    tables[T_ARTWORK as usize] = artwork;
    tables[T_COLUMNS as usize] = template(&templates::COLUMNS);
    tables[T_MENU as usize] = template(&templates::MENU);
    tables[T_MENU_ITEMS as usize] = template(&templates::MENU_ITEMS);

    let page_seq = sequence.saturating_sub(1).max(1);
    let mut pages: Vec<Vec<u8>> = vec![vec![0u8; PAGE]];
    let mut pointers = Vec::new();
    for (ty, rows) in (0u32..).zip(&tables) {
        let packed = pack(ty, rows);
        let index_no = pages.len() as u32;
        let data_nos: Vec<u32> = (0..packed.len() as u32).map(|i| index_no + 1 + i).collect();
        // A spare zeroed page rekordbox keeps after each table for the next row it adds.
        let spare = index_no + 1 + packed.len() as u32;
        let header = |index: u32, next: u32| PageHeader {
            index,
            ty,
            next,
            seq: page_seq,
        };
        pages.push(index_page(
            &header(index_no, data_nos.first().copied().unwrap_or(spare)),
            data_nos.first().copied(),
        ));
        for (i, (heap, offs)) in packed.iter().enumerate() {
            let next = data_nos.get(i + 1).copied().unwrap_or(spare);
            pages.push(data_page(&header(data_nos[i], next), heap, offs));
        }
        pages.push(vec![0u8; PAGE]);
        pointers.push((
            ty,
            spare,
            index_no,
            data_nos.last().copied().unwrap_or(index_no),
        ));
    }

    let total = (pages.len() as u32).to_le_bytes();
    let header = &mut pages[0];
    header[4..8].copy_from_slice(&(PAGE as u32).to_le_bytes());
    header[8..12].copy_from_slice(&TABLES.to_le_bytes());
    header[12..16].copy_from_slice(&total);
    header[16..20].copy_from_slice(&1u32.to_le_bytes());
    header[20..24].copy_from_slice(&sequence.to_le_bytes());
    for (i, (ty, spare, first, last)) in pointers.into_iter().enumerate() {
        let o = 0x1c + 16 * i;
        for (j, x) in [ty, spare, first, last].into_iter().enumerate() {
            header[o + 4 * j..o + 4 * j + 4].copy_from_slice(&x.to_le_bytes());
        }
    }
    pages.concat()
}

#[cfg(test)]
#[allow(clippy::expect_used)] // tests: panicking is the failure mode
mod tests {
    use super::*;

    fn track(id: u32, title: &str, artist: &str, album: &str) -> Track {
        Track {
            id,
            title: title.into(),
            artist: artist.into(),
            album: album.into(),
            genre: "Dubstep".into(),
            key: "8A".into(),
            path: format!("/Contents/{artist}/{album}/{title}.mp3"),
            date_added: "2026-11-15".into(),
            duration_secs: 245,
            tempo: 14000,
            bitrate: 320,
            sample_rate: 44100,
            file_size: 9_000_000,
            year: 2024,
            track_number: id,
            file_type: 1,
            ..Track::default()
        }
    }

    #[test]
    fn strings_round_trip_in_every_encoding() {
        for s in [
            "",
            "Burial",
            &"x".repeat(126),
            &"y".repeat(300),
            "Björk – Jóga",
            "日本",
        ] {
            let mut b = encode_string(s);
            b.resize(b.len() + 8, 0);
            assert_eq!(string_at(&b, 0).as_deref(), Ok(s));
        }
        // Rekordbox's own short form: length + 1, shifted, low bit set.
        assert_eq!(encode_string("Pink"), b"\x0bPink");
    }

    #[test]
    fn library_round_trips() {
        let mut tracks: Vec<Track> = (1..=60)
            .map(|i| {
                track(
                    i,
                    &format!("Song {i}"),
                    &format!("Artist {}", i % 7),
                    "Album",
                )
            })
            .collect();
        tracks[3].artist = "Sigur Rós".into();
        tracks[4].album = String::new();
        tracks[5].key = String::new();
        tracks[6].path = format!("/Contents/{}/long.mp3", "deep/".repeat(40));
        let lib = Library {
            tracks,
            playlists: vec![
                Playlist {
                    id: 1,
                    name: "Folder".into(),
                    is_folder: true,
                    ..Playlist::default()
                },
                Playlist {
                    id: 2,
                    parent_id: 1,
                    name: "Peak time".into(),
                    track_ids: (1..=40).rev().collect(),
                    ..Playlist::default()
                },
                Playlist {
                    id: 3,
                    sort_order: 1,
                    name: "Empty".into(),
                    ..Playlist::default()
                },
            ],
            artwork: vec![(1, "/PIONEER/Artwork/00001/a1.jpg".into())],
        };
        let bytes = write(&lib, 7);
        assert_eq!(bytes.len() % PAGE, 0);
        assert_eq!(sequence(&bytes), Some(7));
        let mut back = read(&bytes).expect("parses");
        back.playlists.sort_by_key(|p| p.id);
        assert_eq!(back, lib);
    }

    #[test]
    fn tracks_spill_onto_more_pages() {
        let lib = Library {
            tracks: (1..=500)
                .map(|i| track(i, &format!("Song {i}"), "A", "B"))
                .collect(),
            ..Library::default()
        };
        let bytes = write(&lib, 2);
        let rows = table_rows(&bytes).expect("parses");
        assert_eq!(rows[&T_TRACKS].len(), 500);
        assert!(bytes.len() / PAGE > 60);
        assert_eq!(read(&bytes).expect("parses").tracks.len(), 500);
    }

    #[test]
    fn rejects_garbage() {
        assert!(read(&[0u8; 100]).is_err());
        assert!(read(&vec![0xffu8; PAGE * 2]).is_err());
    }

    /// Reads a real stick: `MANPLAY_PDB=/Volumes/USB/PIONEER/rekordbox/export.pdb cargo test
    /// -- --ignored real_export --nocapture`.
    #[test]
    #[ignore = "needs a real export.pdb"]
    fn real_export() {
        let path = std::env::var("MANPLAY_PDB").expect("MANPLAY_PDB");
        let bytes = std::fs::read(path).expect("readable");
        let lib = read(&bytes).expect("parses");
        for p in &lib.playlists {
            println!("{} ({} tracks)", p.name, p.track_ids.len());
        }
        for t in &lib.tracks {
            println!(
                "{:>3} {:>6.2} {:>4} {} – {} [{}]",
                t.id,
                f64::from(t.tempo) / 100.0,
                t.key,
                t.artist,
                t.title,
                t.path
            );
        }
        // Rewriting what we read must read back the same.
        let rewritten = write(&lib, sequence(&bytes).unwrap_or(1) + 1);
        if let Ok(out) = std::env::var("MANPLAY_PDB_OUT") {
            std::fs::write(out, &rewritten).expect("writable");
        }
        let again = read(&rewritten).expect("parses");
        assert_eq!(again.tracks, lib.tracks);
    }
}
