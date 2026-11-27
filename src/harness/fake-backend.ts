import type {
	DeleteHold,
	ExportSelection,
	FileRemoval,
	FsEntry,
	IgnoreRule,
	LibraryChangeBatch,
	Scope,
	SmartPlaylist,
	SmartRules,
	Tag,
	Track,
	TrackAnalysis,
} from "#/lib/api.ts";
import {
	buildAnalysis,
	buildPlaylists,
	buildSmartPlaylists,
	buildTags,
	buildTracks,
	DAY,
	type FakePlaylist,
	LIBRARY_ROOT,
	NOW,
} from "./fake-library.ts";
import {
	buildActivity,
	buildAuditIssues,
	buildDuplicates,
	buildImportScan,
	buildMissing,
	buildNasActions,
	buildSyncHistory,
	buildTargets,
	buildUsbLibrary,
	CLASHES,
	DEFAULT_SELECTION,
	DELETE_HOLD,
	DOWNLOADS_FOLDER,
	FILE_REMOVALS,
	IMPORT_FOLDERS,
	LIBRARY_CHANGES,
	NAS_TARGET_ID,
	PICKER_FOLDERS,
	PICKER_PLACES,
	R2_TARGET_ID,
	RECENTLY_DELETED,
	REKORDBOX_STATUS,
	relOf,
	USB_DRIVES,
	USB_FORMATS,
} from "./fake-places.ts";

/**
 * The backend the harness runs the app against: every Tauri command answered from memory.
 * Reads return the made-up library; the common edits (playlists, tags, settings) change it so a
 * click shows its result, and the rest succeed without doing anything.
 */

/**
 * `full`: a library with every source and destination set up. `empty`: a first launch.
 * `large`: `full` with about 1,400 songs, for how the app holds up at a real library's size.
 */
export type Scenario = "full" | "empty" | "large" | "newer-library";

export const SCENARIOS: readonly Scenario[] = ["full", "empty", "large", "newer-library"];

/** How many times `large` repeats the library. */
const LARGE_COPIES = 12;

/** A command's arguments, by name. */
type Args = ReadonlyMap<string, unknown>;
type Command = (args: Args) => unknown;

/** The layout of the library database the real backend reads (`db::SCHEMA_VERSION`). */
const SCHEMA_VERSION = 1;

interface State {
	/** A newer manplay set up the library, so the backend left it closed. */
	newerLibrary: boolean;
	streamCacheUsed: number;
	streamCacheLimit: number;
	newSharedSongs: "stream" | "download";
	root: string | null;
	tracks: Track[];
	tags: Tag[];
	playlists: FakePlaylist[];
	smart: SmartPlaylist[];
	settings: Map<string, string | null>;
	services: Map<string, string>;
	/** A Discogs token is saved, so lookups ask Discogs too. */
	discogsToken: boolean;
	selections: Map<string, ExportSelection>;
	deviceName: string;
	/** Whether the shared library syncs on its own. */
	libraryAuto: boolean;
	/** Deletions from another device waiting for a choice, until one is made. */
	deleteHold: DeleteHold | null;
	libraryChanges: LibraryChangeBatch[];
	fileRemovals: FileRemoval[];
	defaultScope: Scope;
	/** Destination-only files ignored, by destination. */
	ignored: Map<number, IgnoreRule[]>;
	analysis: { keyFormat: "musical" | "camelot"; replaceEdits: boolean };
}

function createState(scenario: Scenario): State {
	const newerLibrary = scenario === "newer-library";
	const setUp = scenario !== "empty" && !newerLibrary;
	const tracks = setUp ? buildTracks(scenario === "large" ? LARGE_COPIES : 1) : [];
	return {
		newerLibrary,
		streamCacheUsed: setUp ? 1_830_000_000 : 0,
		streamCacheLimit: 5_000_000_000,
		newSharedSongs: "stream",
		root: setUp ? LIBRARY_ROOT : null,
		tracks,
		tags: setUp ? buildTags(tracks) : [],
		playlists: setUp ? buildPlaylists(tracks) : [],
		smart: setUp ? buildSmartPlaylists() : [],
		settings: new Map(),
		services: new Map(),
		discogsToken: false,
		selections: new Map(),
		deviceName: "booth-macbook",
		libraryAuto: true,
		deleteHold: DELETE_HOLD,
		libraryChanges: LIBRARY_CHANGES,
		fileRemovals: FILE_REMOVALS,
		defaultScope: "shared",
		ignored: new Map(),
		analysis: { keyFormat: "camelot", replaceEdits: false },
	};
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number => (typeof value === "number" ? value : 0);
const numbers = (value: unknown): number[] =>
	Array.isArray(value) ? value.filter((item) => typeof item === "number") : [];
const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];

const FIX_NOTHING = { fixed: 0, failed: [] };
const COVER_NOTHING = { ...FIX_NOTHING, previous: [] };
const PULLED_NOTHING = { pulled: 0, skipped: 0, failed: [], failedTotal: 0 };

/** The folders and files directly inside `folder`, from the paths of the library's songs. */
function listFolder(tracks: readonly Track[], folder: readonly string[]): FsEntry[] {
	const entries = new Map<string, FsEntry>();
	for (const track of tracks) {
		const rel = relOf(track);
		const inside = folder.every((part, index) => rel[index] === part);
		const name = rel[folder.length];
		if (!inside || name === undefined) {
			continue;
		}
		const isDir = rel.length > folder.length + 1;
		const known = entries.get(name);
		entries.set(name, {
			name,
			isDir,
			size: (known?.size ?? 0) + track.size,
			modified: track.addedAt ?? NOW - 400 * DAY,
		});
	}
	return [...entries.values()].sort(
		(a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name),
	);
}

