import { albumKey } from "#/lib/albums.ts";
import type { Track } from "#/lib/api.ts";
import { splitNames } from "#/lib/names.ts";

export interface Artist {
	/** Credited name; empty for songs with no artist. */
	name: string;
	tracks: Track[];
	albumCount: number;
	/** Any track of the artist; used to look up its artwork. */
	coverTrackId: number;
}

/**
 * Groups songs by credited artist. A song credited to `A; B` counts for both, the same way the
 * artist page lists it. Songs with no artist are grouped last as one unnamed artist.
 */
export function groupArtists(tracks: readonly Track[]): Artist[] {
	const map = new Map<string, { tracks: Track[]; albums: Set<string> }>();
	for (const t of tracks) {
		const names = splitNames(t.artist);
		for (const name of names.length > 0 ? names : [""]) {
			const entry = map.get(name) ?? { tracks: [], albums: new Set<string>() };
			entry.tracks.push(t);
			entry.albums.add(albumKey(t.artist, t.album));
			map.set(name, entry);
		}
	}
	return [...map.entries()]
		.map(([name, { tracks: list, albums }]) => ({
			name,
			tracks: list,
			albumCount: albums.size,
			coverTrackId: list[0]?.id ?? 0,
		}))
		.sort((a, b) => Number(a.name === "") - Number(b.name === "") || a.name.localeCompare(b.name));
}
