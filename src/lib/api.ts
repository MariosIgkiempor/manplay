import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { z } from "zod";

const int = z.number().int();

// ---- tracks ---------------------------------------------------------------

const trackSchema = z.object({
	id: int,
	path: z.string(),
	artist: z.string(),
	album: z.string(),
	title: z.string(),
	size: int,
	tags: z.array(z.string()),
	syncedCount: int,
	durationMs: int.nullable(),
	bitrate: int.nullable(),
	sampleRate: int.nullable(),
});

export type Track = z.infer<typeof trackSchema>;

export async function listTracks(): Promise<Track[]> {
	return z.array(trackSchema).parse(await invoke("list_tracks"));
}

/** Prompts for a folder and scans it. Returns the number of tracks found, or null if cancelled. */
export async function pickAndScan(): Promise<number | null> {
	const root = await open({ directory: true, multiple: false });
	if (root === null) {
		return null;
	}
	return int.parse(await invoke("scan_library", { root }));
}

/** Rescans the remembered library folder. Returns null when no folder has been chosen yet. */
export async function rescanLibrary(): Promise<number | null> {
	return int.nullable().parse(await invoke("rescan_library"));
}

export async function getLibraryRoot(): Promise<string | null> {
	return z
		.string()
		.nullable()
		.parse(await invoke("get_library_root"));
}

const libraryStatusSchema = z.object({ missing: int, graceDays: int });

export type LibraryStatus = z.infer<typeof libraryStatusSchema>;

export async function libraryStatus(): Promise<LibraryStatus> {
	return libraryStatusSchema.parse(await invoke("library_status"));
}

/** Ends the grace period for missing tracks; the next sync removes their remote copies. */
export async function removeMissingNow(): Promise<void> {
	await invoke("remove_missing_now");
}

/** URL of the album artwork thumbnail for a track (404s when there is none). */
export function artUrl(trackId: number): string {
	return convertFileSrc(String(trackId), "art");
}

/** Artwork for a file or folder in the library (a folder uses the first track inside it). */
export function pathArtUrl(path: string): string {
	return convertFileSrc(path, "art");
}

/** URL the webview can stream audio from. */
export function audioUrl(path: string): string {
	return convertFileSrc(path);
}

// ---- playlists ------------------------------------------------------------

const playlistSchema = z.object({ id: int, name: z.string(), trackCount: int });

export type Playlist = z.infer<typeof playlistSchema>;

export async function listPlaylists(): Promise<Playlist[]> {
	return z.array(playlistSchema).parse(await invoke("list_playlists"));
}

export async function createPlaylist(name: string): Promise<number> {
	return int.parse(await invoke("create_playlist", { name }));
}

export async function renamePlaylist(id: number, name: string): Promise<void> {
	await invoke("rename_playlist", { id, name });
}

export async function deletePlaylist(id: number): Promise<void> {
	await invoke("delete_playlist", { id });
}

export async function addToPlaylist(playlistId: number, trackIds: number[]): Promise<void> {
	await invoke("add_to_playlist", { playlistId, trackIds });
}

export async function removeFromPlaylist(playlistId: number, trackId: number): Promise<void> {
	await invoke("remove_from_playlist", { playlistId, trackId });
}

export async function playlistTracks(playlistId: number): Promise<Track[]> {
	return z.array(trackSchema).parse(await invoke("playlist_tracks", { playlistId }));
}

// ---- tags -----------------------------------------------------------------

const tagSchema = z.object({ id: int, name: z.string(), trackCount: int });

export type Tag = z.infer<typeof tagSchema>;

export async function listTags(): Promise<Tag[]> {
	return z.array(tagSchema).parse(await invoke("list_tags"));
}

export async function tagTracks(name: string, trackIds: number[]): Promise<void> {
	await invoke("tag_tracks", { name, trackIds });
}

export async function untagTrack(name: string, trackId: number): Promise<void> {
	await invoke("untag_track", { name, trackId });
}

export async function deleteTag(id: number): Promise<void> {
	await invoke("delete_tag", { id });
}

// ---- tailscale / taildrive ------------------------------------------------

const machineSchema = z.object({
	name: z.string(),
	hostName: z.string(),
	os: z.string(),
	online: z.boolean(),
	isSelf: z.boolean(),
});

const statusSchema = z.object({ tailnet: z.string(), machines: z.array(machineSchema) });

export type Machine = z.infer<typeof machineSchema>;

export async function tailscaleStatus() {
	return statusSchema.parse(await invoke("tailscale_status"));
}

const entrySchema = z.object({ name: z.string(), isDir: z.boolean() });

export async function driveList(tailnet: string, machine: string, path: string[]) {
	return z.array(entrySchema).parse(await invoke("drive_list", { tailnet, machine, path }));
}