function folderSizes(tracks: readonly Track[], folder: readonly string[]): Record<string, number> {
	return Object.fromEntries(
		listFolder(tracks, folder)
			.filter((entry) => entry.isDir)
			.map((entry) => [entry.name, entry.size]),
	);
}

function libraryFolder(path: unknown): string[] {
	return text(path)
		.slice(LIBRARY_ROOT.length + 1)
		.split("/")
		.filter((part) => part !== "");
}

function tagMatches(track: Track, name: string): boolean {
	const wanted = name.toLowerCase();
	return track.tags.some((tag) => {
		const have = tag.toLowerCase();
		return have === wanted || have.startsWith(`${wanted}/`);
	});
}

function addedMatches(track: Track, rules: SmartRules): boolean {
	const added = rules.added;
	if (added === null || track.addedAt === null || track.addedAt === undefined) {
		return added === null;
	}
	if (added.kind === "after") {
		return track.addedAt >= added.date;
	}
	if (added.kind === "before") {
		return track.addedAt < added.date;
	}
	const days = { days: 1, weeks: 7, months: 30 }[added.unit];
	return track.addedAt >= NOW - added.amount * days * DAY;
}

function bpmMatches(track: Track, rules: SmartRules): boolean {
	if (rules.bpmMin === null && rules.bpmMax === null) {
		return true;
	}
	return (
		track.bpm !== null &&
		track.bpm >= (rules.bpmMin ?? 0) &&
		track.bpm <= (rules.bpmMax ?? Number.POSITIVE_INFINITY)
	);
}

function smartMatches(track: Track, rules: SmartRules): boolean {
	return (
		rules.allTags.every((tag) => tagMatches(track, tag)) &&
		(rules.anyTags.length === 0 || rules.anyTags.some((tag) => tagMatches(track, tag))) &&
		!rules.noneTags.some((tag) => tagMatches(track, tag)) &&
		addedMatches(track, rules) &&
		bpmMatches(track, rules)
	);
}

function smartPreview(state: State, rules: SmartRules) {
	const matches = state.tracks.filter((track) => smartMatches(track, rules));
	return {
		trackIds: matches.map((track) => track.id),
		durationMs: matches.reduce((sum, track) => sum + (track.durationMs ?? 0), 0),
		bytes: matches.reduce((sum, track) => sum + track.size, 0),
		undated: rules.added === null ? 0 : state.tracks.filter((t) => t.addedAt === null).length,
	};
}

function tagView(state: State, paths: readonly string[]) {
	const songs = state.tracks.filter((track) =>
		paths.some((path) => track.path === path || track.path.startsWith(`${path}/`)),
	);
	const fields = [
		"title",
		"artist",
		"album",
		"albumArtist",
		"genre",
		"year",
		"label",
		"bpm",
		"key",
	];
	const tagValueOf = (track: Track, field: string): string | null => {
		const direct: Record<string, string | null> = {
			title: track.title,
			artist: track.artist,
			album: track.album,
			bpm: track.bpm === null ? null : String(track.bpm),
			key: track.key,
		};
		return direct[field] ?? track.fields[field] ?? null;
	};
	return {
		count: songs.length,
		fields: Object.fromEntries(
			fields.map((field) => {
				const values = new Set(songs.map((track) => tagValueOf(track, field)));
				const mixed = values.size > 1;
				return [field, { value: mixed ? null : ([...values][0] ?? null), mixed }];
			}),
		),
	};
}

function tagValues(state: State, field: string) {
	const counts = new Map<string, number>();
	for (const track of state.tracks) {
		const value = track.fields[field];
		if (value !== undefined) {
			counts.set(value, (counts.get(value) ?? 0) + 1);
		}
	}
	return [...counts]
		.map(([value, uses]) => ({ value, count: uses }))
		.sort((a, b) => b.count - a.count);
}

function recountTags(state: State): void {
	for (const tag of state.tags) {
		tag.trackCount = state.tracks.filter((track) => track.tags.includes(tag.name)).length;
	}
}

function tagTracks(state: State, name: string, trackIds: readonly number[]): void {
	if (!state.tags.some((tag) => tag.name === name)) {
		state.tags.push({ id: state.tags.length + 1, name, trackCount: 0, scope: state.defaultScope });
	}
	for (const track of state.tracks) {
		if (trackIds.includes(track.id) && !track.tags.includes(name)) {
			track.tags.push(name);
		}
	}
	recountTags(state);
}

function untagTrack(state: State, name: string, trackId: number): void {
	const track = state.tracks.find((candidate) => candidate.id === trackId);
	if (track) {
		track.tags = track.tags.filter((tag) => tag !== name);
	}
	recountTags(state);
}

/** Takes the named songs off the list of removed songs; returns how many it took. */
function settleRemovals(state: State, audioFps: unknown): number {
	const asked = Array.isArray(audioFps) ? audioFps : [];
	const before = state.fileRemovals.length;
	state.fileRemovals = state.fileRemovals.filter((removal) => !asked.includes(removal.audioFp));
	return before - state.fileRemovals.length;
}

