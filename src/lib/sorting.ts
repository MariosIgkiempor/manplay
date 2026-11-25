import type { Album } from "#/lib/albums.ts";
import type { Track } from "#/lib/api.ts";
import type { Artist } from "#/lib/artists.ts";
import { compareText } from "#/lib/compare-text.ts";
import { type SortKey, sortTracks } from "#/lib/track-fields.ts";

/** One way a list can be ordered, with the direction it starts in and what each direction reads as. */
export interface SortOption<K extends string> {
	key: K;
	label: string;
	/** Start descending (newest, longest, most first). */
	desc?: boolean;
	/** What ascending and descending mean here, e.g. ["A to Z", "Z to A"]. */
	directions: readonly [string, string];
}

export interface ListSort<K extends string> {
	key: K;
	desc: boolean;
}

const AZ = ["A to Z", "Z to A"] as const;
const NEWEST = ["Oldest first", "Newest first"] as const;
const LOW = ["Lowest first", "Highest first"] as const;
const FEW = ["Fewest first", "Most first"] as const;

/** "list" keeps the order the list comes in (album order, playlist order). */
export type SongSort = SortKey | "list";

export const SONG_SORTS: readonly SortOption<SongSort>[] = [
	{ key: "title", label: "Title", directions: AZ },
	{ key: "artist", label: "Artist", directions: AZ },
	{ key: "album", label: "Album", directions: AZ },
	{ key: "added", label: "Date added", desc: true, directions: NEWEST },
	{ key: "bpm", label: "BPM", directions: LOW },
	{ key: "key", label: "Key", directions: ["1A to 12B", "12B to 1A"] },
	{ key: "duration", label: "Length", directions: ["Shortest first", "Longest first"] },
];

export type AlbumSort = "artist" | "title" | "added" | "year" | "songs";

export const ALBUM_SORTS: readonly SortOption<AlbumSort>[] = [
	{ key: "artist", label: "Artist", directions: AZ },
	{ key: "title", label: "Title", directions: AZ },
	{ key: "added", label: "Date added", desc: true, directions: NEWEST },
	{ key: "year", label: "Year", desc: true, directions: NEWEST },
	{ key: "songs", label: "Number of songs", desc: true, directions: FEW },
];

export type ArtistSort = "name" | "added" | "songs" | "albums";

export const ARTIST_SORTS: readonly SortOption<ArtistSort>[] = [
	{ key: "name", label: "Name", directions: AZ },
	{ key: "added", label: "Date added", desc: true, directions: NEWEST },
	{ key: "songs", label: "Number of songs", desc: true, directions: FEW },
	{ key: "albums", label: "Number of albums", desc: true, directions: FEW },
];

export type ValueSort = "name" | "songs";

/** Orders for the values of one tag field on the Metadata screen. */
export const VALUE_SORTS: readonly SortOption<ValueSort>[] = [
	{ key: "name", label: "Name", directions: AZ },
	{ key: "songs", label: "Number of songs", desc: true, directions: FEW },
];

const text = compareText;

/** When the newest of these songs came in, as a number that orders like `addedOrder`. */
function newest(tracks: readonly Track[]): number {
	let best = 0;
	for (const t of tracks) {
		// Unknown dates order by id below any real date, as with single songs.
		best = Math.max(best, t.addedAt ?? t.id / 1e9);
	}
	return best;
}

const YEAR = "year";

function year(album: Album): number | null {
	for (const t of album.tracks) {
		const y = Number.parseInt(t.fields[YEAR] ?? "", 10);
		if (Number.isFinite(y)) {
			return y;
		}
	}
	return null;
}

/** Orders by `by`, flipped when descending; ties fall back to `tie`, always ascending. */
function ordered<T>(
	items: readonly T[],
	desc: boolean,
	by: (a: T, b: T) => number,
	tie: (a: T, b: T) => number = () => 0,
): T[] {
	return [...items].sort((a, b) => (desc ? -by(a, b) : by(a, b)) || tie(a, b));
}

export function sortAlbums(albums: readonly Album[], sort: ListSort<AlbumSort>): Album[] {
	const byName = (a: Album, b: Album) => text(a.artist, b.artist) || text(a.album, b.album);
	switch (sort.key) {
		case "artist":
			return ordered(albums, sort.desc, byName);
		case "title":
			return ordered(
				albums,
				sort.desc,
				(a, b) => text(a.album, b.album) || text(a.artist, b.artist),
			);
		case "added":
			return ordered(albums, sort.desc, (a, b) => newest(a.tracks) - newest(b.tracks), byName);
		case "songs":
			return ordered(albums, sort.desc, (a, b) => a.tracks.length - b.tracks.length, byName);
		case "year": {
			const known = albums.filter((a) => year(a) !== null);
			const unknown = albums.filter((a) => year(a) === null);
			return [
				...ordered(known, sort.desc, (a, b) => (year(a) ?? 0) - (year(b) ?? 0), byName),
				...ordered(unknown, false, byName),
			];
		}
	}
}

export function sortArtists(artists: readonly Artist[], sort: ListSort<ArtistSort>): Artist[] {
	const byName = (a: Artist, b: Artist) =>
		Number(a.name === "") - Number(b.name === "") || text(a.name, b.name);
	switch (sort.key) {
		case "name":
			return ordered(artists, sort.desc, byName);
		case "added":
			return ordered(artists, sort.desc, (a, b) => newest(a.tracks) - newest(b.tracks), byName);
		case "songs":
			return ordered(artists, sort.desc, (a, b) => a.tracks.length - b.tracks.length, byName);
		case "albums":
			return ordered(artists, sort.desc, (a, b) => a.albumCount - b.albumCount, byName);
	}
}

/** The songs in `sort` order; "list" keeps (or reverses) the order they came in. */
export function sortSongs(tracks: readonly Track[], sort: ListSort<SongSort>): readonly Track[] {
	if (sort.key === "list") {
		return sort.desc ? [...tracks].reverse() : tracks;
	}
	return sortTracks(tracks, { key: sort.key, desc: sort.desc });
}

/** The sorts a song list offers, with its own order first when it has one. */
export function songSortOptions(listOrder: string | undefined): readonly SortOption<SongSort>[] {
	return listOrder
		? [
				{ key: "list", label: listOrder, directions: ["First to last", "Last to first"] },
				...SONG_SORTS,
			]
		: SONG_SORTS;
}
