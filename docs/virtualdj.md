# VirtualDJ library on a drive (`VirtualDJ/`) research note

Date: 2026-11-21. Sources: VirtualDJ's wiki (`virtualdj.com/wiki/VDJ_database.html`,
`virtualdj.com/wiki/lists.html`) and forum posts by its staff and users quoting their own files.
No drive written by manplay has been opened in VirtualDJ yet, and no VirtualDJ install was at hand
to compare against. What is unconfirmed is listed in section 5. Atomix says other apps may read
the database and that writing it is at the writer's risk.

## 1. Layout on the drive

```
VirtualDJ/
  database.xml               the drive's songs: tags, cues, VirtualDJ's own analysis
  MyLists/<name>.vdjfolder   one list (playlist) per file, VirtualDJ 2024 and later
```

VirtualDJ keeps a database on every drive it has seen songs on, in a `VirtualDJ` folder at the
drive's root, and the same drive is read and written by VirtualDJ on a Mac and on a PC (staff).
Lists whose songs are all on one external drive are kept on that drive in `VirtualDJ/MyLists`
(users call this "hotplug"). Before 2024 playlists were `.m3u` files in `VirtualDJ/Playlists`;
manplay does not write those.

## 2. `database.xml`

UTF-8, CRLF line ends, one space before `<Song>` and two before what it holds. Staff say
VirtualDJ is "picky" about that indentation.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<VirtualDJ_Database Version="8.4">
 <Song FilePath="E:\Contents\Burial\Untrue\01 Archangel.mp3" FileSize="8349163">
  <Tags Author="Burial" Title="Archangel" Genre="Dubstep" Album="Untrue" Bpm="0.428571" Key="Am" />
  <Infos SongLength="238.000000" FirstSeen="1795000000" />
  <Poi Name="Drop" Pos="12.500000" Num="1" Type="cue" Color="4294901760" />
 </Song>
</VirtualDJ_Database>
```

| Where | Value |
|---|---|
| `Song FilePath` | Full path on the computer the drive is in: `E:\…` on Windows, `/Volumes/<name>/…` on macOS. |
| `Song FileSize` | Bytes. |
| `Tags Bpm` | Seconds between two beats, six decimals: `60 / BPM` (wiki). |
| `Tags Key` | Text, as the tag has it. manplay writes what the drive's library shows (`Am` or `8A`). |
| `Infos SongLength` | Seconds. |
| `Infos FirstSeen` | Unix seconds, UTC. |
| `Poi Pos` | Seconds from the start of the file. |
| `Poi Num` | Cue number from 1. |
| `Poi Type` | `cue`; VirtualDJ also writes `beatgrid`, `automix`, `action`, which manplay does not. |
| `Poi Color` | `0xAARRGGBB` in decimal (`4294901760` is opaque red). |

manplay writes no `<Scan>` (VirtualDJ's own analysis: tempo, key, gain), so VirtualDJ analyses a
song the first time it loads it, as it would any new file.

## 3. `.vdjfolder`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<VirtualFolder noDuplicates="no" ordered="yes">
	<song path="E:\Contents\Burial\Untrue\01 Archangel.mp3" size="8349163" songlength="238.0" artist="Burial" title="Archangel" idx="0" />
</VirtualFolder>
```

Only `path` (absolute) is required; `size` is "highly recommended" so VirtualDJ finds the song in
its database (wiki). `idx` counts from 0 in an ordered list.

## 4. What manplay does

- Adds the exported playlists' songs to `database.xml`. A record already there is kept as it is
  (VirtualDJ's analysis, cues and play counts), except its `FilePath`, which is rewritten to where
  the drive is now. Songs the export deleted or moved leave it.
- Cues set in manplay go in for songs new to the database: a hot cue keeps its pad (A is 1), the
  memory cues take the numbers left free.
- Writes one list per exported playlist and removes the lists of playlists the export took off the
  drive. Lists made in VirtualDJ are left alone.
- Copies every file it replaces or removes into `PIONEER/manplay-backup/<stamp>/VirtualDJ/` first.
  An unreadable `database.xml` is left alone and the export reports it.

## 5. Unconfirmed

- **Paths after the drive moves.** Users report VirtualDJ follows a changed drive letter. Whether
  it reads `/Volumes/…` paths on a PC, or `E:\…` on a Mac, is not documented, which is why every
  export rewrites the paths and the app says to export again after moving between the two.
- **Lists showing up by themselves.** That VirtualDJ lists every `.vdjfolder` in a drive's
  `VirtualDJ/MyLists` when the drive is plugged into a computer that has not seen it comes from
  user reports only. If it does not, the folder can be opened from Local Music > the drive.
- **`Version="8.4"`** is what a 2020 file held; newer versions are expected to bring it up to date.
- **`Poi Color`** is taken from one staff-era example of an `action` point.
- **Beat grids** (`Poi Type="beatgrid"`, `Scan`) are not written: how VirtualDJ treats a grid with
  no scan of its own is unknown.