function libraryCommands(state: State): Record<string, Command> {
	return {
		list_tracks: () => state.tracks,
		get_library_root: () => state.root,
		newer_library: () =>
			state.newerLibrary ? { found: SCHEMA_VERSION + 1, supported: SCHEMA_VERSION } : null,
		library_status: () => ({ missing: state.tracks.length > 0 ? 2 : 0, graceDays: 30 }),
		list_missing: () => buildMissing(state.tracks).filter(() => state.tracks.length > 0),
		list_duplicates: () => (state.tracks.length > 0 ? buildDuplicates(state.tracks) : []),
		trash_duplicates: (args) => {
			const groups = (args.get("groups") ?? []) as { keep: string; trash: string[] }[];
			const paths = groups.flatMap((g) => g.trash);
			// A second numbered copy stands in for a false match, so the report's skipped list shows.
			const differs = (p: string) => p.includes(" (2)");
			return {
				trashed: paths.filter((p) => !differs(p)),
				skipped: paths
					.filter(differs)
					.map((path) => ({ path, reason: "its audio differs from the copy being kept" })),
			};
		},
		list_carry_candidates: () => [],
		carry_over: () => ({ tags: 0, playlists: 0, edits: 0 }),
		scan_library: () => state.tracks.length,
		rescan_library: () => (state.root === null ? null : state.tracks.length),
		reset_library: () => (state.root === null ? null : state.tracks.length),
		audit_library: () => (state.tracks.length > 0 ? buildAuditIssues(state.tracks) : []),
		audit_fix: () => FIX_NOTHING,
		playback_needs_decoding: () => false,
		stream_prefetch: () => null,
		stream_cache_usage: () => ({ used: state.streamCacheUsed, limit: state.streamCacheLimit }),
		set_stream_cache_limit: (args) => {
			state.streamCacheLimit = count(args.get("bytes"));
			state.streamCacheUsed = Math.min(state.streamCacheUsed, state.streamCacheLimit);
			return { used: state.streamCacheUsed, limit: state.streamCacheLimit };
		},
		empty_stream_cache: () => {
			state.streamCacheUsed = 0;
			return { used: 0, limit: state.streamCacheLimit };
		},
		new_shared_songs: () => state.newSharedSongs,
		set_new_shared_songs: (args) => {
			state.newSharedSongs = args.get("choice") === "download" ? "download" : "stream";
			return null;
		},
		stream_source: (args) => state.tracks.find((t) => t.id === args.get("trackId"))?.path ?? "",
		get_library_view: () => state.settings.get("library_view") ?? null,
		set_library_view: (args) => state.settings.set("library_view", text(args.get("view"))),
		get_panel_tabs: () => state.settings.get("panel_tabs") ?? null,
		set_panel_tabs: (args) => state.settings.set("panel_tabs", text(args.get("tabs"))),
		get_ui_setting: (args) => state.settings.get(`ui.${text(args.get("name"))}`) ?? null,
		set_ui_setting: (args) =>
			state.settings.set(`ui.${text(args.get("name"))}`, text(args.get("value"))),
		get_tag_clipboard: () => state.settings.get("tag_clipboard") ?? null,
		set_tag_clipboard: (args) =>
			state.settings.set(
				"tag_clipboard",
				args.get("json") === null ? null : text(args.get("json")),
			),
	};
}

function analysisCommands(state: State): Record<string, Command> {
	const trackOf = (args: Args) => state.tracks.find((track) => track.id === args.get("trackId"));
	// Grids saved in the grid editor, by track id, so an edit stays edited.
	const grids = new Map<number, Pick<TrackAnalysis, "gridBpm" | "firstBeat" | "barOffset">>();
	const analysisOf = (args: Args) => {
		const track = trackOf(args);
		const analysis = track ? buildAnalysis(track) : null;
		const grid = track ? grids.get(track.id) : undefined;
		return analysis && grid ? { ...analysis, ...grid } : analysis;
	};
	const setBeatGrid = (args: Args) => {
		const track = trackOf(args);
		if (track) {
			const bpm = args.get("gridBpm");
			grids.set(track.id, {
				gridBpm: typeof bpm === "number" ? bpm : null,
				firstBeat: count(args.get("firstBeat")),
				barOffset: count(args.get("barOffset")),
			});
		}
		return analysisOf(args);
	};
	return {
		analysis_settings: () => state.analysis,
		is_analyzing: () => false,
		set_analysis_settings: (args) => {
			state.analysis = args.get("settings") as State["analysis"];
		},
		analysis_failures: () =>
			state.tracks
				.filter((track) => !track.analyzed)
				.slice(0, 1)
				.map((track) => ({ path: track.path, error: "could not decode the audio" })),
		save_analysis_to_files: () => ({ written: 0, unchanged: state.tracks.length, failed: [] }),
		analyze_tracks: () => ({ analyzed: 0, failed: 0, cancelled: 0, tags: null }),
		set_tempo_key: () => FIX_NOTHING,
		track_analysis: analysisOf,
		set_beat_grid: setBeatGrid,
		track_cues: (args) =>
			count(args.get("trackId")) % 2 === 0
				? []
				: [
						{ slot: null, start: 0.3, name: "", color: "", main: true },
						{ slot: 0, start: 32.4, name: "Intro", color: "#2bd4a0", main: false },
						{ slot: 1, start: 96.1, name: "Drop", color: "#f2545b", main: false },
						{ slot: 2, start: 160.6, name: "Break", color: "#4d9df7", main: false },
					],
	};
}

