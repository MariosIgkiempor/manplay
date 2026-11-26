import type {
	Activity,
	AuditIssue,
	Clash,
	DeletedItem,
	DeleteHold,
	DuplicateGroup,
	ExportSelection,
	FileRemoval,
	FsEntry,
	ImportFolder,
	ImportFolderId,
	ImportGroup,
	ImportScan,
	ImportTrack,
	LibraryChangeBatch,
	MissingTrack,
	PickerPlace,
	RekordboxStatus,
	SyncAction,
	SyncRun,
	SyncTarget,
	Track,
	UsbDrive,
	UsbFormats,
	UsbLibrary,
} from "#/lib/api.ts";
import { fieldOf } from "#/lib/track-fields.ts";
import { DAY, LIBRARY_ROOT, NOW } from "./fake-library.ts";

/** Sources and destinations the harness pretends are set up: two sync destinations (one with
 * work waiting, one in sync), a USB stick, a rekordbox file, iTunes and a Downloads folder. */

export const DOWNLOADS_FOLDER = "/Users/dj/Downloads";
export const USB_MOUNT = "/Volumes/DJ STICK";
export const NAS_TARGET_ID = 1;
export const R2_TARGET_ID = 2;

export function buildTargets(tracks: readonly Track[]): SyncTarget[] {
	return [
		{
			id: NAS_TARGET_ID,
			tailnet: "tail1234.ts.net",
			machine: "studio-nas",
			path: ["Music", "DJ Library"],
			syncedTracks: tracks.filter((track) => track.syncedCount > 0).length,
			libsync: true,
			libraryName: "Booth Library",
		},
		{
			id: R2_TARGET_ID,
			tailnet: "r2:4f1c9a",
			machine: "manplay-backup",
			path: ["library"],
			syncedTracks: tracks.filter((track) => track.syncedCount > 1).length,
			libsync: false,
			libraryName: null,
		},
	];
}

/** A song's place on a destination: Artist / Album / file. */
export function relOf(track: Track): string[] {
	return track.path.slice(LIBRARY_ROOT.length + 1).split("/");
}

const NO_EXTRAS = {
	from: null,
	remoteSize: null,
	note: null,
	optional: false,
	tags: null,
	localSize: null,
	merge: null,
	duplicateOf: null,
};

function uploadAction(track: Track, id: number): SyncAction {
	return {
		...NO_EXTRAS,
		id,
		targetId: NAS_TARGET_ID,
		kind: "upload",
		rel: relOf(track),
		size: track.size,
		trackId: track.id,
	};
}

/** One of each kind of change a sync review can show. */
export function buildNasActions(tracks: readonly Track[]): SyncAction[] {
	const unsynced = tracks.filter((track) => track.syncedCount === 0);
	const synced = tracks.filter((track) => track.syncedCount > 0);
	const at = (index: number) => synced[index] as Track;
	const base = { ...NO_EXTRAS, targetId: NAS_TARGET_ID };
	const uploads = unsynced.map((track, index) => uploadAction(track, index + 1));
	const next = uploads.length + 1;
	return [
		...uploads,
		{
			...base,
			id: next,
			kind: "replace",
			rel: relOf(at(0)),
			size: at(0).size,
			remoteSize: at(0).size - 48_000,
			note: "The library file is newer",
			trackId: at(0).id,
		},
		{
			...base,
			id: next + 1,
			kind: "move",
			rel: relOf(at(3)),
			from: ["Unsorted", relOf(at(3)).at(-1) ?? ""],
			size: at(3).size,
			trackId: at(3).id,
		},
		{
			...base,
			id: next + 2,
			kind: "update",
			rel: relOf(at(5)),
			size: at(5).size,
			tags: [
				{ field: "genre", from: "House", to: "Deep House" },
				{ field: "label", from: null, to: "Low Tide Records" },
			],
			trackId: at(5).id,
		},
		{
			...base,
			id: next + 3,
			kind: "merge",
			rel: relOf(at(8)),
			size: at(8).size,
			merge: [
				{ field: "genre", base: "House", mine: "Deep House", theirs: "House", side: "mine" },
				{ field: "year", base: "2023", mine: "2024", theirs: "2022", side: null },
			],
			trackId: at(8).id,
		},
		{
			...base,
			id: next + 4,
			kind: "conflict",
			rel: relOf(at(12)),
			size: at(12).size,
			remoteSize: at(12).size + 120_000,
			localSize: at(12).size,
			note: "Both copies changed since the last sync",
			trackId: at(12).id,
		},
		{
			...base,
			id: next + 5,
			kind: "delete",
			rel: ["Old Rips", "Unknown Artist", "track 07 (final) (2).mp3"],
			size: 9_812_344,
			optional: true,
			trackId: null,
		},
		{
			...base,
			id: next + 6,
			kind: "delete",
			rel: ["Mira Solène", "Glasshouse", "01 Glasshouse (copy).mp3"],
			size: 11_204_113,
			trackId: null,
			duplicateOf: at(1).id,
		},
	];
}

