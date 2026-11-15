# OneLibrary (`exportLibrary.db`) research note

Date: 2026-11-15. Sources: pyrekordbox `onelibrary/` module and `docs/source/formats/onelibrary.md`
(master branch), AlphaTheta's USB notice, the 0xdevalias gist on the key, baken PR #244 (a Rust
OneLibrary writer), blackboxaudio/crate issue #205, and the NOCTURN drive.

## 1. Encryption: solved, verified in Rust

- SQLCipher 4 with default settings: page size 4096, PBKDF2-HMAC-SHA512, 256000 iterations,
  HMAC-SHA512. Verified with `pragma cipher_*` on the NOCTURN file.
- One fixed passphrase for every drive (not tied to a licence or machine). pyrekordbox ships it
  obfuscated: base85-decode `BLOB` (in `pyrekordbox/onelibrary/database.py`), XOR with
  `657f48f84c437cc1` repeating, zlib-inflate. The result is a 64-character string starting `r8gd`.
  Store it the same obfuscated way in manplay (`flate2`/a base85 crate, or just the decoded bytes).
- Rust: `rusqlite = { version = "0.41.1", features = ["bundled-sqlcipher"] }`, then
  `conn.pragma_update(None, "key", KEY)` right after `open`. Prototype in the scratchpad opened and
  decrypted all three NOCTURN copies (`cipher_version` = 4.19.0 community).
  - macOS: libsqlite3-sys uses CommonCrypto (`-DSQLCIPHER_CRYPTO_CC`, links `Security.framework`),
    no OpenSSL needed. CI and release are macOS-only, so this is all we need.
  - Windows/Linux later: `bundled-sqlcipher-vendored-openssl` (builds OpenSSL from source).
  - The feature replaces plain bundled SQLite for the whole app. Unencrypted databases (manplay's
    own) open unchanged when no key is set. Cost: longer clean build.
- Writing: rekordbox's file is in WAL mode. Build the new database in a temp file, checkpoint
  (`pragma wal_checkpoint(TRUNCATE)`, then `journal_mode=DELETE` or close), so the drive gets one file
  with no `-wal`/`-shm`. Delete any old `-wal`/`-shm` on the drive **before** replacing the db, or
  SQLite replays the stale WAL into the new file (baken's finding).

## 2. Schema (22 tables, 4 indexes; identical across all three NOCTURN copies)

Full `CREATE` statements: copy verbatim from the NOCTURN file (dumped to the scratchpad
`schema.txt`). Tables a player needs, with values seen in rekordbox's own 41-track export:

| Table | Key columns | Notes from the real export |
|---|---|---|
| `content` | `content_id`, `title`, `artist_id_artist`, `album_id`, `genre_id`, `key_id`, `image_id`, `bpmx100`, `length` (seconds, not ms as pyrekordbox says), `path` (`/Contents/...`), `fileName`, `fileSize`, `fileType` (1 = mp3, same codes as export.pdb), `bitrate`, `bitDepth`, `samplingRate`, `dateAdded`/`dateCreated` (`YYYY-MM-DD`), `analysisDataFilePath` (`/PIONEER/USBANLZ/.../ANLZ0000.DAT`) | Empty strings for missing text; NULL for missing remixer/composer/label/genre; 0 for lyricist and colour. `analysedBits` 105 or 41, `contentLink` 853760 or 788224, `isHotCueAutoLoadOn` 1, `isKuvoDeliverStatusOn` 1, `masterDbId`/`masterContentId` = rekordbox collection ids |
| `artist`, `album`, `genre`, `label`, `key` | `*_id`, `name` | `key.name` is Camelot (`11A`); `album.artist_id`, `album.image_id` |
| `image` | `image_id`, `path` | `/PIONEER/Artwork/00001/b1.jpg`, same ids as export.pdb artwork |
| `playlist` | `playlist_id`, `sequenceNo`, `name`, `attribute` (0 list, folder value unknown, likely 1), `playlist_id_parent` (0 = root) | |
| `playlist_content` | `playlist_id`, `content_id`, `sequenceNo` (from 1) | |
| `property` | one row: `deviceName` '', `dbVersion` '1000', `numberOfContents`, `createdDate`, `backGroundColorType` 0, `myTagMasterDBID` | |
| `menuItem` (27), `category` (22), `sort` (17), `color` (8), `myTag` (28 default) | fixed rows | Copy from the real export; they drive the player's browse menu |
| `cue`, `history*`, `hotCueBankList*`, `myTag_content`, `recommendedLike` | | Empty in this export |

**Consistency check done:** rekordbox's `export.pdb` and `exportLibrary.db` (backup `2026-11-15-151958`)
agree on all 41 tracks: same `content_id`, `path`, `analysisDataFilePath`, `image_id` and key name. So
manplay can reuse its `pdb::Library` ids directly. They disagreed on playlists (pdb: 1, OneLibrary: 5),
matching AlphaTheta's warning that playlists can differ between the two; manplay should write both
from one list.

## 3. Which player reads what

- AlphaTheta: OneLibrary for CDJ-3000X, OPUS-QUAD, OMNIS-DUO, XDJ-AZ. Device Library (export.pdb)
  for CDJ-3000, XDJ-XZ, XDJ-RX3, XDJ-RR, CDJ-2000NXS2 and older, XDJ-1000MK2, XDJ-700, CDJ-900NXS2.
  rekordbox 7.2.11+ writes both.
- CDJ-3000 firmware 3.30: "OneLibrary is prioritized during loading". 3.22 (listed as latest; 3.30 was
  reportedly withdrawn) reads only export.pdb. A developer test on 3.2x: a OneLibrary-only stick
  showed nothing. So a stale `exportLibrary.db` next to a fresh `export.pdb` shows old content on
  3.30: always write both, or remove both.

## 4. Drive state observed

- `PIONEER/rekordbox/exportLibrary.db` now: empty skeleton (0 tracks, `dbVersion` 10000),
  re-created at 15:50 after manplay's 15:48 export moved the real one. Probably rekordbox
  initialising the mounted drive (playlists3*.sync have the same time). Unconfirmed.
- `manplay-backup/2026-11-15-151958/`: the real rekordbox OneLibrary (db + wal + shm). Test fixture.
- `manplay-backup/2026-11-15-154847/`: another empty skeleton.

## 5. Unknown

1. Whether any OneLibrary player accepts a third-party file. No public hardware report yet (baken
   and crate both wait on one). Needs a test on an XDJ-AZ / Opus Quad / Omnis Duo / CDJ-3000X.
2. Meaning of `analysedBits`, `contentLink`, `masterDbId`; whether 0 or omitted values are fine.
   Plan: copy rekordbox's values (41, 788224) for tracks manplay analysed.
3. Whether players need `cue` rows or read cues from ANLZ only (manplay writes no cues today).
4. `playlist.attribute` value for folders; `property.dbVersion` 1000 vs 10000.
5. `exportExt.pdb` / `playlists3Plus.sync`: rekordbox writes them; baken says they are optional.

## 6. Remaining work estimate (agent time, excluding hardware testing)

| Step | Hours |
|---|---|
| 2. Reader + key + tests on a decrypted fixture | 2–3 |
| 3. Writer, wiring into `usb_export.rs`, merge with existing rekordbox content, drop backup move | 5–7 |
| 4. Drive view: formats present and players covered | 1–2 |
| Total | 8–12 |

Fixture: the real db is 131 KB + 247 KB WAL. Commit a checkpointed copy (one file, ~130 KB, contains
track names and paths from the user's library) or a trimmed one. Decide before step 2.