function playlistCommands(state: State): Record<string, Command> {
	const find = (id: unknown) => state.playlists.find((entry) => entry.playlist.id === id);
	return {
		list_playlists: () => state.playlists.map((entry) => entry.playlist),
		playlist_tracks: (args) =>
			(find(args.get("playlistId"))?.trackIds ?? []).flatMap((id) =>
				state.tracks.filter((track) => track.id === id),
			),
		create_playlist: (args) => {
			const id = Math.max(0, ...state.playlists.map((entry) => entry.playlist.id)) + 1;
			const scope = args.get("scope") === "local" ? "local" : state.defaultScope;
			state.playlists.push({
				playlist: { id, name: text(args.get("name")), trackCount: 0, scope },
				trackIds: [],
			});
			return id;
		},
		rename_playlist: (args) => {
			const entry = find(args.get("id"));
			if (entry) {
				entry.playlist.name = text(args.get("name"));
			}
		},
		delete_playlist: (args) => {
			state.playlists = state.playlists.filter((entry) => entry.playlist.id !== args.get("id"));
		},
		add_to_playlist: (args) => {
			const entry = find(args.get("playlistId"));
			if (entry) {
				entry.trackIds.push(...numbers(args.get("trackIds")));
				entry.playlist.trackCount = entry.trackIds.length;
			}
		},
		remove_from_playlist: (args) => {
			const entry = find(args.get("playlistId"));
			if (entry) {
				entry.trackIds = entry.trackIds.filter((id) => id !== args.get("trackId"));
				entry.playlist.trackCount = entry.trackIds.length;
			}
		},
		smart_playlists: () => state.smart,
		smart_playlist_save: (args) => {
			const saved = args.get("playlist") as SmartPlaylist;
			const id = saved.id === 0 ? Math.max(0, ...state.smart.map((s) => s.id)) + 1 : saved.id;
			const next = { ...saved, id };
			state.smart = [...state.smart.filter((smart) => smart.id !== id), next];
			return next;
		},
		smart_playlist_delete: (args) => {
			state.smart = state.smart.filter((smart) => smart.id !== args.get("id"));
		},
		smart_playlist_preview: (args) => smartPreview(state, args.get("rules") as SmartRules),
		smart_local_tags: () => [],
	};
}

const LOOKUP_OFF = "Tag lookup is off. Turn it on in Settings to search MusicBrainz.";

/** Made-up pressings of the album at `paths`, to choose a cover from. */
function coverSearch(state: State, paths: string[]) {
	if (state.services.get("lookup") !== "on") {
		throw new Error(LOOKUP_OFF);
	}
	const track = state.tracks.find((t) =>
		paths.some((p) => t.path === p || t.path.startsWith(`${p}/`)),
	);
	const pressings = [
		[2017, "GB", "Vinyl"],
		[2017, "DE", "CD"],
		[2018, "US", "Digital Media"],
		[2021, "JP", "CD"],
		[2023, null, "Vinyl"],
		[null, "FR", null],
	] as const;
	return {
		album: track?.album ?? "",
		artist: track?.artist ?? "",
		options: pressings.map(([year, country, format], index) => ({
			// Every other pressing is one Discogs knows, when a token is saved.
			release:
				state.discogsToken && index % 2 === 1
					? `discogs-${27651 + index}`
					: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
			title: track?.album ?? "",
			artist: track?.artist ?? "",
			year,
			country,
			format,
		})),
	};
}

/**
 * A made-up lookup: every song gets an outcome, cycling through a sure match, an unsure one with
 * a second candidate, and no match, so the review shows each kind.
 */
function lookupSongs(state: State, paths: string[]) {
	if (state.services.get("lookup") !== "on") {
		throw new Error(LOOKUP_OFF);
	}
	const songs = state.tracks.filter((t) =>
		paths.some((p) => t.path === p || t.path.startsWith(`${p}/`)),
	);
	return songs.map((track, index) => {
		const release = (confidence: number) =>
			`11111111-1111-4111-8111-${String(confidence).padStart(12, "0")}`;
		const candidate = (confidence: number, likely: boolean, album: string) => ({
			recording: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			release: release(confidence),
			cover: likely ? release(confidence) : null,
			confidence,
			likely,
			fields: { title: track.title, artist: track.artist, album, label: "Night Shift Records" },
			changes: [
				...(album === track.album ? [] : [{ field: "album", from: track.album, to: album }]),
				{ field: "label", from: null, to: "Night Shift Records" },
				{ field: "track", from: null, to: String(index + 1) },
				{ field: "isrc", from: null, to: `GBXYZ26${String(index).padStart(5, "0")}` },
			],
		});
		const outcomes = [
			{ kind: "matched", candidates: [candidate(100, true, track.album)] },
			{
				kind: "matched",
				candidates: [
					candidate(78, false, `${track.album} (Deluxe)`),
					candidate(71, false, "Late Night Selections"),
				],
			},
			{ kind: "noMatch" },
		];
		// Every other song has a cover already, so the review shows both kinds of cover offer.
		return {
			path: track.path,
			hasCover: index % 2 === 1,
			outcome: outcomes[index % outcomes.length],
		};
	});
}

