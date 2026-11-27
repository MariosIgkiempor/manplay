# Shared library: plan

Date: 2026-11-16. Status: planned, nothing built yet.

Sync manplay's own data (tags, playlists, smart playlists, beat grids, BPM/key, waveforms) between
everyone connected to the same destination, not just the audio files.

## Constraints

- Jellyfin keeps reading the destination as a plain music folder.
- Several people can share one library at once.
- No server: destinations are WebDAV (over Tailscale) or R2. No locks, no append, no transactions.
- Any shared item can be made local-only.

## Principles

1. **Edited by people → ops.** Each device writes its changes to its own log files on the
   destination. Every device rebuilds its shared tables by replaying everyone's ops.
2. **Computed from audio → files.** Waveforms are write-once files named by audio.
3. **Machine-specific → never synced.** Cues, settings, destinations, caches, history.
4. **A device writes only its own files.** No two devices ever write the same path (except
   write-once waveform files, where whoever uploads first wins and the result is the same).
5. **Track identity is `audio_fp`** (audio only, see `src-tauri/src/audioprint.rs`). It survives
   retags, renames and moves. The whole-file `fingerprint` stays for file-sync diffs.
6. **All times are UTC.** Unix seconds in the database; op clocks are UTC milliseconds. Shown
   in local time.
7. **Flag breaking changes.** Any change to stored data (re-keying, new required columns,
   changed file formats) is listed in the PR with whether old data is migrated or dropped.

## Data after the change

### Destination

```
<library root>/
  Artist/Album/01 Song.flac                      audio; Jellyfin reads this
  .manplay/                                      dot-folder: Jellyfin skips it
    .ignore                                      belt and braces for Jellyfin
    library.json                                 {format, libraryId, name, createdAt}
    devices/<device-id>.json                     {name, lastSeen} — member list for the join dialog
    log/<device-id>/<seq>.jsonl.gz               immutable op chunks, one per sync run
    snapshot/<device-id>-<clock>.jsonl.gz        compacted state; newest wins
    waveforms/<ab>/<audio_fp>-v<version>.bin     one per track, write-once
```

### Each device

| Where | What | Synced |
|---|---|---|
| `library.db` shared tables | `tags`, `track_tags`, `playlists`, `playlist_tracks`, `smart_playlists`, `tag_custom`, `analysis` grid/BPM/key | ops |
| `library.db` `analysis.waveform` | waveform blob | files |
| `library.db` local tables | `cues`, `settings`, `sync_targets`, `synced_files`, `sync_runs`, `import_cache`, `itunes_imported`, `activity`, `remote_prints`, `stale_remote`, `export_selections`, `tag_values` | no |
| `library.db` new sync state | scope per item, clashes, applied-op cursor per device, tombstones, device ID | no |
| OS keychain | R2 credentials (`manplay-r2`) | no |
| webview `localStorage` | pane widths, collapsed sections, view toggles | no |
| cache dir | art thumbnails, import previews | no (regenerated) |

`tag_values` stays local: it is rebuilt from the audio on every scan, so every device already
ends up with the same list. `tag_custom` (values typed by hand in the Tag Database) is shared.

## Steps

| # | File | What | Estimate |
|---|---|---|---|
| 0 | [00-three-way-file-compare.md](00-three-way-file-compare.md) | Fix file sync: compare against the last synced version, pull remote edits, merge tags | 1 day |
| 1 | [01-audio-fp-identity.md](01-audio-fp-identity.md) | `analysis` keyed by `audio_fp`, fill it for every track, Duplicates notice | ½ day |
| 2 | [02-op-log.md](02-op-log.md) | Op format, clocks, log files, UUIDs, scope; tags + playlists sync | 1 day |
| 3 | [03-analysis-smart-waveforms.md](03-analysis-smart-waveforms.md) | Smart playlists, grid/BPM/key ops, `tag_custom`, waveform files | 1 day |
| 4 | [04-clashes-and-local-tags.md](04-clashes-and-local-tags.md) | Clashes list, smart-playlist local-tag dialog, shared↔local | 1 day |
| 5 | [05-join-and-leave.md](05-join-and-leave.md) | Join/leave flows, one shared library per device | ½ day |
| 6 | [06-compaction.md](06-compaction.md) | Snapshots, tombstones, Recently deleted | ½ day |
| 7 | [07-edge-cases.md](07-edge-cases.md) | Clock cap, cloned IDs, safe writes, unknown ops, rename races | 1 day |
| 8 | [08-jellyfin-playlists.md](08-jellyfin-playlists.md) | Push chosen playlists to a Jellyfin server through its API | 3 days |
| 9 | [09-streaming.md](09-streaming.md) | See and play every song without downloading it; keep chosen songs, albums, playlists | 6 days |

Total about 6½ days. Step 0 is useful on its own and ships first. Each step ends with
`pnpm verify`, `cargo clippy` and `cargo test` passing (see `CLAUDE.md`).

## Sizes (20k-track library)

- Ops, compacted: ~40 MB raw JSONL, ~6 MB gzipped. Edits add ~5 MB/year before compaction.
- Waveforms: 150 columns/s (`analysis::WAVEFORM_RATE`), ~54 KB for 6 min, ~540 KB for a 1 h
  mix. ~1 GB total. Cap: 1 MB per track.

## Out of scope

- Access control: anyone with write access to the destination can change shared data.
  Recently deleted (step 6) limits the damage.
- Syncing cues.