export function buildSyncHistory(): SyncRun[] {
	const nas = { targetId: NAS_TARGET_ID, tailnet: "tail1234.ts.net", machine: "studio-nas" };
	const run = (id: number, daysAgo: number, counts: Partial<SyncRun>): SyncRun => ({
		...nas,
		id,
		path: ["Music", "DJ Library"],
		startedAt: NOW - daysAgo * DAY - 190,
		finishedAt: NOW - daysAgo * DAY,
		uploaded: 0,
		skipped: 0,
		failed: 0,
		deleted: 0,
		firstError: null,
		errors: [],
		batch: id,
		...counts,
	});
	return [
		run(4, 1, { uploaded: 12, skipped: 96 }),
		run(3, 6, {
			uploaded: 3,
			skipped: 101,
			failed: 2,
			firstError: "studio-nas did not answer in time",
			errors: [
				"Kaito Brandt/Signal Loss/03 Hollow Static.mp3: studio-nas did not answer in time",
				"Kaito Brandt/Signal Loss/04 Open Rooms.mp3: studio-nas did not answer in time",
			],
		}),
		run(2, 14, { uploaded: 41, skipped: 60, deleted: 2 }),
		{
			...run(1, 9, { uploaded: 77 }),
			targetId: R2_TARGET_ID,
			tailnet: "r2:4f1c9a",
			machine: "manplay-backup",
			path: ["library"],
		},
	];
}

export function buildActivity(source: string): Activity[] {
	if (source === "rekordbox") {
		return [
			{
				id: 3,
				source,
				startedAt: NOW - 2 * DAY - 2,
				finishedAt: NOW - 2 * DAY,
				ok: 61,
				skipped: 0,
				failed: 0,
				items: ["Friday Warm-up", "Peak Time", "Sets/Friday", "New This Month"],
				errors: [],
			},
		];
	}
	return [
		{
			id: source === "import:1" ? 1 : 2,
			source,
			startedAt: NOW - 3 * DAY - 40,
			finishedAt: NOW - 3 * DAY,
			ok: 7,
			skipped: 1,
			failed: source === "import:2" ? 1 : 0,
			items: ["Odessa Vale — Paper Lanterns", "Halden — Fjordlight"],
			errors: source === "import:2" ? ["Purchased/Old Song.m4p: protected file"] : [],
		},
	];
}

export const REKORDBOX_STATUS: RekordboxStatus = {
	path: "/Users/dj/Documents/manplay-rekordbox.xml",
	exportedAt: NOW - 2 * DAY,
	playlists: 5,
	tracks: 61,
	error: null,
};

export const DEFAULT_SELECTION: ExportSelection = {
	playlists: [1, 2],
	tags: ["Sets/Friday"],
	smart: [1],
	usbMode: "add",
	usbOutputs: {
		rekordbox: true,
		serato: true,
		virtualDj: false,
		gemini: false,
		playlistFolders: false,
		rekordboxFormats: { deviceLibrary: true, oneLibrary: true },
	},
	usbFolderFileNames: [{ tag: "fileName" }],
};

