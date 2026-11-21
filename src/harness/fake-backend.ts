import type {
	ExportSelection,
	FsEntry,
	Scope,
	SmartPlaylist,
	SmartRules,
	Tag,
	Track,
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
	DOWNLOADS_FOLDER,
	ITUNES_PENDING,
	ITUNES_STATUS,
	NAS_TARGET_ID,
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
export type Scenario = "full" | "empty" | "large";

export const SCENARIOS: readonly Scenario[] = ["full", "empty", "large"];

/** How many times `large` repeats the library. */
const LARGE_COPIES = 12;

/** A command's arguments, by name. */
type Args = ReadonlyMap<string, unknown>;
type Command = (args: Args) => unknown;

interface State {
	root: string | null;
	tracks: Track[];
	tags: Tag[];
	playlists: FakePlaylist[];
	smart: SmartPlaylist[];
	settings: Map<string, string | null>;
	services: Map<string, string>;
	selections: Map<string, ExportSelection>;
	deviceName: string;
	defaultScope: Scope;
	analysis: { writeTags: boolean; keyFormat: "musical" | "camelot"; replaceEdits: boolean };
}

function createState(scenario: Scenario): State {
	const setUp = scenario !== "empty";
	const tracks = setUp ? buildTracks(scenario === "large" ? LARGE_COPIES : 1) : [];
	return {
		root: setUp ? LIBRARY_ROOT : null,
		tracks,
		tags: setUp ? buildTags(tracks) : [],
		playlists: setUp ? buildPlaylists(tracks) : [],
		smart: setUp ? buildSmartPlaylists() : [],
		settings: new Map(),
		services: new Map(),
		selections: new Map(),
		deviceName: "booth-macbook",
		defaultScope: "shared",
		analysis: { writeTags: true, keyFormat: "camelot", replaceEdits: false },
	};
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number => (typeof value === "number" ? value : 0);
const numbers = (value: unknown): number[] =>
	Array.isArray(value) ? value.filter((item) => typeof item === "number") : [];
const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];

const FIX_NOTHING = { fixed: 0, failed: [] };
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

function libraryCommands(state: State): Record<string, Command> {
	return {
		list_tracks: () => state.tracks,
		get_library_root: () => state.root,
		library_status: () => ({ missing: state.tracks.length > 0 ? 2 : 0, graceDays: 30 }),
		list_missing: () => buildMissing(state.tracks).filter(() => state.tracks.length > 0),
		list_duplicates: () => (state.tracks.length > 0 ? buildDuplicates(state.tracks) : []),
		list_carry_candidates: () => [],
		carry_over: () => ({ tags: 0, playlists: 0, edits: 0 }),
		scan_library: () => state.tracks.length,
		rescan_library: () => (state.root === null ? null : state.tracks.length),
		reset_library: () => (state.root === null ? null : state.tracks.length),
		audit_library: () => (state.tracks.length > 0 ? buildAuditIssues(state.tracks) : []),
		audit_fix: () => FIX_NOTHING,
		playback_needs_decoding: () => false,
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
	const analysisOf = (args: Args) => {
		const track = trackOf(args);
		return track ? buildAnalysis(track) : null;
	};
	return {
		analysis_settings: () => state.analysis,
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
		set_beat_grid: analysisOf,
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
		tags_set_cover: () => FIX_NOTHING,
		tags_preview: () => ({ total: 0, files: [] }),
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
		const actions = busy ? buildNasActions(state.tracks) : [];
		const missing = busy
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
		};
	};
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
		libsync_replace_count: () => state.tags.length + state.playlists.length + state.smart.length,
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
			state.services.set(text(args.get("id")), args.get("enabled") === true ? "1" : "0"),
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
		import_get_folder: () => (configured() ? DOWNLOADS_FOLDER : null),
		import_scan: buildImportScan,
		import_cached: () => (configured() ? buildImportScan() : null),
		import_run: () => ({ imported: 0, images: 0, failed: [] }),
		import_preview: () => `${DOWNLOADS_FOLDER}/preview.mp3`,
		itunes_status: () => (configured() ? ITUNES_STATUS : { path: null, last: null }),
		itunes_set_path: () => ITUNES_STATUS,
		itunes_pending: () => ITUNES_PENDING,
		itunes_import: () => ITUNES_STATUS,
		fs_list: (args) => listFolder(state.tracks, libraryFolder(args.get("path"))),
		fs_dir_sizes: (args) => folderSizes(state.tracks, libraryFolder(args.get("path"))),
		fs_make_dir: (args) => `${text(args.get("parent"))}/${text(args.get("name"))}`,
		fs_rename: (args) => text(args.get("path")),
		fs_copy: () => [],
	};
}

/** What the app's native dialogs and plugins answer. */
function pluginCommands(): Record<string, Command> {
	return {
		"plugin:app|version": () => "0.1.0",
		"plugin:updater|check": () => null,
		"plugin:dialog|open": () => "/Users/dj/Music/Picked Folder",
		"plugin:dialog|save": () => "/Users/dj/Documents/manplay-rekordbox.xml",
		"plugin:dialog|ask": () => true,
		"plugin:dialog|confirm": () => true,
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
