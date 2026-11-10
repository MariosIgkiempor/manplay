import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { z } from "zod";

const trackSchema = z.object({
	id: z.number().int(),
	path: z.string(),
	artist: z.string(),
	album: z.string(),
	title: z.string(),
	size: z.number().int(),
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