/** The Downloads folder you pick from, and an iTunes folder that converts AAC and imports all. */
export const IMPORT_FOLDERS: ImportFolder[] = [
	{
		id: 1 as ImportFolderId,
		path: DOWNLOADS_FOLDER,
		enabled: true,
		convertAac: false,
		autoImport: false,
	},
	{
		id: 2 as ImportFolderId,
		path: "/Users/dj/Music/iTunes/iTunes Media",
		enabled: true,
		convertAac: true,
		autoImport: true,
	},
];

export const USB_DRIVES: UsbDrive[] = [
	{
		id: "usb-7C2A-11F0",
		name: "DJ STICK",
		mount: USB_MOUNT,
		filesystem: "FAT32",
		totalBytes: 64_000_000_000,
		freeBytes: 41_300_000_000,
		writable: true,
		hasLibrary: true,
		hasOneLibrary: true,
	},
];

export const USB_FORMATS: UsbFormats = {
	deviceLibrary: { tracks: 42, playlists: 4 },
	oneLibrary: { tracks: 42, playlists: 4 },
	serato: { tracks: 42, playlists: 3 },
	virtualDj: null,
	gemini: null,
	playlistFolders: null,
	deviceLibraryError: null,
	oneLibraryError: null,
	seratoError: null,
	virtualDjError: null,
	geminiError: null,
};

export function buildUsbLibrary(tracks: readonly Track[]): UsbLibrary {
	const onDrive = tracks.slice(0, 42);
	return {
		tracks: onDrive.map((track) => ({
			id: track.id,
			title: track.title,
			artist: track.artist,
			album: track.album,
			genre: fieldOf(track, "genre"),
			key: track.key ?? "",
			comment: "",
			path: `/Contents/${track.path.slice(LIBRARY_ROOT.length + 1)}`,
			analyzePath: `/PIONEER/USBANLZ/P${String(track.id).padStart(3, "0")}/ANLZ0000.DAT`,
			dateAdded: "2026-10-30",
			durationSecs: Math.round((track.durationMs ?? 0) / 1000),
			tempo: Math.round((track.bpm ?? 0) * 100),
			bitrate: track.bitrate ?? 320,
			sampleRate: track.sampleRate ?? 44_100,
			fileSize: track.size,
			year: Number(fieldOf(track, "year")),
			trackNumber: 1,
			fileType: 1,
			artworkId: 0,
		})),
		playlists: [
			{ id: 1, parentId: 0, name: "Residency", isFolder: true, sortOrder: 0, trackIds: [] },
			{
				id: 2,
				parentId: 1,
				name: "Friday Warm-up",
				isFolder: false,
				sortOrder: 0,
				trackIds: onDrive.slice(0, 16).map((track) => track.id),
			},
			{
				id: 3,
				parentId: 1,
				name: "Peak Time",
				isFolder: false,
				sortOrder: 1,
				trackIds: onDrive.slice(14, 36).map((track) => track.id),
			},
			{
				id: 4,
				parentId: 0,
				name: "Sets/Friday",
				isFolder: false,
				sortOrder: 1,
				trackIds: onDrive.slice(30, 42).map((track) => track.id),
			},
		],
		artwork: [],
	};
}

function importTrack(
	file: string,
	title: string,
	artist: string,
	album: string,
	status: ImportTrack["status"],
	entry: string | null,
	archive: string,
): ImportTrack {
	return {
		src: { path: `${DOWNLOADS_FOLDER}/${archive}`, entry },
		file,
		title,
		artist,
		size: 9_400_000 + title.length * 61_000,
		status,
		sameAs: status === "sameAudio" ? "Mira Solène — Glasshouse" : null,
		album,
		track: null,
		disc: null,
		year: "2026",
		genre: "House",
		label: "Sundial",
		bpm: "124",
		key: "Am",
		durationMs: 312_000 + title.length * 2100,
		bitrate: 320,
		sampleRate: 44_100,
		hasArt: status !== "duplicate",
	};
}