function tagCommands(state: State): Record<string, Command> {
	return {
		list_tags: () => state.tags,
		create_tag: (args) => tagTracks(state, text(args.get("name")), []),
		tag_tracks: (args) => tagTracks(state, text(args.get("name")), numbers(args.get("trackIds"))),
		untag_track: (args) => untagTrack(state, text(args.get("name")), count(args.get("trackId"))),
		delete_tag: (args) => {
			state.tags = state.tags.filter((tag) => tag.id !== args.get("id"));
		},
		default_scope: () => state.defaultScope,
		set_default_scope: (args) => {
			state.defaultScope = args.get("scope") === "local" ? "local" : "shared";
		},
		tags_read: (args) => tagView(state, strings(args.get("paths"))),
		tags_write: () => FIX_NOTHING,
		tags_write_many: () => FIX_NOTHING,
		tags_set_cover: () => COVER_NOTHING,
		tags_restore_covers: () => FIX_NOTHING,
		tags_preview: () => ({ total: 0, files: [] }),
		tags_lookup: (args) => lookupSongs(state, strings(args.get("paths"))),
		cancel_tag_lookup: () => undefined,
		discogs_token_saved: () => state.discogsToken,
		discogs_token_save: (args) => {
			if (!/^[A-Za-z0-9]+$/.test(String(args.get("token")).trim())) {
				throw new Error("a Discogs token is letters and numbers only");
			}
			state.discogsToken = true;
		},
		discogs_token_forget: () => {
			state.discogsToken = false;
		},
		tags_lookup_cover: () => COVER_NOTHING,
		cover_search: (args) => coverSearch(state, strings(args.get("paths"))),
		tag_values: (args) => tagValues(state, text(args.get("field"))),
		tag_values_migrate: () => FIX_NOTHING,
		share_preview: () => ({ name: "Closing Tracks", songs: 9, localTags: [] }),
		private_preview: () => ({ name: "Peak Time", usedBy: ["Peak, no vocals"] }),
		list_clashes: () => (state.tracks.length > 0 ? CLASHES : []),
		clash_combine_preview: () => ({ sharesLocal: false, songs: 31, name: "Peak Time" }),
		list_recently_deleted: () => (state.tracks.length > 0 ? RECENTLY_DELETED : []),
	};
}

const JELLYFIN_USER = { id: "user-1", name: "booth" };
const JELLYFIN_LIBRARY = { id: "library-1", name: "Music" };
const JELLYFIN_SUMMARY = {
	created: 1,
	updated: 2,
	renamed: 0,
	reshared: 0,
	removed: 0,
	waiting: 0,
	failed: [],
};

function jellyfinCommands(state: State): Record<string, Command> {
	const settings = {
		url: "http://studio-nas:8096",
		serverName: "Studio Jellyfin",
		user: JELLYFIN_USER,
		library: JELLYFIN_LIBRARY,
		visibility: { kind: "onlyMe" },
	};
	const selectionOf = (args: Args) =>
		state.selections.get(`jellyfin:${count(args.get("targetId"))}`) ?? DEFAULT_SELECTION;
	return {
		jellyfin_settings: (args) => (args.get("targetId") === NAS_TARGET_ID ? settings : null),
		jellyfin_probe: () => ({
			name: "Studio Jellyfin",
			version: "10.10.3",
			users: [JELLYFIN_USER, { id: "user-2", name: "guest" }],
			libraries: [{ ...JELLYFIN_LIBRARY, locations: ["/media/Music/DJ Library"] }],
		}),
		jellyfin_save: () => settings,
		jellyfin_check_songs: () => ({
			synced: 108,
			found: 104,
			missing: 4,
			ambiguous: 0,
			examples: ["Sable Ferro/Iron Garden/03 Low Static.mp3"],
		}),
		jellyfin_destinations: () =>
			state.tracks.length === 0
				? []
				: [
						{
							targetId: NAS_TARGET_ID,
							serverName: "Studio Jellyfin",
							selection: selectionOf(new Map([["targetId", NAS_TARGET_ID]])),
							lastPush: { at: NOW - DAY, summary: JELLYFIN_SUMMARY },
						},
					],
		jellyfin_set_selection: (args) => {
			const selection = args.get("selection") as ExportSelection;
			state.selections.set(`jellyfin:${count(args.get("targetId"))}`, selection);
			return selection;
		},
		jellyfin_plan: () => [
			{
				key: "playlist:1",
				name: "Friday Warm-up",
				action: "update",
				oldName: null,
				adopted: false,
				songs: 18,
				added: 2,
				removed: 1,
				leftOut: 0,
			},
			{
				key: "playlist:2",
				name: "Peak Time",
				action: "unchanged",
				oldName: null,
				adopted: false,
				songs: 24,
				added: 0,
				removed: 0,
				leftOut: 1,
			},
			{
				key: "smart:1",
				name: "New This Month",
				action: "create",
				oldName: null,
				adopted: false,
				songs: 11,
				added: 11,
				removed: 0,
				leftOut: 0,
			},
		],
		jellyfin_push: () => JELLYFIN_SUMMARY,
		jellyfin_server_playlists: () => [
			{ id: "jf-1", name: "Friday Warm-up", songs: 17 },
			{ id: "jf-2", name: "Peak Time", songs: 24 },
		],
	};
}

