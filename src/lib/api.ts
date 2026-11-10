import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
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

/** URL of the album artwork thumbnail for a track (404s when there is none). */
export function artUrl(trackId: number): string {
	return convertFileSrc(String(trackId), "art");
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
