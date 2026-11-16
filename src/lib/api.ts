import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { z } from "zod";
import { TRASH } from "#/lib/platform.ts";

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
	/** Detected tempo, else the one in the file's tags. */
	bpm: z.number().nullable(),
	/** Detected key in rekordbox spelling ("Am", "F#"), else the one in the file's tags. */
	key: z.string().nullable(),
	/** BPM and key detection has run on this audio (whether or not it found them). */
	analyzed: z.boolean(),
	/** BPM, key, genre, label, ... as stored in the file (see `LISTED` in `src-tauri/src/tags.rs`). */
	fields: z.record(z.string(), z.string()).default({}),
	/** Which of BPM, key and beat grid were set by hand; re-analysis keeps them unless told not to. */
	edited: z
		.object({ bpm: z.boolean(), key: z.boolean(), grid: z.boolean() })
		.default({ bpm: false, key: false, grid: false }),
	/** Unix seconds the song came into the library; null for songs from before this was kept. */
	addedAt: int.nullable().optional(),
});

export type Track = z.infer<typeof trackSchema>;

export async function listTracks(): Promise<Track[]> {
	return z.array(trackSchema).parse(await invoke("list_tracks"));
}

// ---- BPM and key analysis ------------------------------------------------

const fileFailureSchema = z.object({ path: z.string(), error: z.string() });

export type FileFailure = z.infer<typeof fileFailureSchema>;

const tagWriteReportSchema = z.object({
	written: int,
	/** Files whose tags already held these values. */
	unchanged: int,
	failed: z.array(fileFailureSchema),
});

export type TagWriteReport = z.infer<typeof tagWriteReportSchema>;

const analysisReportSchema = z.object({
	analyzed: int,
	failed: int,
	cancelled: int,
	/** Set when the results were also written into file tags. */
	tags: tagWriteReportSchema.nullable(),
});

export type AnalysisReport = z.infer<typeof analysisReportSchema>;

const analysisSettingsSchema = z.object({
	/** Write detected BPM and key into the files' tags after each analysis. */
	writeTags: z.boolean(),
	/** Key notation in the tags. */
	keyFormat: z.enum(["musical", "camelot"]),
	/** Re-analysing replaces BPM, key and beat grids set by hand. */
	replaceEdits: z.boolean().default(false),
});

export type AnalysisSettings = z.infer<typeof analysisSettingsSchema>;

export async function analysisSettings(): Promise<AnalysisSettings> {
	return analysisSettingsSchema.parse(await invoke("analysis_settings"));
}

export async function setAnalysisSettings(settings: AnalysisSettings): Promise<void> {
	await invoke("set_analysis_settings", { settings });
}

/** Songs whose analysis failed, and why. */
export async function analysisFailures(): Promise<FileFailure[]> {
	return z.array(fileFailureSchema).parse(await invoke("analysis_failures"));
}

/** Writes every saved BPM and key result into the files' tags now. */
export async function saveAnalysisToFiles(): Promise<TagWriteReport> {
	return tagWriteReportSchema.parse(await invoke("save_analysis_to_files"));
}

/**
 * Detects BPM and key for `trackIds` (every track when omitted). Without `force`, audio that
 * was analyzed before is skipped.
 */
/** `replaceEdits` overrides the setting for this run: `true` discards values set by hand. */
export async function analyzeTracks(
	trackIds?: number[],
	force = false,
	replaceEdits?: boolean,
): Promise<AnalysisReport> {
	return analysisReportSchema.parse(
		await invoke("analyze_tracks", {
			trackIds: trackIds ?? null,
			force,
			replaceEdits: replaceEdits ?? null,
		}),
	);
}

/**
 * Sets one song's BPM and/or key by hand ("" clears): kept over the detected value and written
 * into the file's tags. The key may be typed as Camelot, Open Key or a note name.
 */
export async function setTempoKey(
	trackId: number,
	edit: { bpm?: string; key?: string },
): Promise<FixReport> {
	return fixReportSchema.parse(
		await invoke("set_tempo_key", { trackId, bpm: edit.bpm ?? null, key: edit.key ?? null }),
	);
}

/** Stops the running analysis after the files being read now. */
export async function cancelAnalysis(): Promise<void> {
	await invoke("cancel_analysis");
}

const analysisProgressSchema = z.object({
	phase: z.enum(["analyzing", "saving"]),
	done: int,
	total: int,
});

export type AnalysisProgress = z.infer<typeof analysisProgressSchema>;