// ---- sync -----------------------------------------------------------------

const newTargetSchema = z.object({
	tailnet: z.string(),
	machine: z.string(),
	path: z.array(z.string()),
});

export type NewTarget = z.infer<typeof newTargetSchema>;

const targetSchema = newTargetSchema.extend({ id: int, syncedTracks: int });

export type SyncTarget = z.infer<typeof targetSchema>;

export async function listSyncTargets(): Promise<SyncTarget[]> {
	return z.array(targetSchema).parse(await invoke("list_sync_targets"));
}

export async function addSyncTarget(target: NewTarget): Promise<number> {
	return int.parse(await invoke("add_sync_target", { target }));
}

export async function removeSyncTarget(id: number): Promise<void> {
	await invoke("remove_sync_target", { id });
}

const runSchema = z.object({
	id: int,
	targetId: int,
	machine: z.string(),
	path: z.array(z.string()),
	startedAt: int,
	finishedAt: int,
	uploaded: int,
	skipped: int,
	failed: int,
	deleted: int,
	firstError: z.string().nullable(),
});

export type SyncRun = z.infer<typeof runSchema>;

export async function syncHistory(limit: number): Promise<SyncRun[]> {
	return z.array(runSchema).parse(await invoke("sync_history", { limit }));
}

/** Syncs one target, or every target when `targetId` is omitted. */
export async function syncRun(targetId?: number): Promise<void> {
	await invoke("sync_run", { targetId: targetId ?? null });
}

const progressSchema = z.object({
	targetId: int,
	done: int,
	total: int,
	current: z.string(),
});

export type SyncProgress = z.infer<typeof progressSchema>;

/** Subscribes to sync progress; returns an unsubscribe function. */
export function onSyncProgress(handler: (p: SyncProgress) => void): Promise<() => void> {
	return listen("sync-progress", (e) => {
		const parsed = progressSchema.safeParse(e.payload);
		if (parsed.success) {
			handler(parsed.data);
		}
	});
}

// ---- rekordbox ------------------------------------------------------------

const rekordboxSchema = z.object({
	path: z.string().nullable(),
	exportedAt: int.nullable(),
	playlists: int,
	tracks: int,
	error: z.string().nullable(),
});

export type RekordboxStatus = z.infer<typeof rekordboxSchema>;

export async function rekordboxStatus(): Promise<RekordboxStatus> {
	return rekordboxSchema.parse(await invoke("rekordbox_status"));
}

/** Asks where to save the rekordbox XML. Returns null if cancelled. */
export function pickRekordboxFile(): Promise<string | null> {
	return save({
		title: "Where should manplay save the rekordbox library?",
		defaultPath: "manplay-rekordbox.xml",
		filters: [{ name: "rekordbox xml", extensions: ["xml"] }],
	});
}

/** Sets (or clears, with null) the export file; it is written immediately. */
export async function setRekordboxPath(path: string | null): Promise<RekordboxStatus> {
	return rekordboxSchema.parse(await invoke("rekordbox_set_path", { path }));
}

export async function exportRekordbox(): Promise<RekordboxStatus> {
	return rekordboxSchema.parse(await invoke("rekordbox_export"));
}

// ---- iTunes import --------------------------------------------------------

const itunesReportSchema = z.object({
	ranAt: int,
	converted: z.array(
		z.object({ artist: z.string(), album: z.string(), title: z.string(), dest: z.string() }),
	),
	skipped: int,
	failed: z.array(z.object({ file: z.string(), error: z.string() })),
	error: z.string().nullable(),
});

const itunesSchema = z.object({
	path: z.string().nullable(),
	last: itunesReportSchema.nullable(),
});

export type ItunesStatus = z.infer<typeof itunesSchema>;

export async function itunesStatus(): Promise<ItunesStatus> {
	return itunesSchema.parse(await invoke("itunes_status"));
}

/** Asks for the iTunes folder. Returns null if cancelled. */
export function pickItunesFolder(): Promise<string | null> {
	return open({ directory: true, multiple: false, title: "Choose your iTunes media folder" });
}

export async function setItunesPath(path: string | null): Promise<ItunesStatus> {
	return itunesSchema.parse(await invoke("itunes_set_path", { path }));
}

/** Converts new iTunes songs into the library. Null when iTunes or the library is not set up. */
export async function itunesImport(): Promise<ItunesStatus | null> {
	return itunesSchema.nullable().parse(await invoke("itunes_import"));
}

// ---- file browser ---------------------------------------------------------

const fsEntrySchema = z.object({
	name: z.string(),
	isDir: z.boolean(),
	size: z.number(),
	modified: int.nullable(),
});