function importGroup(
	id: number,
	kind: ImportGroup["kind"],
	origin: string,
	artist: string,
	album: string,
	tracks: ImportTrack[],
): ImportGroup {
	return {
		id,
		kind,
		origin,
		fromZip: origin.endsWith(".zip"),
		modified: NOW - id * 5 * 3600,
		artist,
		album,
		tracks,
		images: [],
	};
}

export function buildImportScan(): ImportScan {
	const zip = "Odessa Vale - Lantern Remixes.zip";
	const remix = (number: number, title: string, status: ImportTrack["status"] = "new") =>
		importTrack(
			`0${number} ${title}.mp3`,
			title,
			"Odessa Vale",
			"Lantern Remixes",
			status,
			`0${number} ${title}.mp3`,
			zip,
		);
	const loose = (title: string, artist: string, status: ImportTrack["status"]) =>
		importTrack(
			`${artist} - ${title}.mp3`,
			title,
			artist,
			"",
			status,
			null,
			`${artist} - ${title}.mp3`,
		);
	return {
		groups: [
			importGroup(1, "album", zip, "Odessa Vale", "Lantern Remixes", [
				remix(1, "Golden Hours (Halden Remix)"),
				remix(2, "Paper Tide (Nuit Blanche Dub)"),
				remix(3, "Silver Rooms (Extended Mix)"),
				remix(4, "Open Current (Kaito Brandt Remix)", "sameAudio"),
				remix(5, "Falling Mirrors (Instrumental)", "duplicate"),
			]),
			importGroup(2, "single", "Velvet Circuit - Low Signal.mp3", "Velvet Circuit", "", [
				loose("Low Signal", "Velvet Circuit", "new"),
			]),
			importGroup(3, "single", "Sable Ferro - Iron Static.mp3", "Sable Ferro", "", [
				loose("Iron Static", "Sable Ferro", "inLibrary"),
			]),
		],
		alreadyInLibrary: 14,
		errors: 1,
	};
}

export function buildMissing(tracks: readonly Track[]): MissingTrack[] {
	return tracks.slice(60, 62).map((track, index) => ({
		id: 9000 + index,
		path: track.path.replace(".mp3", " (old).mp3"),
		title: track.title,
		artist: track.artist,
		album: track.album,
		removedAt: NOW + (12 - index * 5) * DAY,
	}));
}

export function buildDuplicates(tracks: readonly Track[]): DuplicateGroup[] {
	const copyOf = (track: Track, path: string, id: number) => ({
		id,
		path,
		title: track.title,
		artist: track.artist,
		album: track.album,
		size: track.size,
		embeddedCues: [] as DuplicateGroup["tracks"][number]["embeddedCues"],
	});
	const original = (track: Track) => copyOf(track, track.path, track.id);
	const folder = (track: Track) => track.path.slice(0, track.path.lastIndexOf("/"));
	const stem = (track: Track) => track.path.slice(track.path.lastIndexOf("/") + 1, -".mp3".length);
	const [a, b, c, d] = [20, 41, 57, 88].map((i) => tracks[i] as Track) as [
		Track,
		Track,
		Track,
		Track,
	];
	return [
		{
			// Same name in two folders: nothing in the names says which is the copy.
			key: "fp-duplicate-1",
			kind: "sameAudio",
			tracks: [original(a), copyOf(a, `${LIBRARY_ROOT}/Unsorted/${a.title}.mp3`, 9100)],
		},
		{
			// Converted twice from one Apple Music file: each encode has audio of its own.
			key: "source:/Users/demo/Music/iTunes/b.m4a",
			kind: "sameSource",
			tracks: [
				original(b),
				copyOf(b, `${folder(b)}/${stem(b)} (1).mp3`, 9101),
				copyOf(b, `${folder(b)}/${stem(b)} (2).mp3`, 9102),
			],
		},
		{
			key: "fp-duplicate-3",
			kind: "sameAudio",
			tracks: [
				original(c),
				{
					...copyOf(c, `${LIBRARY_ROOT}/Downloads/${stem(c)} - Copy.mp3`, 9103),
					embeddedCues: ["serato"],
				},
			],
		},
		{
			key: "fp-duplicate-4",
			kind: "sameAudio",
			tracks: [original(d), copyOf(d, `${folder(d)}/${stem(d)} copy 2.mp3`, 9104)],
		},
	];
}

