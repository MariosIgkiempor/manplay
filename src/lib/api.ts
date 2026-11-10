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