function syncCommands(state: State): Record<string, Command> {
	const targets = () => (state.tracks.length > 0 ? buildTargets(state.tracks) : []);
	const scanOf = (targetId: unknown) => {
		const target = targets().find((candidate) => candidate.id === targetId);
		if (!target) {
			return null;
		}
		const busy = targetId === NAS_TARGET_ID;
		const rules = state.ignored.get(target.id) ?? [];
		const covers = (rule: IgnoreRule, rel: readonly string[]) => {
			const own = rule.rel.join("/").toLowerCase();
			const path = rel.join("/").toLowerCase();
			return rule.scope === "file" ? path === own : path.startsWith(`${own}/`);
		};
		const hidden = (rel: readonly string[]) => rules.some((rule) => covers(rule, rel));
		const allActions = busy ? buildNasActions(state.tracks) : [];
		const actions = allActions.filter((a) => !(a.kind === "delete" && hidden(a.rel)));
		const allMissing = busy
			? [
					{
						rel: ["Odessa Vale", "Paper Lanterns", "08 Quiet Harbour (Live).mp3"],
						size: 12_480_112,
						otherFormat: null,
					},
					{
						rel: ["Halden", "Fjordlight", "07 Distant Tide.flac"],
						size: 41_802_556,
						otherFormat: "mp3",
					},
				]
			: [];
		const missing = allMissing.filter((m) => !hidden(m.rel));
		const hiddenPaths = new Set(
			[
				...allMissing.map((m) => m.rel),
				...allActions.filter((a) => a.kind === "delete").map((a) => a.rel),
			]
				.filter(hidden)
				.map((rel) => rel.join("/")),
		);
		const ignored = rules.map((rule) => ({
			...rule,
			files: [...hiddenPaths].filter((path) => covers(rule, path.split("/"))).length,
		}));
		return {
			targetId,
			planId: `plan-${String(targetId)}`,
			scannedAt: NOW - 420,
			plan: {
				targetId,
				name: [target.machine, ...target.path].join(" / "),
				error: null,
				actions,
				held: busy
					? [{ rel: ["Kaito Brandt", "Signal Loss", "notes.txt"], reason: "Not an audio file" }]
					: [],
				inSync: target.syncedTracks,
				remoteTotal: target.syncedTracks + missing.length,
				unchecked: 0,
				folders: listFolder(state.tracks, []).map((entry) => ({ rel: [entry.name], files: 0 })),
			},
			pull: { total: target.syncedTracks + missing.length, missing, error: null },
			ignored,
		};
	};
	const ruleKey = (rule: IgnoreRule) => `${rule.scope}:${rule.rel.join("/")}`;
	const rulesOf = (value: unknown): IgnoreRule[] =>
		Array.isArray(value)
			? value.flatMap((item) =>
					item && typeof item === "object" && "rel" in item && "scope" in item
						? [
								{
									rel: strings(item.rel),
									scope: item.scope === "folder" ? "folder" : "file",
								} as const,
							]
						: [],
				)
			: [];
	return {
		list_sync_targets: targets,
		add_sync_target: () => NAS_TARGET_ID,
		add_r2_target: () => R2_TARGET_ID,
		sync_history: () => (state.tracks.length > 0 ? buildSyncHistory() : []),
		activity_history: (args) =>
			state.tracks.length > 0 ? buildActivity(text(args.get("source"))) : [],
		sync_scans: () => ({
			scans: targets().map((target) => {
				const scan = scanOf(target.id);
				return {
					targetId: target.id,
					planId: `plan-${target.id}`,
					scannedAt: NOW - 420,
					error: null,
					toPull: scan?.pull.missing.length ?? 0,
					toPush: scan?.plan.actions.length ?? 0,
				};
			}),
			queued: [],
			scanning: null,
		}),
		sync_scan: (args) => scanOf(args.get("targetId")),
		sync_ignore: (args) => {
			const id = count(args.get("targetId"));
			const now = state.ignored.get(id) ?? [];
			const known = new Set(now.map(ruleKey));
			state.ignored.set(id, [
				...now,
				...rulesOf(args.get("rules")).filter((r) => !known.has(ruleKey(r))),
			]);
			return null;
		},
		sync_unignore: (args) => {
			const id = count(args.get("targetId"));
			const gone = new Set(rulesOf(args.get("rules")).map(ruleKey));
			state.ignored.set(
				id,
				(state.ignored.get(id) ?? []).filter((r) => !gone.has(ruleKey(r))),
			);
			return null;
		},
		sync_apply: () => [],
		remote_verify: () => [],
		remote_pull: () => PULLED_NOTHING,
		remote_download: () => PULLED_NOTHING,
		remote_upload: () => PULLED_NOTHING,
		remote_move: () => 0,
		remote_list: (args) =>
			listFolder(
				state.tracks.filter((track) => track.syncedCount > 0),
				strings(args.get("rel")),
			),
		remote_dir_sizes: (args) =>
			folderSizes(
				state.tracks.filter((track) => track.syncedCount > 0),
				strings(args.get("rel")),
			),
		libsync_run: () => [],
		libsync_inspect: () => ({
			libraryId: "library-booth",
			name: "Booth Library",
			createdAt: NOW - 200 * DAY,
			members: [
				{ name: state.deviceName, lastSeen: NOW - 420, mine: true },
				{ name: "studio-mac", lastSeen: NOW - 2 * DAY, mine: false },
			],
			lastChange: NOW - 2 * DAY,
		}),
		libsync_join: () => ({
			targetId: NAS_TARGET_ID,
			name: "Booth Library",
			sent: 0,
			received: 0,
			unreadable: 0,
			held: 0,
			clockWrong: false,
			newDeviceId: false,
			error: null,
		}),
		libsync_home: () => ({ kind: "target", targetId: NAS_TARGET_ID, name: "Booth Library" }),
		libsync_inspect_folder: () => null,
		libsync_join_folder: () => ({
			sent: 0,
			received: 0,
			unreadable: 0,
			held: 0,
			clockWrong: false,
			newDeviceId: false,
			error: null,
		}),
		libsync_status: () => ({
			auto: state.libraryAuto,
			last: { at: NOW - 140, sent: 2, received: 14, error: null },
			hold: state.deleteHold,
		}),
		libsync_set_auto: (args) => {
			state.libraryAuto = args.get("on") === true;
		},
		libsync_sync_now: () => undefined,
		libsync_decide_deletes: () => {
			state.deleteHold = null;
		},
		list_file_removals: () => (state.tracks.length > 0 ? state.fileRemovals : []),
		keep_file_removals: (args) => settleRemovals(state, args.get("audioFps")),
		apply_file_removals: (args) => settleRemovals(state, args.get("audioFps")),
		list_library_changes: () => (state.tracks.length > 0 ? state.libraryChanges : []),
		undo_library_changes: (args) => {
			state.libraryChanges = state.libraryChanges.map((batch) =>
				batch.id === args.get("batch") ? { ...batch, undone: true } : batch,
			);
			return { reverted: 3, skipped: 0 };
		},
		get_device_name: () => state.deviceName,
		set_device_name: (args) => {
			state.deviceName = text(args.get("name")) || "booth-macbook";
			return state.deviceName;
		},
		tailscale_status: () => ({
			tailnet: "tail1234.ts.net",
			machines: [
				{
					name: "booth-macbook",
					hostName: "booth-macbook",
					os: "macOS",
					online: true,
					isSelf: true,
				},
				{ name: "studio-nas", hostName: "studio-nas", os: "linux", online: true, isSelf: false },
				{ name: "studio-mac", hostName: "studio-mac", os: "macOS", online: false, isSelf: false },
			],
		}),
		drive_list: () => [
			{ name: "Music", isDir: true },
			{ name: "Backups", isDir: true },
		],
		service_flags: () => [...state.services],
		set_service_enabled: (args) =>
			state.services.set(text(args.get("id")), args.get("enabled") === true ? "on" : "off"),
	};
}