export function buildAuditIssues(tracks: readonly Track[]): AuditIssue[] {
	const at = (index: number) => (tracks[index] as Track).path;
	const fixable = (path: string, kind: AuditIssue["kind"], message: string): AuditIssue => ({
		path,
		kind,
		message,
		fixable: true,
		place: null,
	});
	const needsAlbum = (name: string): AuditIssue => ({
		path: `${LIBRARY_ROOT}/Unsorted/${name}`,
		kind: "misplaced",
		message: "Not in an Artist/Album folder, and the file has no album tag",
		fixable: false,
		place: { artist: "Tomas Reyerson", album: null },
	});
	return [
		fixable(at(70).replace(".mp3", ".flac"), "notMp3", "FLAC file, not MP3"),
		fixable(at(71).replace(".mp3", ".wav"), "notMp3", "WAV file, not MP3"),
		fixable(at(33), "tagVersion", "Tags are ID3v2.4; CDJs read ID3v2.3"),
		fixable(at(34), "tagVersion", "Tags are ID3v2.4; CDJs read ID3v2.3"),
		fixable(at(35), "tagVersion", "Tags are ID3v2.4; CDJs read ID3v2.3"),
		fixable(
			`${LIBRARY_ROOT}/Downloads/Hollow Signal (Dub).mp3`,
			"misplaced",
			"Belongs in Halden/Fjordlight",
		),
		fixable(
			`${LIBRARY_ROOT}/Downloads/Hollow Signal (Dub).mp3`,
			"tagVersion",
			"Tags are ID3v2.4; CDJs read ID3v2.3",
		),
		needsAlbum("untitled bounce 3.mp3"),
		needsAlbum("untitled bounce 4.mp3"),
		{
			path: "/Volumes/Old Drive/stray.mp3",
			kind: "misplaced",
			message: "Misplaced: outside the library",
			fixable: false,
			place: null,
		},
	];
}

export const CLASHES: Clash[] = [
	{
		id: 1,
		kind: "playlist",
		name: "Peak Time",
		keeps: { uid: "pl-keeps", id: 2, scope: "shared", name: "Peak Time", songs: 24 },
		held: { uid: "pl-held", id: 6, scope: "shared", name: "Peak Time (studio-mac)", songs: 19 },
	},
];

export const RECENTLY_DELETED: DeletedItem[] = [
	{
		kind: "playlist",
		uid: "deleted-1",
		name: "NYE 2025",
		by: "This device",
		at: NOW - 4 * DAY,
		songs: 38,
	},
	{
		kind: "tag",
		uid: "deleted-2",
		name: "Genre/Trance",
		by: "studio-mac",
		at: NOW - 21 * DAY,
		songs: 6,
	},
];

const NO_CHANGE = {
	standing: "existing",
	renamedFrom: null,
	mergedInto: null,
	rulesChanged: false,
	songsAdded: 0,
	songsRemoved: 0,
	songsMoved: 0,
	count: 0,
} as const;

/** What other devices changed lately, one entry per sync. */
export const LIBRARY_CHANGES: LibraryChangeBatch[] = [
	{
		id: (NOW - 140) * 1000,
		at: NOW - 140,
		by: ["studio-mac"],
		undone: false,
		changes: [
			{
				...NO_CHANGE,
				kind: "playlist",
				name: "Friday warmup",
				standing: "created",
				songsAdded: 24,
			},
			{ ...NO_CHANGE, kind: "tag", name: "Genre/House", songsAdded: 6, songsRemoved: 1 },
			{ ...NO_CHANGE, kind: "smart_playlist", name: "Peak 126+", rulesChanged: true },
			{ ...NO_CHANGE, kind: "analysis", name: "", count: 31 },
			{ ...NO_CHANGE, kind: "song_tags", name: "", count: 12 },
		],
	},
	{
		id: (NOW - 2 * DAY) * 1000,
		at: NOW - 2 * DAY,
		by: ["studio-mac", "tour-laptop"],
		undone: false,
		changes: [
			{ ...NO_CHANGE, kind: "playlist", name: "Closing", renamedFrom: "Last hour", songsMoved: 3 },
			{ ...NO_CHANGE, kind: "tag", name: "Energy/Low", standing: "deleted" },
			{ ...NO_CHANGE, kind: "covers", name: "", count: 3 },
			{ ...NO_CHANGE, kind: "songs_moved", name: "", count: 4 },
			{ ...NO_CHANGE, kind: "songs_added", name: "", count: 2 },
		],
	},
	{
		id: (NOW - 9 * DAY) * 1000,
		at: NOW - 9 * DAY,
		by: ["tour-laptop"],
		undone: true,
		changes: [{ ...NO_CHANGE, kind: "tag", name: "Vocal", songsAdded: 112 }],
	},
];

