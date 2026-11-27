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
		const key = albumKey(t.artist, t.album);
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

export function albumKey(artist: string, album: string): string {
	return `${artist}\u0000${album}`;
}

/** The album `track` is on with every song of it, when it has others: what a cover picked for the
 * song can go to as well. `undefined` for a song with no album or alone on it. */
export function albumOfSong(
	track: Pick<Track, "artist" | "album">,
	all: readonly Pick<Track, "artist" | "album" | "path">[],
): { name: string; paths: string[] } | undefined {
	if (track.album === "") {
		return undefined;
	}
	const key = albumKey(track.artist, track.album);
	const paths = all.filter((t) => albumKey(t.artist, t.album) === key).map((t) => t.path);
	return paths.length > 1 ? { name: track.album, paths } : undefined;
}