function exportCommands(state: State): Record<string, Command> {
	const configured = () => state.tracks.length > 0;
	const selection = (key: string) => state.selections.get(key) ?? DEFAULT_SELECTION;
	const saveSelection = (key: string, args: Args) => {
		const saved = args.get("selection") as ExportSelection;
		state.selections.set(key, saved);
		return saved;
	};
	const none = { path: null, exportedAt: null, playlists: 0, tracks: 0, error: null };
	return {
		rekordbox_status: () => (configured() ? REKORDBOX_STATUS : none),
		rekordbox_set_path: (args) => (args.get("path") === null ? none : REKORDBOX_STATUS),
		rekordbox_export: () => REKORDBOX_STATUS,
		rekordbox_selection: () => selection("rekordbox"),
		rekordbox_set_selection: (args) => saveSelection("rekordbox", args),
		rekordbox_library: () =>
			configured()
				? {
						tracks: REKORDBOX_STATUS.tracks,
						playlists: state.playlists.slice(0, 3).map((entry) => ({
							folders: [],
							name: entry.playlist.name,
							tracks: entry.trackIds.flatMap((id) =>
								state.tracks
									.filter((track) => track.id === id)
									.map((track) => ({ title: track.title, artist: track.artist })),
							),
						})),
					}
				: null,
		usb_drives: () => (configured() ? USB_DRIVES : []),
		usb_library: () => buildUsbLibrary(state.tracks),
		usb_formats: () => USB_FORMATS,
		usb_backups: () => ({ count: 3, bytes: 18_400_000, latest: "2026-11-15-221530" }),
		usb_delete_backups: () => ({ count: 1, bytes: 6_100_000, latest: "2026-11-15-221530" }),
		usb_export_selection: () => selection("usb"),
		usb_edit_playlists: () => ({ library: buildUsbLibrary(state.tracks), created: null }),
		usb_reset: () => 4,
		usb_export_preview: () => usbDiff(state),
		export_to_usb: () => ({
			copied: 6,
			alreadyThere: 36,
			bytesCopied: 71_200_000,
			analyzed: 6,
			playlists: 4,
			libraryTracks: 48,
			backup: "PIONEER/manplay-backup/2026-11-21-101500",
			deviceLibrary: true,
			oneLibrary: true,
			oneLibraryError: null,
			seratoCrates: 3,
			failed: [],
		}),
	};
}