/** Subscribes to analysis progress; returns an unsubscribe function. */
export function onAnalysisProgress(handler: (p: AnalysisProgress) => void): Promise<() => void> {
	return listen("analysis-progress", (e) => {
		const parsed = analysisProgressSchema.safeParse(e.payload);
		if (parsed.success) {
			handler(parsed.data);
		}
	});
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

/** Backs up, clears the track table and rescans. Returns null when no folder has been chosen. */
export async function resetLibrary(): Promise<number | null> {
	return int.nullable().parse(await invoke("reset_library"));
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

const missingTrackSchema = z.object({
	id: int,
	path: z.string(),
	title: z.string(),
	artist: z.string(),
	album: z.string(),
	/** Unix seconds when the track is removed for good. */
	removedAt: int,
});

export type MissingTrack = z.infer<typeof missingTrackSchema>;

/** Tracks whose files are gone from disk. */
export async function listMissing(): Promise<MissingTrack[]> {
	return z.array(missingTrackSchema).parse(await invoke("list_missing"));
}

const duplicateGroupSchema = z.object({
	audioFp: z.string(),
	tracks: z.array(
		z.object({
			id: int,
			path: z.string(),
			title: z.string(),
			artist: z.string(),
			album: z.string(),
			size: int,
		}),
	),
});

export type DuplicateGroup = z.infer<typeof duplicateGroupSchema>;

/** Groups of present songs with the same audio: they share tags, grid and playlist entries. */
export async function listDuplicates(): Promise<DuplicateGroup[]> {
	return z.array(duplicateGroupSchema).parse(await invoke("list_duplicates"));
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

const REMOTE_PREFIX = "remote:";

/** The player's name for a file on a destination: `remote:<destination id>/<folder>/<file>`. */
export function remoteTrackPath(targetId: number, rel: readonly string[]): string {
	return `${REMOTE_PREFIX}${[String(targetId), ...rel].join("/")}`;
}

/** URL the webview can stream audio from; destination files stream through the `remote` scheme. */
export function audioUrl(path: string): string {
	return path.startsWith(REMOTE_PREFIX)
		? convertFileSrc(path.slice(REMOTE_PREFIX.length), "remote")
		: convertFileSrc(path);
}

/** Extensions that may hold audio the Windows webview cannot decode (AIFF, ALAC). */
const MAYBE_UNPLAYABLE = /\.(aif|aiff|aifc|m4a|mp4|alac)$/i;

/** {@link audioUrl}, except for AIFF and ALAC songs on Windows (WebView2 has no decoder for
 * them): those stream through `pcm://`, which decodes them as they play. */
export async function playableUrl(path: string): Promise<string> {
	if (path.startsWith(REMOTE_PREFIX) || !MAYBE_UNPLAYABLE.test(path)) {
		return audioUrl(path);
	}
	const decode = await invoke<boolean>("playback_needs_decoding", { path });
	return decode ? convertFileSrc(path, "pcm") : audioUrl(path);
}

// ---- playlists ------------------------------------------------------------

/** Whether an item is shared with everyone on the destination or stays on this device. */
const scopeSchema = z.enum(["shared", "local"]);

export type Scope = z.infer<typeof scopeSchema>;

/** What the sidebar knows about a tag, playlist or smart playlist beyond its name. */
const sharingFields = {
	/** Absent counts as shared. */
	scope: scopeSchema.optional(),
	/** Hidden on this device only. */
	hidden: z.boolean().optional(),
	/** Shown under a held name because another item has the name (see Clashes). */
	held: z.boolean().optional(),
};

const playlistSchema = z.object({
	id: int,
	name: z.string(),
	trackCount: int,
	...sharingFields,
});

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

const tagSchema = z.object({ id: int, name: z.string(), trackCount: int, ...sharingFields });

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

/** Moves every track of the library tags in `from` to `to` (created if needed); `null` deletes them. */
export async function migrateLibraryTags(from: string[], to: string | null): Promise<void> {
	await invoke("migrate_library_tags", { from, to });
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

const targetSchema = newTargetSchema.extend({
	id: int,
	syncedTracks: int,
	/** This device's shared library lives on this destination (the others are files only). */
	libsync: z.boolean(),
	/** The shared library's name, once known. */
	libraryName: z.string().nullable(),
});

export type SyncTarget = z.infer<typeof targetSchema>;

export async function listSyncTargets(): Promise<SyncTarget[]> {
	return z.array(targetSchema).parse(await invoke("list_sync_targets"));
}

export async function addSyncTarget(target: NewTarget): Promise<number> {
	return int.parse(await invoke("add_sync_target", { target }));
}

/** A destination as people read it: the machine and its folder. */
export function targetName(target: SyncTarget): string {
	return [target.machine, ...target.path].join(" / ");
}

export function isR2(target: SyncTarget): boolean {
	return target.tailnet.startsWith("r2:");
}

export interface NewR2Target {
	account: string;
	bucket: string;
	prefix: string;
	keyId: string;
	secret: string;
}

export async function addR2Target(t: NewR2Target): Promise<number> {
	return int.parse(await invoke("add_r2_target", { ...t }));
}

/** Changes a destination's folder; for R2 also its access key (blank secret keeps the stored one). */
export async function updateSyncTarget(t: {
	id: number;
	path: string[];
	keyId?: string | undefined;
	secret?: string | undefined;
}): Promise<void> {
	await invoke("update_sync_target", {
		id: t.id,
		path: t.path,
		keyId: t.keyId ?? null,
		secret: t.secret ?? null,
	});
}

const libraryOutcomeSchema = z.object({
	targetId: int,
	name: z.string(),
	sent: int,
	received: int,
	unreadable: int,
	waveformsSent: int,
	error: z.string().nullable(),
});
export type LibraryOutcome = z.infer<typeof libraryOutcomeSchema>;

/**
 * Sends this device's library edits to the destinations that share them and applies
 * everyone else's. Run before the files.
 */
export async function libsyncRun(targetIds: number[]): Promise<LibraryOutcome[]> {
	return z.array(libraryOutcomeSchema).parse(await invoke("libsync_run", { targetIds }));
}

const foundLibrarySchema = z.object({
	libraryId: z.string(),
	name: z.string(),
	createdAt: int,
	members: z.array(z.object({ name: z.string(), lastSeen: int, mine: z.boolean() })),
	/** When a member last synced (Unix seconds). */
	lastChange: int.nullable(),
});
export type FoundLibrary = z.infer<typeof foundLibrarySchema>;

/** What a destination holds: a shared library with its members, or null. Writes nothing. */
export async function libsyncInspect(targetId: number): Promise<FoundLibrary | null> {
	return foundLibrarySchema.nullable().parse(await invoke("libsync_inspect", { targetId }));
}

/** How many tags, playlists and smart playlists "replace mine" would drop. */
export async function libsyncReplaceCount(): Promise<number> {
	return int.parse(await invoke("libsync_replace_count"));
}

/**
 * What happens to what this device has when it joins: `merge` shares it (same names become
 * clashes), `keepLocal` makes it local, `replace` drops it, `start` begins a library there.
 */
export type JoinChoice = "merge" | "keepLocal" | "replace" | "start";

/** Joins (or starts) the shared library on a destination and syncs it once. */
export async function libsyncJoin(targetId: number, choice: JoinChoice): Promise<LibraryOutcome> {
	return libraryOutcomeSchema.parse(await invoke("libsync_join", { targetId, choice }));
}

/** What happens to the shared items on this device when it leaves: keep them as local or drop them. */
export type LeaveChoice = "keepCopy" | "keepLocal";

/** Leaves the shared library; `sync` sends and receives one last time first. */
export async function libsyncLeave(choice: LeaveChoice, sync: boolean): Promise<void> {
	await invoke("libsync_leave", { choice, sync });
}

/** The name other members see this device as. */
export async function getDeviceName(): Promise<string> {
	return z.string().parse(await invoke("get_device_name"));
}

/** Names this device (blank goes back to the machine's name); returns the name now in use. */
export async function setDeviceName(name: string): Promise<string> {
	return z.string().parse(await invoke("set_device_name", { name }));
}

export async function removeSyncTarget(id: number): Promise<void> {
	await invoke("remove_sync_target", { id });
}

const runSchema = z.object({
	id: int,
	targetId: int,
	tailnet: z.string(),
	machine: z.string(),
	path: z.array(z.string()),
	startedAt: int,
	finishedAt: int,
	uploaded: int,
	skipped: int,
	failed: int,
	deleted: int,
	firstError: z.string().nullable(),
	errors: z.array(z.string()),
	batch: int,
});

export type SyncRun = z.infer<typeof runSchema>;

export async function syncHistory(limit: number): Promise<SyncRun[]> {
	return z.array(runSchema).parse(await invoke("sync_history", { limit }));
}

export async function dismissSyncRuns(ids: number[]): Promise<void> {
	await invoke("dismiss_sync_runs", { ids });
}

export type ActivitySource = "downloads" | "itunes" | "rekordbox";

const activitySchema = z.object({
	id: int,
	source: z.string(),
	startedAt: int,
	finishedAt: int,
	ok: int,
	skipped: int,
	failed: int,
	items: z.array(z.string()),
	errors: z.array(z.string()),
});

export type Activity = z.infer<typeof activitySchema>;

/** Past runs of an import or export source, newest first. */
export async function activityHistory(source: ActivitySource, limit: number): Promise<Activity[]> {
	return z.array(activitySchema).parse(await invoke("activity_history", { source, limit }));
}

export async function dismissActivity(ids: number[]): Promise<void> {
	await invoke("dismiss_activity", { ids });
}

const sideSchema = z.enum(["mine", "theirs"]);
export type Side = z.infer<typeof sideSchema>;

/** One tag field a merge row shows: the common ancestor and both edits. */
const fieldMergeSchema = z.object({
	field: z.string(),
	base: z.string().nullable(),
	mine: z.string().nullable(),
	theirs: z.string().nullable(),
	/** Which side wins when only one changed the field; `null` when both did and someone must choose. */
	side: sideSchema.nullable(),
});
export type FieldMerge = z.infer<typeof fieldMergeSchema>;

/** What the user chose for a merge (per clashing field) or a conflict (which copy stays). */
export interface Resolution {
	keep?: Side;
	fields: Record<string, Side>;
}

const actionSchema = z.object({
	id: int,
	targetId: int,
	kind: z.enum(["upload", "replace", "move", "delete", "update", "merge", "conflict"]),
	rel: z.array(z.string()),
	from: z.array(z.string()).nullable(),
	size: int,
	remoteSize: int.nullable(),
	note: z.string().nullable(),
	optional: z.boolean(),
	tags: z
		.array(z.object({ field: z.string(), from: z.string().nullable(), to: z.string().nullable() }))
		.nullable(),
	localSize: int.nullable(),
	merge: z.array(fieldMergeSchema).nullable(),
});
export type SyncAction = z.infer<typeof actionSchema>;

const targetPlanSchema = z.object({
	targetId: int,
	name: z.string(),
	error: z.string().nullable(),
	actions: z.array(actionSchema),
	held: z.array(z.object({ rel: z.array(z.string()), reason: z.string() })),
	inSync: int,
	remoteTotal: int,
	unchecked: int,
});
export type TargetPlan = z.infer<typeof targetPlanSchema>;

const planSchema = z.object({ id: z.string(), targets: z.array(targetPlanSchema) });
export type SyncPlan = z.infer<typeof planSchema>;

/**
 * Compares destinations with the library and returns what a sync would push, rename and delete.
 * Changes nothing. Omit `ids` for every target of an enabled service.
 */
export async function syncPlan(ids?: number[]): Promise<SyncPlan> {
	return planSchema.parse(await invoke("sync_plan", { targetIds: ids ?? null }));
}

const applySummarySchema = z.object({
	targetId: int,
	name: z.string(),
	uploaded: int,
	moved: int,
	deleted: int,
	updated: int,
	merged: int,
	failed: z.array(z.string()),
	failedTotal: int,
	backupDir: z.string().nullable(),
});
export type ApplySummary = z.infer<typeof applySummarySchema>;

/**
 * Runs the confirmed actions of a plan. Overwritten and deleted files are backed up first, and a
 * library file replaced by the destination's copy goes to the Trash. `resolutions` settles merges
 * and conflicts by action id.
 */
export async function syncApply(
	planId: string,
	actionIds: number[],
	resolutions: Record<number, Resolution> = {},
): Promise<ApplySummary[]> {
	return z
		.array(applySummarySchema)
		.parse(await invoke("sync_apply", { planId, actionIds, resolutions }));
}

const remoteFileSchema = z.object({ rel: z.array(z.string()), size: int });
export type RemoteFile = z.infer<typeof remoteFileSchema> & { otherFormat?: string | null };

const missingFileSchema = remoteFileSchema.extend({ otherFormat: z.string().nullable() });
const remoteScanSchema = z.object({ total: int, missing: z.array(missingFileSchema) });

/** Looks inside a destination for audio files the library does not have. */
export async function remoteScan(targetId: number) {
	return remoteScanSchema.parse(await invoke("remote_scan", { targetId }));
}

const verifiedSchema = z.object({
	rel: z.array(z.string()),
	duplicateOf: z.string().nullable(),
	checked: z.boolean(),
});
export type Verified = z.infer<typeof verifiedSchema>;

/** Compares the audio of destination files with the library by content fingerprint. */
export async function remoteVerify(targetId: number, files: string[][]): Promise<Verified[]> {
	return z.array(verifiedSchema).parse(await invoke("remote_verify", { targetId, files }));
}

const pullOutcomeSchema = z.object({
	pulled: int,
	skipped: int,
	failed: z.array(z.string()),
	failedTotal: int,
});
export type PullOutcome = z.infer<typeof pullOutcomeSchema>;

/** Downloads the given files (paths relative to the destination) into the library. */
export async function remotePull(targetId: number, files: string[][]): Promise<PullOutcome> {
	return pullOutcomeSchema.parse(await invoke("remote_pull", { targetId, files }));
}

/** A file or folder on a destination, by path below the destination folder. */
export interface RemoteItem {
	rel: string[];
	isDir: boolean;
}

/** Copies files and folders of a destination into a library folder. Existing files are skipped. */
export async function remoteDownload(
	targetId: number,
	items: RemoteItem[],
	dest: string,
): Promise<PullOutcome> {
	return pullOutcomeSchema.parse(await invoke("remote_download", { targetId, items, dest }));
}

/** Copies library files and folders to a destination folder. Existing files are skipped. */
export async function remoteUpload(
	targetId: number,
	paths: string[],
	dest: string[],
): Promise<PullOutcome> {
	return pullOutcomeSchema.parse(await invoke("remote_upload", { targetId, paths, dest }));
}

/** Moves files and folders into another folder of the same destination; returns how many moved. */
export async function remoteMove(
	targetId: number,
	items: RemoteItem[],
	dest: string[],
): Promise<number> {
	return int.parse(await invoke("remote_move", { targetId, items, dest }));
}

const pullProgressSchema = z.object({ done: int, total: int, current: z.string() });
export type PullProgress = z.infer<typeof pullProgressSchema>;

export function onPullProgress(handler: (p: PullProgress) => void): Promise<() => void> {
	return listen("pull-progress", (e) => {
		const parsed = pullProgressSchema.safeParse(e.payload);
		if (parsed.success) {
			handler(parsed.data);
		}
	});
}

export type ServiceId = "downloads" | "itunes" | "tailscale" | "r2" | "rekordbox" | "usb";

/** Explicit on/off choices by service id; a service never switched is absent. */
export async function serviceFlags(): Promise<Record<string, string>> {
	return Object.fromEntries(
		z.array(z.tuple([z.string(), z.string()])).parse(await invoke("service_flags")),
	);
}

export async function setServiceEnabled(id: ServiceId, enabled: boolean): Promise<void> {
	await invoke("set_service_enabled", { id, enabled });
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

const rekordboxLibrarySchema = z
	.object({
		tracks: int,
		playlists: z.array(
			z.object({
				folders: z.array(z.string()),
				name: z.string(),
				tracks: z.array(z.object({ title: z.string(), artist: z.string() })),
			}),
		),
	})
	.nullable();

export type RekordboxLibrary = NonNullable<z.infer<typeof rekordboxLibrarySchema>>;

/** What the exported rekordbox file holds right now; null before it has been written. */
export async function rekordboxLibrary(): Promise<RekordboxLibrary | null> {
	return rekordboxLibrarySchema.parse(await invoke("rekordbox_library"));
}

const exportSelectionSchema = z.object({
	/** Library playlists, by id. */
	playlists: z.array(int),
	/** Tags exported as playlists (a tag includes the songs of the tags below it). */
	tags: z.array(z.string()),
	/** Smart playlists, by id. */
	smart: z.array(int).default([]),
	/** USB drives: what happens to the playlists and songs already there. */
	usbMode: z.enum(["add", "replacePlaylists", "replaceAll"]).default("add"),
});

export type UsbMode = ExportSelection["usbMode"];

/** What a destination gets; saved each time it is exported to, so it is what it holds. */
export type ExportSelection = z.infer<typeof exportSelectionSchema>;

export async function rekordboxSelection(): Promise<ExportSelection> {
	return exportSelectionSchema.parse(await invoke("rekordbox_selection"));
}

/** Saves what goes into the rekordbox file and writes it. */
export async function setRekordboxSelection(selection: ExportSelection): Promise<ExportSelection> {
	return exportSelectionSchema.parse(await invoke("rekordbox_set_selection", { selection }));
}

// ---- smart playlists -----------------------------------------------------

const addedRuleSchema = z.discriminatedUnion("kind", [
	/** On or after this day (unix seconds of its start). */
	z.object({ kind: z.literal("after"), date: int }),
	/** Before this day (unix seconds of its start). */
	z.object({ kind: z.literal("before"), date: int }),
	/** In the last `amount` units, counted back from each export. */
	z.object({
		kind: z.literal("within"),
		amount: int,
		unit: z.enum(["days", "weeks", "months"]),
	}),
]);

export type AddedRule = z.infer<typeof addedRuleSchema>;

const smartRulesSchema = z.object({
	allTags: z.array(z.string()).default([]),
	anyTags: z.array(z.string()).default([]),
	noneTags: z.array(z.string()).default([]),
	added: addedRuleSchema.nullable().default(null),
	bpmMin: z.number().nullable().default(null),
	bpmMax: z.number().nullable().default(null),
});

/** What a song needs to be in a smart playlist; parts left empty are ignored. */
export type SmartRules = z.infer<typeof smartRulesSchema>;

const smartPlaylistSchema = z.object({
	id: int,
	name: z.string(),
	rules: smartRulesSchema,
	...sharingFields,
});

/** A rule-based playlist that belongs to one export destination, never to the library. */
export type SmartPlaylist = z.infer<typeof smartPlaylistSchema>;

export async function smartPlaylists(): Promise<SmartPlaylist[]> {
	return z.array(smartPlaylistSchema).parse(await invoke("smart_playlists"));
}

/** Adds (id 0) or changes a smart playlist. Only its rules are kept; its songs stay live. */
export async function saveSmartPlaylist(playlist: SmartPlaylist): Promise<SmartPlaylist> {
	return smartPlaylistSchema.parse(await invoke("smart_playlist_save", { playlist }));
}

export async function deleteSmartPlaylist(id: number): Promise<void> {
	await invoke("smart_playlist_delete", { id });
}

// ---- sharing: clashes, share, make private, hide ----------------------------

/** What an item is: how the backend names the three kinds that can be shared. */
export type ItemKind = "tag" | "playlist" | "smart_playlist";

const localTagUseSchema = z.object({ id: int, tag: z.string(), songs: int });

/** A local tag that a shared smart playlist would use. */
export type LocalTagUse = z.infer<typeof localTagUseSchema>;

export type TagChoice = "share" | "remove";

const sharePreviewSchema = z.object({
	name: z.string(),
	songs: int,
	localTags: z.array(localTagUseSchema),
});

export type SharePreview = z.infer<typeof sharePreviewSchema>;

/** What sharing a local item would send; nothing leaves the device before the user confirms. */
export async function sharePreview(kind: ItemKind, id: number): Promise<SharePreview> {
	return sharePreviewSchema.parse(await invoke("share_preview", { kind, id }));
}

/** Makes a local item shared. `tags` says what to do with each local tag a smart playlist uses. */
export async function shareItem(
	kind: ItemKind,
	id: number,
	tags: Record<string, TagChoice> = {},
): Promise<void> {
	await invoke("share_item", { kind, id, tags });
}

const privatePreviewSchema = z.object({ name: z.string(), usedBy: z.array(z.string()) });

export type PrivatePreview = z.infer<typeof privatePreviewSchema>;

export async function privatePreview(kind: ItemKind, id: number): Promise<PrivatePreview> {
	return privatePreviewSchema.parse(await invoke("private_preview", { kind, id }));
}

/** Everyone else loses the item; this device keeps a local copy. */
export async function makePrivate(kind: ItemKind, id: number, removeRules: boolean): Promise<void> {
	await invoke("make_private", { kind, id, removeRules });
}

export async function setItemHidden(kind: ItemKind, id: number, hidden: boolean): Promise<void> {
	await invoke("set_item_hidden", { kind, id, hidden });
}

/** Local tags the rules use, for a smart playlist that is shared. */
export async function smartLocalTags(rules: SmartRules): Promise<LocalTagUse[]> {
	return z.array(localTagUseSchema).parse(await invoke("smart_local_tags", { rules }));
}

const clashSideSchema = z.object({
	uid: z.string(),
	id: int,
	scope: scopeSchema,
	name: z.string(),
	songs: int,
});

const clashSchema = z.object({
	id: int,
	kind: z.enum(["tag", "playlist", "smart_playlist"]),
	name: z.string(),
	keeps: clashSideSchema,
	held: clashSideSchema,
});

/** Two items with one name: the one that has the name, and the one shown under a held name. */
export type Clash = z.infer<typeof clashSchema>;

export async function listClashes(): Promise<Clash[]> {
	return z.array(clashSchema).parse(await invoke("list_clashes"));
}

const combinePreviewSchema = z.object({ sharesLocal: z.boolean(), songs: int, name: z.string() });

export type CombinePreview = z.infer<typeof combinePreviewSchema>;

export async function clashCombinePreview(id: number): Promise<CombinePreview> {
	return combinePreviewSchema.parse(await invoke("clash_combine_preview", { id }));
}

export type ClashChoice = "combine" | "renameKeeps" | "renameHeld";

export async function resolveClash(
	id: number,
	choice: ClashChoice,
	newName?: string,
): Promise<void> {
	await invoke("resolve_clash", { id, choice, newName: newName ?? null });
}

const smartPreviewSchema = z.object({
	trackIds: z.array(int),
	durationMs: int,
	bytes: int,
	/** Songs that match everything else but have no added date. */
	undated: int,
});

export type SmartPreview = z.infer<typeof smartPreviewSchema>;

/** The songs a rule set picks right now. */
export async function smartPlaylistPreview(rules: SmartRules): Promise<SmartPreview> {
	return smartPreviewSchema.parse(await invoke("smart_playlist_preview", { rules }));
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
export type ItunesPendingSong = z.infer<typeof itunesReportSchema>["converted"][number];

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

/** Songs in the iTunes folder an import would add. Read-only. */
export async function itunesPending(): Promise<ItunesPendingSong[]> {
	return itunesReportSchema.shape.converted.parse(await invoke("itunes_pending"));
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

const remoteEntrySchema = z.object({
	name: z.string(),
	isDir: z.boolean(),
	size: int.nullable(),
	modified: int.nullable(),
});

/**
 * Lists one folder of a destination (`rel` is relative to the destination folder), folders first,
 * in the same shape as {@link fsList}.
 */
export async function remoteList(targetId: number, rel: string[]): Promise<FsEntry[]> {
	const raw = z.array(remoteEntrySchema).parse(await invoke("remote_list", { targetId, rel }));
	return raw.map((e) => ({ ...e, size: e.size ?? 0 }));
}

const dirSizesSchema = z.record(z.string(), int);

/** Total size of each subfolder of a library folder, by name. Slower than {@link fsList}. */
export async function fsDirSizes(path: string): Promise<Record<string, number>> {
	return dirSizesSchema.parse(await invoke("fs_dir_sizes", { path }));
}

/** Total size of each subfolder of a destination folder, by name. */
export async function remoteDirSizes(
	targetId: number,
	rel: string[],
): Promise<Record<string, number>> {
	return dirSizesSchema.parse(await invoke("remote_dir_sizes", { targetId, rel }));
}

/** Creates a folder and returns its path. */
export async function fsMakeDir(parent: string, name: string): Promise<string> {
	return z.string().parse(await invoke("fs_make_dir", { parent, name }));
}

/** Renames in place and returns the new path. */
export async function fsRename(path: string, newName: string): Promise<string> {
	return z.string().parse(await invoke("fs_rename", { path, newName }));
}

/** Copies into `dest`; a name already taken there gets " copy" added. Returns the new paths. */
export async function fsCopy(paths: string[], dest: string): Promise<string[]> {
	return z.array(z.string()).parse(await invoke("fs_copy", { paths, dest }));
}

/** Shows a file or folder of the library selected in Finder. */
export async function fsReveal(path: string): Promise<void> {
	await invoke("fs_reveal", { path });
}

/** Moves to the system Trash. */
export async function fsTrash(paths: string[]): Promise<void> {
	await invoke("fs_trash", { paths });
}

/** Native yes/no prompt before deleting. */
export function confirmTrash(names: string[]): Promise<boolean> {
	const what = names.length === 1 ? `“${names[0]}”` : `${names.length} items`;
	return ask(`Move ${what} to the ${TRASH}?`, {
		title: "Delete",
		kind: "warning",
		okLabel: `Move to ${TRASH}`,
	});
}

/** Moves files and folders into `dest`. Fails without changing anything on a name clash. */
export async function fsMove(paths: string[], dest: string): Promise<void> {
	await invoke("fs_move", { paths, dest });
}

/** Opens System Settings at Full Disk Access (macOS). */
export async function openPrivacySettings(): Promise<void> {
	await invoke("open_privacy_settings");
}

// ---- library health -------------------------------------------------------

const auditIssueSchema = z.object({
	path: z.string(),
	kind: z.enum(["notMp3", "tagVersion", "misplaced"]),
	message: z.string(),
	fixable: z.boolean(),
	/** Set when the user can fix it by typing the missing artist and/or album. */
	place: z.object({ artist: z.string().nullable(), album: z.string().nullable() }).nullable(),
});

export type AuditIssue = z.infer<typeof auditIssueSchema>;

const fixReportSchema = z.object({
	fixed: int,
	failed: z.array(z.object({ path: z.string(), error: z.string() })),
});

export type FixReport = z.infer<typeof fixReportSchema>;

/** Files that break the library conventions (MP3 only, ID3v2.3, Artist/Album layout). */
export async function auditLibrary(): Promise<AuditIssue[]> {
	return z.array(auditIssueSchema).parse(await invoke("audit_library"));
}

/** Files one song under an artist and album the user typed, creating the folders. */
export async function auditPlace(path: string, artist: string, album: string): Promise<void> {
	await invoke("audit_place", { path, artist, album });
}

/** Fixes each file; one failing file never stops or undoes the others. */
export async function auditFix(paths: string[]): Promise<FixReport> {
	return fixReportSchema.parse(await invoke("audit_fix", { paths }));
}

/** Native yes/no prompt listing what a fix will do. */
export function confirmFix(lines: string[]): Promise<boolean> {
	return ask(lines.join("\n"), {
		title: "Fix library issues",
		kind: "info",
		okLabel: "Fix",
	});
}

// ---- tag editor --------------------------------------------------------------

/** Adds a value to a tag field's pick list before any song uses it. */
export async function tagValueCreate(field: string, value: string): Promise<void> {
	await invoke("tag_value_create", { field, value });
}

/** Rewrites every song holding a value in `from` to hold `to` instead; `null` removes it. */
export async function tagValuesMigrate(
	field: string,
	from: string[],
	to: string | null,
): Promise<FixReport> {
	return fixReportSchema.parse(await invoke("tag_values_migrate", { field, from, to }));
}

const tagViewSchema = z.object({
	count: int,
	fields: z.record(z.string(), z.object({ value: z.string().nullable(), mixed: z.boolean() })),
});

export type TagView = z.infer<typeof tagViewSchema>;

/** A song or folder, or several of them (e.g. every song of an album). */
export type TagPaths = string | readonly string[];

const asPaths = (p: TagPaths): string[] => (typeof p === "string" ? [p] : [...p]);

/** Tags shared by every song at or under `path` (songs and/or folders). */
export async function tagsRead(path: TagPaths): Promise<TagView> {
	return tagViewSchema.parse(await invoke("tags_read", { paths: asPaths(path) }));
}

/** Writes `edits` (field to value; empty clears) to every song at or under `path`. */
export async function tagsWrite(path: TagPaths, edits: Record<string, string>): Promise<FixReport> {
	return fixReportSchema.parse(await invoke("tags_write", { paths: asPaths(path), edits }));
}

/** Writes different edits to several songs at once (one rescan). */
export async function tagsWriteMany(
	items: { path: string; edits: Record<string, string> }[],
): Promise<FixReport> {
	return fixReportSchema.parse(await invoke("tags_write_many", { items }));
}

/** Sets the front cover of every song at or under `path`, from JPEG/PNG bytes. */
export async function tagsSetCover(path: TagPaths, image: Uint8Array): Promise<FixReport> {
	return fixReportSchema.parse(
		await invoke("tags_set_cover", image, {
			headers: { "x-paths": encodeURIComponent(JSON.stringify(asPaths(path))) },
		}),
	);
}

const tagValuesSchema = z.array(z.object({ value: z.string(), count: int }));

export type TagValue = z.infer<typeof tagValuesSchema>[number];

/** Values already used in the library for a tag field, most used first. */
export async function tagValues(field: string): Promise<TagValue[]> {
	return tagValuesSchema.parse(await invoke("tag_values", { field }));
}

const previewSchema = z.object({
	total: int,
	files: z.array(
		z.object({
			path: z.string(),
			changes: z.array(
				z.object({ field: z.string(), from: z.string().nullable(), to: z.string().nullable() }),
			),
		}),
	),
});

export type TagPreview = z.infer<typeof previewSchema>;

/** What a tag edit would change in each song, without writing anything. */
export async function tagsPreview(
	path: TagPaths,
	edits: Record<string, string>,
): Promise<TagPreview> {
	return previewSchema.parse(await invoke("tags_preview", { paths: asPaths(path), edits }));
}

const libraryViewSchema = z.enum(["albums", "songs", "artists"]);
export type LibraryView = z.infer<typeof libraryViewSchema>;

/** Library tab last used; kept in the database so it is open again after leaving Library. */
export async function getLibraryView(): Promise<LibraryView> {
	const raw = z
		.string()
		.nullable()
		.parse(await invoke("get_library_view"));
	const parsed = libraryViewSchema.safeParse(raw);
	return parsed.success ? parsed.data : "albums";
}

export async function setLibraryView(view: LibraryView): Promise<void> {
	await invoke("set_library_view", { view });
}

const panelTabsSchema = z.object({
	song: z.enum(["grid", "metadata"]).catch("grid"),
	album: z.enum(["songs", "metadata"]).catch("songs"),
});
export type PanelTabs = z.infer<typeof panelTabsSchema>;
export const DEFAULT_PANEL_TABS: PanelTabs = { song: "grid", album: "songs" };

/** Tabs last picked in the song and album views; kept in the database. */
export async function getPanelTabs(): Promise<PanelTabs> {
	const raw = z
		.string()
		.nullable()
		.parse(await invoke("get_panel_tabs"));
	try {
		const parsed = panelTabsSchema.safeParse(raw === null ? {} : JSON.parse(raw));
		return parsed.success ? parsed.data : DEFAULT_PANEL_TABS;
	} catch {
		return DEFAULT_PANEL_TABS;
	}
}

export async function setPanelTabs(tabs: PanelTabs): Promise<void> {
	await invoke("set_panel_tabs", { tabs: JSON.stringify(tabs) });
}

/** A display preference (e.g. how a list is sorted), kept in the database as JSON. */
export async function getUiSetting(name: string): Promise<unknown> {
	const raw = z
		.string()
		.nullable()
		.parse(await invoke("get_ui_setting", { name }));
	try {
		return raw === null ? null : JSON.parse(raw);
	} catch {
		return null;
	}
}

export async function setUiSetting(name: string, value: unknown): Promise<void> {
	await invoke("set_ui_setting", { name, value: JSON.stringify(value) });
}

const tagClipboardSchema = z.object({
	from: z.string(),
	values: z.record(z.string(), z.string()),
});

export type TagClipboard = z.infer<typeof tagClipboardSchema>;

/** Tags copied in the Files view; kept in the database so they survive switching views. */
export async function getTagClipboard(): Promise<TagClipboard | null> {
	const raw = z
		.string()
		.nullable()
		.parse(await invoke("get_tag_clipboard"));
	if (raw === null) {
		return null;
	}
	const parsed = tagClipboardSchema.safeParse(JSON.parse(raw));
	return parsed.success ? parsed.data : null;
}

export async function setTagClipboard(clip: TagClipboard | null): Promise<void> {
	await invoke("set_tag_clipboard", { json: clip === null ? null : JSON.stringify(clip) });
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
	status: z.enum(["new", "inLibrary", "duplicate", "sameAudio"]),
	/** For "sameAudio": the library song whose audio this file holds. */
	sameAs: z.string().nullish(),
	album: z.string().nullish(),
	track: int.nullish(),
	disc: int.nullish(),
	year: z.string().nullish(),
	genre: z.string().nullish(),
	label: z.string().nullish(),
	bpm: z.string().nullish(),
	key: z.string().nullish(),
	durationMs: int.nullish(),
	/** kbps. */
	bitrate: int.nullish(),
	sampleRate: int.nullish(),
	/** The file carries its own cover picture. */
	hasArt: z.boolean().default(false),
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

/** Moves files, zips or folders inside the Downloads folder to the Trash. */
export async function importTrash(paths: string[]): Promise<void> {
	await invoke("import_trash", { paths });
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
	phase: z.enum(["listing", "library", "checking", "tags"]),
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

// ---- CDJ USB drives ---------------------------------------------------------

const usbDriveSchema = z.object({
	/** Stays the same when the drive is renamed or plugged in again. */
	id: z.string(),
	name: z.string(),
	mount: z.string(),
	filesystem: z.string(),
	totalBytes: int,
	freeBytes: int,
	writable: z.boolean(),
	/** Has a rekordbox Device Library (`PIONEER/rekordbox/export.pdb`). */
	hasLibrary: z.boolean(),
	/** Also has rekordbox's newer OneLibrary database, read by CDJ-3000X, Opus Quad, XDJ-AZ. */
	hasOneLibrary: z.boolean(),
});

export type UsbDrive = z.infer<typeof usbDriveSchema>;

const usbTrackSchema = z.object({
	id: int,
	title: z.string(),
	artist: z.string(),
	album: z.string(),
	genre: z.string(),
	key: z.string(),
	comment: z.string(),
	/** Relative to the drive root, e.g. "/Contents/Artist/Album/song.mp3". */
	path: z.string(),
	analyzePath: z.string(),
	dateAdded: z.string(),
	durationSecs: int,
	/** BPM × 100; 0 when unknown. */
	tempo: int,
	bitrate: int,
	sampleRate: int,
	fileSize: int,
	year: int,
	trackNumber: int,
	fileType: int,
	artworkId: int,
});

export type UsbTrack = z.infer<typeof usbTrackSchema>;

const usbPlaylistSchema = z.object({
	id: int,
	/** 0 at the top level. */
	parentId: int,
	name: z.string(),
	isFolder: z.boolean(),
	sortOrder: int,
	trackIds: z.array(int),
});

export type UsbPlaylist = z.infer<typeof usbPlaylistSchema>;

const usbLibrarySchema = z.object({
	tracks: z.array(usbTrackSchema),
	playlists: z.array(usbPlaylistSchema),
	artwork: z.array(z.tuple([int, z.string()])),
});

export type UsbLibrary = z.infer<typeof usbLibrarySchema>;

export async function usbDrives(): Promise<UsbDrive[]> {
	return z.array(usbDriveSchema).parse(await invoke("usb_drives"));
}

export async function usbLibrary(mount: string): Promise<UsbLibrary> {
	return usbLibrarySchema.parse(await invoke("usb_library", { mount }));
}

/** A change to the playlists on a drive. Positions are 0-based places in the playlist. */
export type UsbEdit =
	| { kind: "rename"; id: number; name: string }
	| { kind: "delete"; id: number }
	| { kind: "create"; parentId: number; name: string; folder: boolean }
	| { kind: "move"; id: number; parentId: number }
	| { kind: "removeTracks"; playlistId: number; positions: number[] };

const usbEditOutcomeSchema = z.object({
	library: usbLibrarySchema,
	/** The new playlist or folder, for a "create". */
	created: int.nullable(),
});

export type UsbEditOutcome = z.infer<typeof usbEditOutcomeSchema>;

/**
 * Moves the drive's rekordbox libraries, analysis files, artwork and exported songs to its
 * Trash. Returns how many folders moved.
 */
export async function usbReset(mount: string): Promise<number> {
	return int.parse(await invoke("usb_reset", { mount }));
}

/** Unmounts the drive so it can be unplugged. */
export async function usbEject(mount: string): Promise<void> {
	await invoke("usb_eject", { mount });
}

/** Opens the drive in Finder. */
export async function usbReveal(mount: string): Promise<void> {
	await invoke("usb_reveal", { mount });
}

const usbBackupsSchema = z.object({
	count: int,
	bytes: int,
	/** Folder name of the newest backup, e.g. "2026-11-15-221530". */
	latest: z.string().nullable(),
});

export type UsbBackups = z.infer<typeof usbBackupsSchema>;

/** Copies of earlier libraries manplay kept on the drive (in `PIONEER/manplay-backup`). */
export async function usbBackups(mount: string): Promise<UsbBackups> {
	return usbBackupsSchema.parse(await invoke("usb_backups", { mount }));
}

/** Deletes all but the newest `keep` library backups; returns what is left. */
export async function usbDeleteBackups(mount: string, keep: number): Promise<UsbBackups> {
	return usbBackupsSchema.parse(await invoke("usb_delete_backups", { mount, keep }));
}

/** Edits the drive's rekordbox playlists and returns its library as it is now. */
export async function usbEditPlaylists(mount: string, edit: UsbEdit): Promise<UsbEditOutcome> {
	return usbEditOutcomeSchema.parse(await invoke("usb_edit_playlists", { mount, edit }));
}

const usbLibrarySummarySchema = z.object({ tracks: int, playlists: int });

const usbFormatsSchema = z.object({
	/** `export.pdb`, read by the CDJ-3000 and older players. */
	deviceLibrary: usbLibrarySummarySchema.nullable(),
	/** `exportLibrary.db`, read by the CDJ-3000X, Opus Quad, XDJ-AZ and Omnis Duo. */
	oneLibrary: usbLibrarySummarySchema.nullable(),
	deviceLibraryError: z.string().nullable(),
	oneLibraryError: z.string().nullable(),
});

export type UsbFormats = z.infer<typeof usbFormatsSchema>;
export type UsbLibrarySummary = z.infer<typeof usbLibrarySummarySchema>;

/** Which rekordbox library formats a drive holds, with their sizes. */
export async function usbFormats(mount: string): Promise<UsbFormats> {
	return usbFormatsSchema.parse(await invoke("usb_formats", { mount }));
}

const usbExportProgressSchema = z.object({
	phase: z.enum(["copying", "analyzing", "writing"]),
	done: int,
	total: int,
	current: z.string(),
});

export type UsbExportProgress = z.infer<typeof usbExportProgressSchema>;

const usbExportReportSchema = z.object({
	copied: int,
	alreadyThere: int,
	bytesCopied: int,
	/** Songs given a beat grid and waveform. */
	analyzed: int,
	/** Songs already on the drive whose edited beat grid was written again. */
	regridded: int.default(0),
	playlists: int,
	/** Playlists and folders taken off the drive because they were not exported. */
	playlistsRemoved: int.default(0),
	/** Songs deleted because no playlist on the drive held them any more. */
	songsDeleted: int.default(0),
	bytesFreed: int.default(0),
	libraryTracks: int,
	/** Folder on the drive with copies of both previous databases. */
	backup: z.string().nullable(),
	/** Whether the OneLibrary (`exportLibrary.db`) was written alongside `export.pdb`. */
	oneLibrary: z.boolean(),
	/** Why it was not; the drive's old OneLibrary was then removed. */
	oneLibraryError: z.string().nullable(),
	failed: z.array(fileFailureSchema),
});

export type UsbExportReport = z.infer<typeof usbExportReportSchema>;

/**
 * Copies playlists and their songs onto a drive and rewrites its rekordbox library. Each tag in
 * `tagNames` becomes a top-level playlist of the songs tagged with it or anything below it.
 */
/** What was last exported to a drive; null before its first export. */
export async function usbExportSelection(driveId: string): Promise<ExportSelection | null> {
	return exportSelectionSchema.nullable().parse(await invoke("usb_export_selection", { driveId }));
}

export async function exportToUsb(
	mount: string,
	selection: ExportSelection,
): Promise<UsbExportReport> {
	return usbExportReportSchema.parse(await invoke("export_to_usb", { mount, selection }));
}

const songRefSchema = z.object({
	title: z.string(),
	artist: z.string(),
	album: z.string().default(""),
	bpm: z.number().nullable().default(null),
	key: z.string().nullable().default(null),
	durationSecs: int.nullable().default(null),
	/** The library song, when there is one (for its artwork). */
	trackId: int.nullable().default(null),
	/** The file on the drive, for a song only the drive has. */
	file: z.string().nullable().default(null),
});

export type SongRef = z.infer<typeof songRefSchema>;

const usbDiffSchema = z.object({
	playlists: z.array(
		z.object({
			name: z.string(),
			change: z.enum(["added", "updated", "unchanged", "removed"]),
			/** Songs in it afterwards (before, for a removed one). */
			songs: int,
			added: z.array(songRefSchema),
			removed: z.array(songRefSchema),
			/** Every song in it afterwards, in order (before, for a removed one). */
			tracks: z.array(songRefSchema).default([]),
		}),
	),
	/** Songs new to the drive. */
	copy: z.array(songRefSchema),
	copyBytes: int,
	/** Songs deleted from the drive. */
	delete: z.array(songRefSchema),
	deleteBytes: int,
});

/** What an export would change on a drive, worked out without writing. */
export type UsbDiff = z.infer<typeof usbDiffSchema>;

export async function usbExportPreview(
	mount: string,
	selection: ExportSelection,
): Promise<UsbDiff> {
	return usbDiffSchema.parse(await invoke("usb_export_preview", { mount, selection }));
}

export function onUsbExportProgress(handler: (p: UsbExportProgress) => void): Promise<() => void> {
	return listen("usb-export-progress", (e) => {
		const parsed = usbExportProgressSchema.safeParse(e.payload);
		if (parsed.success) {
			handler(parsed.data);
		}
	});
}

// ---- beat grid and waveform ------------------------------------------------------------

const trackAnalysisSchema = z.object({
	gridBpm: z.number().nullable(),
	/** Seconds. */
	firstBeat: z.number(),
	/** Position in the bar of the first beat (0 = downbeat). */
	barOffset: int,
	duration: z.number(),
	/** Columns per second of `detail`. */
	rate: z.number(),
	/** Each column: whiteness (0–7) << 5 | height (0–31), as on a CDJ. */
	detail: z.array(int),
});

export type TrackAnalysis = z.infer<typeof trackAnalysisSchema>;

/** Saves an edited beat grid; the track's BPM follows it. Returns the analysis as kept now. */
export async function setBeatGrid(
	trackId: number,
	grid: { bpm: number | null; firstBeat: number; barOffset: number },
): Promise<TrackAnalysis | null> {
	return trackAnalysisSchema.nullable().parse(
		await invoke("set_beat_grid", {
			trackId,
			gridBpm: grid.bpm,
			firstBeat: grid.firstBeat,
			barOffset: grid.barOffset,
		}),
	);
}

const cueSchema = z.object({
	/** 0–7 for hot cues A–H, null for a memory cue. */
	slot: int.nullable(),
	start: z.number(),
	name: z.string(),
	color: z.string(),
	/** The memory cue the song starts from (rekordbox's main cue on load). */
	main: z.boolean().default(false),
});

/** Cues set in manplay for a song; they go into the rekordbox file and onto USB drives. */
export async function trackCues(trackId: number): Promise<z.infer<typeof cueSchema>[]> {
	return z.array(cueSchema).parse(await invoke("track_cues", { trackId }));
}

export async function setTrackCues(
	trackId: number,
	cues: readonly z.infer<typeof cueSchema>[],
): Promise<void> {
	await invoke("set_track_cues", { trackId, cues });
}

/** The kept beat grid and waveform of a track; null until it has been analysed. */
export async function trackAnalysis(trackId: number): Promise<TrackAnalysis | null> {
	return trackAnalysisSchema.nullable().parse(await invoke("track_analysis", { trackId }));
}
