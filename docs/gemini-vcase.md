# Gemini V-CASE (`GEMINI/`) research note

Date: 2026-11-21. Source: static analysis of Rekordbox2Gemini 1.0
(`github.com/tr3asureisland/Rekordbox2Gemini`, commit `b52bfc6`), a PyInstaller app that writes the
V-CASE drive layout from a rekordbox export. It was unpacked and disassembled (Python 3.12 bytecode)
in an offline sandbox and never run. Its licence allows taking it apart and reuse. Nothing here has
been checked against a drive written by V-CASE itself or on a player.

Its author tested on an **MDJ-900, firmware 6.10** only. The `ext_db_type` marker names the
MDJ-500, so the same layout is expected to work there, but that is unverified.

## 1. Layout on the drive

```
GEMINI/
  gemini_bd.sqlite      track database (plain SQLite, not encrypted)
  ext_db_type           the 32 bytes "MDJ-1000/MDJ-900/MDJ-600/MDJ-500", no newline
  Playlists/<name>.m3u  one playlist per file
  wf/<id>               detail waveform, file name is the track id, no extension
  fwf/<id>              overview waveform
  covers/<id>           artwork
```

`GEMINI/` sits beside `PIONEER/` and the audio files; the two libraries do not touch each other.

## 2. `gemini_bd.sqlite`

`PRAGMA page_size = 1024`, `journal_mode = DELETE`, one table:

```sql
CREATE TABLE outer_table('id' integer PRIMARY KEY,'title' text,'artist' text,'album' text,
'genre' text,'bpm' float,'absolute_path' text NOT NULL UNIQUE,'bitrate' integer,'cue' text,
'duration_in_frames' integer,'have_cover' text,'have_cue' text,'have_loop' text,'hcue1' text,
'hcue2' text,'hcue3' text,'hcue4' text,'hcue5' text,'hcue6' text,'hcue7' text,'hcue8' text,
'is_unsupported' text,'loop_in' integer,'loop_out' integer,'offset' integer,'samplerate' integer,
'sync_path' text,'bitdepth' integer,'channel' integer,'unsupported_reason' text)
```

| Column | Value |
|---|---|
| `id` | Track id; also the file name under `wf/`, `fwf/`, `covers/`. Keep ids stable across exports (reuse the id of a row with the same `absolute_path`, new tracks get max + 1). |
| `absolute_path` | Path from the drive root with a leading slash, `/Contents/Artist/Album/Song.mp3`. |
| `sync_path` | The file name only (last path segment). |
| `bpm` | BPM as a float. |
| `bitrate` | Bits per second (kbps × 1000). |
| `samplerate`, `bitdepth`, `channel` | Defaults 44100, 16, 2. |
| `duration_in_frames` | Seconds × 588. Use the same length the waveform covers. |
| `offset` | First beat of the grid: `round(first_beat_ms × 44.1)`, i.e. samples at 44.1 kHz. 0 without a grid. There is no other grid data: the player has BPM plus this anchor, so a variable-tempo grid cannot be carried. |
| `cue` | Main cue as `0:0:<n>`, `n = round(ms × 300 / 1000)`; `''` when none. The tool uses the first memory cue, else the first beat. |
| `hcue1`..`hcue8` | Hot cues A–H, same `0:0:<n>` form, `''` when unset. |
| `loop_in`, `loop_out` | One loop, same `0:0:<n>` form (text in integer columns), `''` when none. |
| `have_cue`, `have_loop`, `have_cover` | `'yes'` / `'no'`. |
| `is_unsupported` | `'no'`; `unsupported_reason` NULL. |

Written to a temp file and renamed over the old one.

## 3. Playlists

`GEMINI/Playlists/<name>.m3u`, UTF-8, `\n` line ends, one `absolute_path` per line, no `#EXTM3U`
header.

- The player reads at most **100** playlists.
- A line longer than **255 bytes** (UTF-8) is not read.
- File names: replace `\ / : * ? " < > |` and control characters with `_`, trim spaces and dots,
  cap at 100 characters, unique ignoring case (FAT32). No folders: flatten as `Folder - Playlist`.