function usbDiff(state: State) {
	const song = (track: Track) => ({
		title: track.title,
		artist: track.artist,
		album: track.album,
		bpm: track.bpm,
		key: track.key,
		durationSecs: Math.round((track.durationMs ?? 0) / 1000),
		trackId: track.id,
		file: null,
	});
	const incoming = state.tracks.slice(42, 48).map(song);
	const leaving = state.tracks.slice(0, 2).map(song);
	return {
		playlists: [
			{
				name: "Friday Warm-up",
				change: "updated",
				songs: 18,
				added: incoming.slice(0, 2),
				removed: leaving.slice(0, 1),
				tracks: state.tracks.slice(2, 20).map(song),
			},
			{
				name: "Peak Time",
				change: "unchanged",
				songs: 22,
				added: [],
				removed: [],
				tracks: state.tracks.slice(14, 36).map(song),
			},
			{
				name: "New This Month",
				change: "added",
				songs: 4,
				added: incoming.slice(2),
				removed: [],
				tracks: incoming.slice(2),
			},
		],
		copy: incoming,
		copyBytes: 71_200_000,
		delete: leaving,
		deleteBytes: 19_800_000,
	};
}

function importCommands(state: State): Record<string, Command> {
	const configured = () => state.tracks.length > 0;
	return {
		import_folders: () => (configured() ? IMPORT_FOLDERS : []),
		import_add_folder: (args) => ({
			id: 3,
			path: text(args.get("path")),
			enabled: true,
			convertAac: args.get("convertAac") === true,
			autoImport: args.get("autoImport") === true,
		}),
		import_scan: buildImportScan,
		import_cached: () => (configured() ? buildImportScan() : null),
		import_run: () => ({ imported: 0, images: 0, converted: [], covers: 0, failed: [] }),
		import_preview: () => `${DOWNLOADS_FOLDER}/preview.mp3`,
		fs_list: (args) => listFolder(state.tracks, libraryFolder(args.get("path"))),
		fs_dir_sizes: (args) => folderSizes(state.tracks, libraryFolder(args.get("path"))),
		fs_make_dir: (args) => `${text(args.get("parent"))}/${text(args.get("name"))}`,
		fs_rename: (args) => text(args.get("path")),
		fs_copy: () => [],
	};
}

/** The way from the top folder down to `path`, as the file picker's crumbs. */
function pickerCrumbs(path: string): { name: string; path: string }[] {
	const parts = path.split("/").filter((part) => part !== "");
	return [
		{ name: "/", path: "/" },
		...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join("/")}` })),
	];
}

/** The smallest PNG there is: one transparent pixel, for a picture picked as a cover. */
const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** The file picker's view of this made-up computer; the library folder shows the library. */
function pickerCommands(state: State): Record<string, Command> {
	const entries = (path: string): FsEntry[] => {
		const inLibrary = path === LIBRARY_ROOT || path.startsWith(`${LIBRARY_ROOT}/`);
		return inLibrary ? listFolder(state.tracks, libraryFolder(path)) : (PICKER_FOLDERS[path] ?? []);
	};
	return {
		clipboard_read_text: () => "Pasted text",
		picker_places: () => PICKER_PLACES,
		picker_list: (args) => {
			const path = text(args.get("path")).replace(/(?<=.)\/+$/, "");
			return { path, crumbs: pickerCrumbs(path), entries: entries(path) };
		},
		picker_make_dir: (args) => `${text(args.get("parent"))}/${text(args.get("name")).trim()}`,
		picker_read_image: () =>
			Uint8Array.from(atob(ONE_PIXEL_PNG), (character) => character.charCodeAt(0)).buffer,
	};
}

/** What the app's plugins answer. */
function pluginCommands(): Record<string, Command> {
	return {
		"plugin:app|version": () => "0.1.0",
		"plugin:updater|check": () => null,
	};
}

export interface FakeBackend {
	/** Answers one command; `handled` is false when nothing in the harness knows it. */
	run: (command: string, args: Record<string, unknown>) => { handled: boolean; result: unknown };
	/** Whether the harness has an answer for a command, without running it. */
	knows: (command: string) => boolean;
	trackByPath: (path: string) => Track | undefined;
	trackById: (id: number) => Track | undefined;
}

/** Commands that only change something the harness does not model: they succeed and do nothing. */
const ACCEPTED = new Set([
	"cancel_analysis",
	"dismiss_carry",
	"remove_missing_now",
	"migrate_library_tags",
	"update_sync_target",
	"remove_sync_target",
	"libsync_leave",
	"jellyfin_forget",
	"dismiss_sync_runs",
	"dismiss_activity",
	"sync_rescan",
	"share_item",
	"make_private",
	"set_item_hidden",
	"restore_deleted",
	"resolve_clash",
	"fs_reveal",
	"fs_trash",
	"fs_move",
	"open_privacy_settings",
	"audit_place",
	"tag_value_create",
	"import_trash",
	"import_update_folder",
	"import_remove_folder",
	"usb_eject",
	"usb_reveal",
	"set_track_cues",
	"plugin:process|restart",
]);

export function createFakeBackend(scenario: Scenario): FakeBackend {
	const state = createState(scenario);
	const commands: Record<string, Command> = {
		...libraryCommands(state),
		...analysisCommands(state),
		...playlistCommands(state),
		...tagCommands(state),
		...jellyfinCommands(state),
		...syncCommands(state),
		...exportCommands(state),
		...importCommands(state),
		...pickerCommands(state),
		...pluginCommands(),
	};
	return {
		run: (command, args) => {
			const handler = commands[command];
			if (handler) {
				return { handled: true, result: handler(new Map(Object.entries(args))) ?? null };
			}
			return { handled: ACCEPTED.has(command), result: null };
		},
		knows: (command) => command in commands || ACCEPTED.has(command),
		trackByPath: (path) => state.tracks.find((track) => track.path === path),
		trackById: (id) => state.tracks.find((track) => track.id === id),
	};
}
