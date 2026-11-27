import type { Track } from "#/lib/api.ts";
import { compareText } from "#/lib/compare-text.ts";
import { camelot } from "#/lib/musical-key.ts";
import { splitNames } from "#/lib/names.ts";
import { TAG_SEP, trackHasTag } from "#/lib/tag-tree.ts";

/** Fields that hold several names (`A; B`). Matches `MULTI` in `src-tauri/src/tags.rs`. */
const MULTI = new Set(["artist", "albumArtist", "genre", "composer", "remixer"]);

/** A song's raw value of a tag field, or "" when unset. */
export function fieldOf(track: Track, field: string): string {
	return track.fields[field] ?? "";
}

/** The names a song holds in a field: split for list fields, the plain value otherwise. */
export function fieldNames(track: Track, field: string): string[] {
	const raw = fieldOf(track, field).trim();
	if (raw === "") {
		return [];
	}
	return MULTI.has(field) ? splitNames(raw) : [raw];
}

/**
 * Whether a song holds `value` in `field` (case-insensitive). `library` means a library tag
 * (subtags count). An artist also matches the song's display artist, for untagged files.
 */
export function trackHasValue(track: Track, field: string, value: string): boolean {
	if (field === "library") {
		return trackHasTag(track, value);
	}
	const want = value.trim().toLowerCase();
	const names = fieldNames(track, field);
	if (field === "artist" && names.length === 0) {
		names.push(...splitNames(track.artist));
	}
	return names.some((n) => n.toLowerCase() === want);
}

/** The keys a song is filed under in `songsByValue`: what `trackHasValue` would match, lowercased. */
function valueKeys(track: Track, field: string): string[] {
	if (field === "library") {
		// A tag counts for itself and for every tag above it: `a/b/c` files under `a`, `a/b`, `a/b/c`.
		return track.tags.flatMap((tag) => {
			const parts = tag.toLowerCase().split(TAG_SEP);
			return parts.map((_, i) => parts.slice(0, i + 1).join(TAG_SEP));
		});
	}
	const names = fieldNames(track, field);
	if (field === "artist" && names.length === 0) {
		names.push(...splitNames(track.artist));
	}
	return names.map((n) => n.trim().toLowerCase());
}

/**
 * Every value of `field` with the songs that hold it, in library order, keyed by the value in
 * lowercase. One pass over the library, so a list of thousands of values does not search the
 * whole library once per value; `songsWithValue` reads it the way `trackHasValue` matches.
 */
export type SongsByValue = ReadonlyMap<string, readonly Track[]>;

export function songsByValue(tracks: readonly Track[], field: string): SongsByValue {
	const index = new Map<string, Track[]>();
	for (const track of tracks) {
		for (const key of new Set(valueKeys(track, field))) {
			const songs = index.get(key);
			if (songs) {
				songs.push(track);
			} else {
				index.set(key, [track]);
			}
		}
	}
	return index;
}

/** The songs holding `value`, from an index made by `songsByValue`. */
export function songsWithValue(index: SongsByValue, value: string): readonly Track[] {
	return index.get(value.trim().toLowerCase()) ?? [];
}

/** Position of a key on the Camelot wheel (1A, 1B, 2A, ...) for harmonic sorting. */
export function keyRank(key: string | null): number | null {
	const code = key === null ? null : /^(\d{1,2})([AB])$/.exec(camelot(key) ?? "");
	if (!code) {
		return null;
	}
	return Number(code[1]) * 2 + (code[2] === "B" ? 1 : 0);
}

export type SortKey = "title" | "artist" | "album" | "added" | "bpm" | "key" | "duration";
export interface Sort {
	key: SortKey;
	desc: boolean;
}

const text = compareText;

/** Compares two possibly-missing numbers; missing ones go last in either direction. */
function numeric(a: number | null, b: number | null, desc: boolean): number {
	if (a === null || b === null) {
		return (a === null ? 1 : 0) - (b === null ? 1 : 0);
	}
	return desc ? b - a : a - b;
}

/** When two songs came into the library, oldest first; songs added together keep their id order. */
export function addedOrder(a: Track, b: Track): number {
	return a.addedAt - b.addedAt || a.id - b.id;
}

/** `tracks` ordered by `sort`; the original order when `sort` is null. Stable. */
export function sortTracks(tracks: readonly Track[], sort: Sort | null): readonly Track[] {
	if (sort === null) {
		return tracks;
	}
	const sign = sort.desc ? -1 : 1;
	const cmp = (a: Track, b: Track): number => {
		switch (sort.key) {
			case "title":
				return sign * text(a.title, b.title);
			case "artist":
				return (
					sign * (text(a.artist, b.artist) || text(a.album, b.album) || text(a.title, b.title))
				);
			case "album":
				return sign * (text(a.album, b.album) || text(a.title, b.title));
			case "added":
				return sign * addedOrder(a, b);
			case "bpm":
				return numeric(a.bpm, b.bpm, sort.desc);
			case "key":
				return numeric(keyRank(a.key), keyRank(b.key), sort.desc);
			case "duration":
				return numeric(a.durationMs, b.durationMs, sort.desc);
		}
	};
	return [...tracks].sort(cmp);
}

/** Next sort after clicking a column header: ascending, then descending, then off. */
export function nextSort(current: Sort | null, key: SortKey): Sort | null {
	if (current?.key !== key) {
		return { key, desc: false };
	}
	return current.desc ? null : { key, desc: true };
}

/** A typed BPM cleaned up for writing: digits only, rounded; "" clears; null when invalid. */
export function parseBpm(input: string): string | null {
	const t = input.trim();
	if (t === "") {
		return "";
	}
	const n = Number(t.replace(",", "."));
	if (!Number.isFinite(n) || n < 1 || n > 999) {
		return null;
	}
	return String(Math.round(n));
}

/** Tag fields whose values the Metadata screen manages. `library` is the app's own tags. */
export const VALUE_FIELDS = [
	{ id: "artist", label: "Artists", one: "Artist" },
	{ id: "albumArtist", label: "Album artists", one: "Album artist" },
	{ id: "genre", label: "Genres", one: "Genre" },
	{ id: "label", label: "Labels", one: "Label" },
	{ id: "grouping", label: "Grouping", one: "Grouping" },
	{ id: "composer", label: "Composers", one: "Composer" },
	{ id: "remixer", label: "Remixers", one: "Remixer" },
	{ id: "mood", label: "Moods", one: "Mood" },
	{ id: "language", label: "Languages", one: "Language" },
	{ id: "library", label: "Library tags", one: "Library tag" },
] as const;

export type ValueField = (typeof VALUE_FIELDS)[number]["id"];

export function valueField(id: string) {
	return VALUE_FIELDS.find((f) => f.id === id);
}