export type FsEntry = z.infer<typeof fsEntrySchema>;

/** Lists a folder inside the library (folders first). */
export async function fsList(path: string): Promise<FsEntry[]> {
	return z.array(fsEntrySchema).parse(await invoke("fs_list", { path }));
}

export async function fsMakeDir(parent: string, name: string): Promise<void> {
	await invoke("fs_make_dir", { parent, name });
}

export async function fsRename(path: string, newName: string): Promise<void> {
	await invoke("fs_rename", { path, newName });
}

/** Copies into `dest`; a name already taken there gets " copy" added. */
export async function fsCopy(paths: string[], dest: string): Promise<void> {
	await invoke("fs_copy", { paths, dest });
}

/** Moves to the system Trash. */
export async function fsTrash(paths: string[]): Promise<void> {
	await invoke("fs_trash", { paths });
}

/** Native yes/no prompt before deleting. */
export function confirmTrash(names: string[]): Promise<boolean> {
	const what = names.length === 1 ? `“${names[0]}”` : `${names.length} items`;
	return ask(`Move ${what} to the Trash?`, {
		title: "Delete",
		kind: "warning",
		okLabel: "Move to Trash",
	});
}

/** Moves files and folders into `dest`. Fails without changing anything on a name clash. */
export async function fsMove(paths: string[], dest: string): Promise<void> {
	await invoke("fs_move", { paths, dest });
}

// ---- import from downloads ---------------------------------------------------

const sourceRefSchema = z.object({ path: z.string(), entry: z.string().nullable() });
export type SourceRef = z.infer<typeof sourceRefSchema>;

const importTrackSchema = z.object({
	src: sourceRefSchema,
	file: z.string(),
	title: z.string(),
	artist: z.string(),
	size: z.number(),
	status: z.enum(["new", "inLibrary", "duplicate"]),
});

const importGroupSchema = z.object({
	id: int,
	kind: z.enum(["album", "single"]),
	origin: z.string(),
	fromZip: z.boolean(),
	modified: int,
	artist: z.string(),
	album: z.string(),
	tracks: z.array(importTrackSchema),
	images: z.array(sourceRefSchema),
});

const importScanSchema = z.object({
	groups: z.array(importGroupSchema),
	alreadyInLibrary: int,
	errors: int,
});

export type ImportTrack = z.infer<typeof importTrackSchema>;
export type ImportGroup = z.infer<typeof importGroupSchema>;
export type ImportScan = z.infer<typeof importScanSchema>;

const importReportSchema = z.object({
	imported: int,
	images: int,
	failed: z.array(z.object({ file: z.string(), error: z.string() })),
});

export type ImportReport = z.infer<typeof importReportSchema>;

export interface ImportRequest {
	artist: string;
	album: string;
	tracks: SourceRef[];
	images: SourceRef[];
}

export async function importGetFolder(): Promise<string | null> {
	return z
		.string()
		.nullable()
		.parse(await invoke("import_get_folder"));
}

export function pickImportFolder(): Promise<string | null> {
	return open({ directory: true, multiple: false, title: "Choose a folder to import from" });
}

/**
 * Finds music in `folder` (zips included) that is not in the library yet. Files unchanged since
 * the last scan come from a cache; `fresh` ignores it and reads everything again.
 */
export async function importScan(folder: string, fresh = false): Promise<ImportScan> {
	return importScanSchema.parse(await invoke("import_scan", { folder, fresh }));
}

/** Copies the chosen tracks into the library as Artist/Album. */
export async function importRun(folder: string, groups: ImportRequest[]): Promise<ImportReport> {
	return importReportSchema.parse(await invoke("import_run", { folder, groups }));
}

/** What the last scan of `folder` found, from the cache alone (instant). Null if never scanned. */
export async function importCached(folder: string): Promise<ImportScan | null> {
	return importScanSchema.nullable().parse(await invoke("import_cached", { folder }));
}

/** A local file the player can stream for an import candidate (zip entries are extracted first). */
export async function importPreview(folder: string, src: SourceRef): Promise<string> {
	return z.string().parse(await invoke("import_preview", { folder, src }));
}

const importProgressSchema = z.object({
	phase: z.enum(["listing", "checking", "tags"]),
	done: int,
	total: int,
});

export type ImportProgress = z.infer<typeof importProgressSchema>;

/** Subscribes to import-scan progress; returns an unsubscribe function. */
export function onImportProgress(handler: (p: ImportProgress) => void): Promise<() => void> {
	return listen("import-progress", (e) => {
		const parsed = importProgressSchema.safeParse(e.payload);
		if (parsed.success) {
			handler(parsed.data);
		}
	});
}