- The player only loads **mp3 and wav** from playlists (other formats can sit in the database).
- macOS `._*` and `.DS_Store` files inside `GEMINI/` must be removed: the player reads `._x.m3u` as
  a playlist.

## 4. Waveforms

Derived from rekordbox's PWV3 detail waveform (150 columns per second, height in the low 5 bits).

- `wf/<id>`: `u32` LE peak, then one `u16` LE per 1/75 s (588 samples at 44.1 kHz), then zero padding
  so the file is `4 + 4 × entries` bytes. Each entry is `(h[2i] + h[2i+1]) × 528` with `h` the 5-bit
  PWV3 heights; `peak` is the largest entry. From our own analysis this is an amplitude envelope at
  75 Hz scaled to the same range (max 62 × 528 = 32736).
- `fwf/<id>`: 480 bytes. Byte 0 is 20, then 479 columns, each `min(20, round(mean / top × 20))` where
  `mean` is the average of the `wf` entries in that equal slice of the track and `top` the largest
  mean.
- Skipped when the track has fewer than 480 entries or is silent; the player then analyses the song
  itself on load.

## 5. Covers

`covers/<id>`: 85 × 85 pixels, RGB565 little-endian, raw (14450 bytes), centre-cropped to a square
and scaled down with an area average. `r >> 3 << 11 | g >> 2 << 5 | b >> 3`.

## 6. In manplay

`src-tauri/src/gemini.rs` writes this layout from the drive's rekordbox library after a USB export
(the "Gemini MDJ library" switch under "Formats", remembered per drive; rekordbox is a switch
there too, and need not be on) and after a playlist
edit on a drive that already has it. Differences from the converter:

- Track ids are the rekordbox library's ids, so the whole folder is rewritten each time and files
  for ids no longer in the library are removed.
- Cues set in manplay win over the drive's analysis files; the start cue becomes `cue`.
- Covers also come from the artwork embedded in the library's copy of a song.
- The previous database and playlists are copied to `PIONEER/manplay-backup/<stamp>/GEMINI` first.
- It is made from the drive's list of songs and playlists and the analysis files in
  `PIONEER/USBANLZ`, which are written for it even when no rekordbox library is. That list is
  `export.pdb` when rekordbox is on and `.manplay/library.pdb` (same format) when it is off.

### Playlist folders (`Playlists/`)

Tested on an MDJ-500 (firmware 6.6.0, 2026-11-21): it opens the database and loads cues for a song
picked from the folder browser, but shows no playlist view, and its manual describes none. So
"Playlists as folders" (`src-tauri/src/playlist_folders.rs`, its own switch, not tied to Gemini)
lays the songs out as `Playlists/<playlist>/<NN> <file name>`, numbered in playlist order.

- A song is stored once where it can be: the file in its first playlist's folder is the song
  itself, and every library (rekordbox, Serato, Gemini) points at it there instead of `Contents`.
- Only a song in several playlists is stored again, as a copy in each further folder. In the
  Gemini database each copy gets its own row (ids after the library's), waveform and cover,
  because the player matches a song by `absolute_path`.
- A song no playlist holds stays in, or goes back to, `Contents`. Switching the option off moves
  everything back.
- `.manplay/playlist-folders.txt` lists the copies (`<track id>\t<path>`); only listed
  files are ever replaced or removed, and a file that is not manplay's is never overwritten.
- Songs are renamed before the libraries are written and copied after, so a drive pulled during
  the copying still has libraries that name files that exist.

The player browses any folder, so the top folder's name is ours. A user reported that V-CASE
syncs songs into a `V-Sync` folder; that was not verified and nothing depends on it.

## 7. Open questions

- Not verified on an MDJ-500, nor against a real V-CASE export.
- Whether the MDJ-500's small screen uses `wf`, `fwf` or `covers` at all.
- Whether the settings files V-CASE can write live in `GEMINI/` too (the tool writes none).
