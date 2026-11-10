import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { z } from "zod";

const trackSchema = z.object({
	id: z.number().int(),
	path: z.string(),
	artist: z.string(),
	album: z.string(),
	title: z.string(),
	size: z.number().int(),
	tags: z.array(z.string()),
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
	return z
		.number()
		.int()
		.parse(await invoke("scan_library", { root }));
}

const playlistSchema = z.object({
	id: z.number().int(),
	name: z.string(),
	trackCount: z.number().int(),
});

export type Playlist = z.infer<typeof playlistSchema>;

export async function listPlaylists(): Promise<Playlist[]> {
	return z.array(playlistSchema).parse(await invoke("list_playlists"));
}

export async function createPlaylist(name: string): Promise<number> {
	return z
		.number()
		.int()
		.parse(await invoke("create_playlist", { name }));
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

const tagSchema = z.object({
	id: z.number().int(),
	name: z.string(),
	trackCount: z.number().int(),
});

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

const machineSchema = z.object({
	name: z.string(),
	hostName: z.string(),
	os: z.string(),
	online: z.boolean(),
	isSelf: z.boolean(),
});

const statusSchema = z.object({
	tailnet: z.string(),
	machines: z.array(machineSchema),
});

export type Machine = z.infer<typeof machineSchema>;

export async function tailscaleStatus() {
	return statusSchema.parse(await invoke("tailscale_status"));
}

const entrySchema = z.object({ name: z.string(), isDir: z.boolean() });

export async function driveList(tailnet: string, machine: string, path: string[]) {
	return z.array(entrySchema).parse(await invoke("drive_list", { tailnet, machine, path }));
}

const targetSchema = z.object({
	tailnet: z.string(),
	machine: z.string(),
	path: z.array(z.string()),
});

export type SyncTarget = z.infer<typeof targetSchema>;

export async function getSyncTarget(): Promise<SyncTarget | null> {
	return targetSchema.nullable().parse(await invoke("get_sync_target"));
}

export async function setSyncTarget(target: SyncTarget | null): Promise<void> {
	await invoke("set_sync_target", { target });
}

const summarySchema = z.object({
	uploaded: z.number().int(),
	skipped: z.number().int(),
	failed: z.array(z.string()),
});

export type SyncSummary = z.infer<typeof summarySchema>;

export async function syncNow(): Promise<SyncSummary> {
	return summarySchema.parse(await invoke("sync_now"));
}

const progressSchema = z.object({
	done: z.number().int(),
	total: z.number().int(),
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