/** Deletions a sync held back for a choice. */
export const DELETE_HOLD: DeleteHold = {
	count: 31,
	by: ["tour-laptop"],
	names: ["Genre/Techno", "Genre/Techno/Hard", "Genre/Techno/Dub", "Festival 2026", "B2B ideas"],
	at: NOW - 900,
};

/** Songs another device removed that this library still has. */
export const FILE_REMOVALS: FileRemoval[] = [
	{
		audioFp: "removed-1",
		trackId: 1,
		title: "Glue",
		artist: "Bicep",
		path: "Bicep/Bicep/Glue.flac",
		by: "tour-laptop",
		at: NOW - 3600,
	},
	{
		audioFp: "removed-2",
		trackId: 2,
		title: "Opal (Four Tet Remix)",
		artist: "Bicep",
		path: "Bicep/Singles/Opal (Four Tet Remix).mp3",
		by: "tour-laptop",
		at: NOW - 3500,
	},
];

const pickerFolder = (name: string): FsEntry => ({ name, isDir: true, size: 0, modified: NOW });
const pickerFile = (name: string, size: number): FsEntry => ({
	name,
	isDir: false,
	size,
	modified: NOW,
});

/** The file picker's sidebar on this made-up computer. */
export const PICKER_PLACES: PickerPlace[] = [
	{ kind: "home", name: "dj", path: "/Users/dj" },
	{ kind: "desktop", name: "Desktop", path: "/Users/dj/Desktop" },
	{ kind: "documents", name: "Documents", path: "/Users/dj/Documents" },
	{ kind: "downloads", name: "Downloads", path: DOWNLOADS_FOLDER },
	{ kind: "music", name: "Music", path: "/Users/dj/Music" },
	{ kind: "volume", name: "Macintosh HD", path: "/" },
	{ kind: "volume", name: "DJ STICK", path: USB_MOUNT },
];

/** What the file picker finds outside the library, by folder. A folder not listed is empty. */
export const PICKER_FOLDERS: Readonly<Record<string, FsEntry[]>> = {
	"/": [pickerFolder("Users"), pickerFolder("Volumes")],
	"/Users": [pickerFolder("dj")],
	"/Users/dj": ["Desktop", "Documents", "Downloads", "Music", "Pictures"].map(pickerFolder),
	"/Users/dj/Documents": [pickerFolder("Sets"), pickerFile("manplay-rekordbox.xml", 482_113)],
	[DOWNLOADS_FOLDER]: [
		pickerFolder("Bandcamp"),
		pickerFolder("Promos 2026"),
		pickerFile("Around the World (Edit).mp3", 9_402_113),
		pickerFile("Promo pack.zip", 148_220_001),
	],
	"/Users/dj/Music": [pickerFolder("Library"), pickerFolder("New Arrivals")],
	"/Users/dj/Pictures": [
		pickerFolder("Covers"),
		pickerFile("Homework.jpg", 412_776),
		pickerFile("Discovery.PNG", 1_204_332),
		pickerFile("Tracklist.txt", 2_114),
	],
	"/Volumes": [pickerFolder("DJ STICK")],
	[USB_MOUNT]: [pickerFolder("Contents"), pickerFolder("PIONEER")],
};
