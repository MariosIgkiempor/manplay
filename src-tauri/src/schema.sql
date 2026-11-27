-- The library database at its newest layout (`db::SCHEMA_VERSION`). A new database is made from
-- this; an existing one is brought here by the steps in `db::MIGRATIONS`. A change to a table
-- goes in both: here, and as a new migration step.

CREATE TABLE IF NOT EXISTS tracks (
    id     INTEGER PRIMARY KEY,
    path   TEXT NOT NULL UNIQUE,
    artist TEXT NOT NULL,
    album  TEXT NOT NULL,
    title  TEXT NOT NULL,
    size   INTEGER NOT NULL,
    missing_since INTEGER,
    fingerprint TEXT,
    duration_ms INTEGER,
    bitrate INTEGER,
    sample_rate INTEGER,
    tag_bpm REAL,
    tag_key TEXT,
    fields TEXT,
    added_at INTEGER,
    audio_fp TEXT,
    mtime_ms INTEGER,
    file_state TEXT NOT NULL DEFAULT 'here' CHECK (file_state IN ('here', 'streamed'))
);

CREATE TABLE IF NOT EXISTS playlists (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    uid TEXT,
    scope TEXT NOT NULL DEFAULT 'shared',
    hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    pos TEXT,
    PRIMARY KEY (playlist_id, track_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_targets (
    id      INTEGER PRIMARY KEY,
    tailnet TEXT NOT NULL,
    machine TEXT NOT NULL,
    path    TEXT NOT NULL,
    libsync INTEGER NOT NULL DEFAULT 0,
    UNIQUE (tailnet, machine, path)
);

CREATE TABLE IF NOT EXISTS synced_files (
    target_id INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
    track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    size      INTEGER NOT NULL,
    synced_at INTEGER NOT NULL,
    local_sig TEXT,
    remote_sig TEXT,
    base_tags TEXT,
    base_content TEXT,
    base_modified INTEGER,
    base_version TEXT,
    PRIMARY KEY (target_id, track_id)
);

CREATE TABLE IF NOT EXISTS sync_runs (
    id          INTEGER PRIMARY KEY,
    target_id   INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    uploaded    INTEGER NOT NULL,
    skipped     INTEGER NOT NULL,
    failed      INTEGER NOT NULL,
    first_error TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    errors TEXT NOT NULL DEFAULT '[]',
    batch INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    uid TEXT,
    scope TEXT NOT NULL DEFAULT 'shared',
    hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS track_tags (
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (track_id, tag_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS tags_uid ON tags(uid);

CREATE UNIQUE INDEX IF NOT EXISTS playlists_uid ON playlists(uid);

CREATE TABLE IF NOT EXISTS oplog (
    clock    TEXT PRIMARY KEY,
    dev      TEXT NOT NULL,
    e        TEXT NOT NULL,
    id       TEXT NOT NULL,
    f        TEXT NOT NULL,
    val      TEXT NOT NULL,
    uploaded INTEGER NOT NULL DEFAULT 0,
    seq INTEGER
);

CREATE TABLE IF NOT EXISTS op_cursor (
    dev TEXT PRIMARY KEY,
    seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS op_state (
    e     TEXT NOT NULL,
    id    TEXT NOT NULL,
    f     TEXT NOT NULL,
    clock TEXT NOT NULL,
    val   TEXT NOT NULL,
    ref   TEXT,
    PRIMARY KEY (e, id, f)
);

CREATE INDEX IF NOT EXISTS op_state_ref ON op_state(e, ref);

CREATE INDEX IF NOT EXISTS op_state_merge ON op_state(e, val) WHERE f = '_merge';

CREATE TABLE IF NOT EXISTS op_unknown (
    clock TEXT PRIMARY KEY,
    op    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clashes (
    id    INTEGER PRIMARY KEY,
    kind  TEXT NOT NULL,
    name  TEXT NOT NULL,
    keeps TEXT NOT NULL,
    held  TEXT NOT NULL,
    UNIQUE (kind, held)
);

CREATE TABLE IF NOT EXISTS libsync_devices (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS op_future (
    clock TEXT PRIMARY KEY,
    dev   TEXT NOT NULL,
    op    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audio_changes (
    track_id INTEGER PRIMARY KEY,
    old_fp   TEXT NOT NULL,
    new_fp   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS carry_dismissed (
    old_fp TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS op_journal (
    n      INTEGER PRIMARY KEY,
    batch  INTEGER NOT NULL,
    clock  TEXT NOT NULL,
    dev    TEXT NOT NULL,
    e      TEXT NOT NULL,
    id     TEXT NOT NULL,
    f      TEXT NOT NULL,
    val    TEXT NOT NULL,
    prev   TEXT,
    undone INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS op_journal_batch ON op_journal(batch);

CREATE TABLE IF NOT EXISTS file_local (
    audio_fp TEXT PRIMARY KEY,
    path     TEXT NOT NULL,
    present  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tags_read (
    track_id INTEGER PRIMARY KEY,
    mtime_ms INTEGER,
    size     INTEGER NOT NULL,
    fields   TEXT
);

CREATE TABLE IF NOT EXISTS song_tags_local (
    audio_fp TEXT PRIMARY KEY,
    fields   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS covers_pushed (
    name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS covers_unused (
    name     TEXT PRIMARY KEY,
    since_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS synced_files_track ON synced_files(track_id);

CREATE INDEX IF NOT EXISTS tracks_fingerprint ON tracks(fingerprint);

CREATE INDEX IF NOT EXISTS tracks_audio_fp ON tracks(audio_fp);

CREATE TABLE IF NOT EXISTS import_cache (
    folder TEXT PRIMARY KEY,
    data   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lookup_cache (
    source     TEXT NOT NULL,
    key        TEXT NOT NULL,
    data       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (source, key)
);

CREATE TABLE IF NOT EXISTS import_folders (
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,
    enabled     INTEGER NOT NULL DEFAULT 1,
    convert_aac INTEGER NOT NULL DEFAULT 0,
    auto_import INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS itunes_imported (
    source      TEXT NOT NULL,
    size        INTEGER NOT NULL,
    dest        TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    source_audio_fp TEXT,
    PRIMARY KEY (source, size)
);

CREATE TABLE IF NOT EXISTS activity (
    id          INTEGER PRIMARY KEY,
    source      TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    ok          INTEGER NOT NULL,
    skipped     INTEGER NOT NULL,
    failed      INTEGER NOT NULL,
    items       TEXT NOT NULL DEFAULT '[]',
    errors      TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS remote_prints (
    target_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    PRIMARY KEY (target_id, path)
);

CREATE TABLE IF NOT EXISTS analysis (
    audio_fp    TEXT PRIMARY KEY,
    bpm         REAL,
    musical_key TEXT,
    error       TEXT,
    version     INTEGER NOT NULL,
    analyzed_at INTEGER NOT NULL,
    bpm_edited INTEGER NOT NULL DEFAULT 0,
    key_edited INTEGER NOT NULL DEFAULT 0,
    grid_edited INTEGER NOT NULL DEFAULT 0,
    grid_bpm REAL,
    first_beat REAL,
    bar_offset INTEGER,
    duration REAL,
    waveform BLOB,
    cues_edited INTEGER NOT NULL DEFAULT 0,
    wf_pushed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cues (
    id          INTEGER PRIMARY KEY,
    audio_fp    TEXT NOT NULL,
    -- 0-7 for hot cues A-H, NULL for a memory cue.
    slot        INTEGER,
    start       REAL NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    -- #rrggbb, or '' for the player's default.
    color       TEXT NOT NULL DEFAULT '',
    -- The memory cue the song starts from (rekordbox's main cue on load).
    main        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS cues_audio_fp ON cues(audio_fp);

CREATE TABLE IF NOT EXISTS remote_signatures (
    target_id INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
    path      TEXT NOT NULL,
    size      INTEGER NOT NULL,
    version   TEXT NOT NULL,
    signature TEXT NOT NULL,
    PRIMARY KEY (target_id, path)
);

CREATE TABLE IF NOT EXISTS stale_remote (
    target_id INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
    track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    rel       TEXT NOT NULL,
    PRIMARY KEY (target_id, track_id, rel)
);

CREATE TABLE IF NOT EXISTS tag_values (
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (field, value)
);

CREATE TABLE IF NOT EXISTS tag_custom (
    field TEXT NOT NULL,
    value TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (field, value)
);

CREATE TABLE IF NOT EXISTS export_selections (
    destination TEXT PRIMARY KEY,
    playlists   TEXT NOT NULL DEFAULT '[]',
    tags        TEXT NOT NULL DEFAULT '[]',
    smart TEXT NOT NULL DEFAULT '[]',
    usb_mode TEXT NOT NULL DEFAULT 'add',
    usb_rekordbox INTEGER NOT NULL DEFAULT 1,
    usb_serato INTEGER NOT NULL DEFAULT 0,
    usb_gemini INTEGER NOT NULL DEFAULT 0,
    usb_virtualdj INTEGER NOT NULL DEFAULT 0,
    usb_playlist_folders INTEGER NOT NULL DEFAULT 0,
    usb_rekordbox_device_library INTEGER NOT NULL DEFAULT 1,
    usb_rekordbox_one_library INTEGER NOT NULL DEFAULT 1,
    usb_folder_file_names TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS smart_playlists (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL,
    rules TEXT NOT NULL DEFAULT '{}',
    uid TEXT,
    scope TEXT NOT NULL DEFAULT 'shared',
    hidden INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS smart_playlists_uid ON smart_playlists(uid);

CREATE TABLE IF NOT EXISTS jellyfin_servers (
    target_id    INTEGER PRIMARY KEY REFERENCES sync_targets(id) ON DELETE CASCADE,
    url          TEXT NOT NULL,
    server_name  TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    user_name    TEXT NOT NULL,
    library_id   TEXT NOT NULL,
    library_name TEXT NOT NULL,
    last_push_at INTEGER,
    last_push TEXT,
    visibility TEXT NOT NULL DEFAULT '{"kind":"onlyMe"}'
);

CREATE TABLE IF NOT EXISTS jellyfin_playlists (
    target_id   INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    playlist_id TEXT NOT NULL,
    visibility TEXT,
    PRIMARY KEY (target_id, key)
);

CREATE TABLE IF NOT EXISTS sync_ignored (
    target_id INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
    rel       TEXT NOT NULL,
    scope     TEXT NOT NULL CHECK (scope IN ('file', 'folder')),
    added_at  INTEGER NOT NULL,
    PRIMARY KEY (target_id, rel, scope)
);

CREATE TABLE IF NOT EXISTS keep_rules (
    kind TEXT NOT NULL CHECK (kind IN ('song', 'playlist')),
    id   TEXT NOT NULL,
    PRIMARY KEY (kind, id)
);

