import type { Track } from "#/lib/api.ts";

export interface Album {
	key: string;
	artist: string;
	album: string;
	tracks: Track[];
	/** Any track of the album; used to look up its artwork. */
	coverTrackId: number;
}

export function groupAlbums(tracks: readonly Track[]): Album[] {
	const map = new Map<string, Album>();
	for (const t of tracks) {
		const key = `${t.artist}\u0000${t.album}`;
		const existing = map.get(key);
		if (existing) {
			existing.tracks.push(t);
		} else {
			map.set(key, { key, artist: t.artist, album: t.album, tracks: [t], coverTrackId: t.id });
		}
	}
	return [...map.values()].sort(
		(a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album),
	);
}

export type SyncState = "none" | "synced" | "partial" | "pending";

/** Sync state of a set of tracks against `targetCount` destinations. */
export function syncState(tracks: readonly Track[], targetCount: number): SyncState {
	if (targetCount === 0 || tracks.length === 0) {
		return "none";
	}
	const full = tracks.filter((t) => t.syncedCount >= targetCount).length;
	if (full === tracks.length) {
		return "synced";
	}
	const any = tracks.some((t) => t.syncedCount > 0);
	return any ? "partial" : "pending";
}
