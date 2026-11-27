import { describe, expect, it } from "vitest";
import type { Track } from "#/lib/api.ts";
import {
	keyRank,
	nextSort,
	parseBpm,
	songsByValue,
	songsWithValue,
	sortTracks,
	trackHasValue,
} from "#/lib/track-fields.ts";

const track = (id: number, fields: Record<string, string>, extra: Partial<Track> = {}): Track => ({
	id,
	path: `/m/${id}`,
	artist: "Artist",
	album: "Album",
	title: `Song ${id}`,
	size: 1,
	tags: [],
	syncedCount: 0,
	fields,
	durationMs: null,
	bitrate: null,
	sampleRate: null,
	bpm: null,
	key: null,
	analyzed: false,
	edited: { bpm: false, key: false, grid: false },
	fileState: "here",
	...extra,
});

describe("trackHasValue", () => {
	it("matches one name of a list field, ignoring case", () => {
		const t = track(1, { genre: "House; Deep House" });
		expect(trackHasValue(t, "genre", "deep house")).toBe(true);
		expect(trackHasValue(t, "genre", "Deep")).toBe(false);
	});
	it("falls back to the display artist for untagged songs", () => {
		expect(trackHasValue(track(1, {}, { artist: "A; B" }), "artist", "B")).toBe(true);
	});
	it("treats library tags as a tag tree", () => {
		expect(trackHasValue(track(1, {}, { tags: ["Mood/Dark"] }), "library", "Mood")).toBe(true);
	});
});

describe("keyRank", () => {
	it("orders keys round the Camelot wheel", () => {
		expect(keyRank("Am")).toBe(16);
		expect(keyRank("C")).toBe(17);
		expect(keyRank("B")).toBeGreaterThan(keyRank("G#m") ?? 0);
		expect(keyRank(null)).toBeNull();
	});
});

describe("sortTracks", () => {
	const list = [track(1, {}, { bpm: 128 }), track(2, {}), track(3, {}, { bpm: 90 })];
	it("sorts by BPM with missing values last both ways", () => {
		expect(sortTracks(list, { key: "bpm", desc: false }).map((t) => t.id)).toEqual([3, 1, 2]);
		expect(sortTracks(list, { key: "bpm", desc: true }).map((t) => t.id)).toEqual([1, 3, 2]);
	});
	it("keeps the original order without a sort", () => {
		expect(sortTracks(list, null)).toBe(list);
	});
});

describe("nextSort", () => {
	it("cycles ascending, descending, off", () => {
		const a = nextSort(null, "bpm");
		const b = nextSort(a, "bpm");
		expect(a).toEqual({ key: "bpm", desc: false });
		expect(b).toEqual({ key: "bpm", desc: true });
		expect(nextSort(b, "bpm")).toBeNull();
	});
});

describe("parseBpm", () => {
	it("rounds, clears and rejects", () => {
		expect(parseBpm(" 127,6 ")).toBe("128");
		expect(parseBpm("")).toBe("");
		expect(parseBpm("fast")).toBeNull();
		expect(parseBpm("0")).toBeNull();
	});
});

describe("songsByValue", () => {
	const library = [
		track(1, { genre: "House; Deep House", artist: "A; B" }, { tags: ["Mood/Dark/Heavy"] }),
		track(2, { genre: "house" }, { artist: "C", tags: ["Mood"] }),
		track(3, {}, { artist: "A; C", tags: ["Moodboard"] }),
		track(4, { genre: "Deep House; deep house" }, { tags: [] }),
	];
	// The index must find exactly the songs `trackHasValue` matches, for every kind of field.
	it.each([
		{ field: "genre", value: "House" },
		{ field: "genre", value: "deep house " },
		{ field: "genre", value: "Techno" },
		{ field: "artist", value: "a" },
		{ field: "artist", value: "C" },
		{ field: "library", value: "Mood" },
		{ field: "library", value: "mood/dark" },
		{ field: "library", value: "Mood/Dark/Heavy" },
		{ field: "library", value: "Moodboard" },
	])("$field “$value” finds what trackHasValue matches", ({ field, value }) => {
		const expected = library.filter((t) => trackHasValue(t, field, value)).map((t) => t.id);
		const found = songsWithValue(songsByValue(library, field), value).map((t) => t.id);
		expect(found).toEqual(expected);
	});
});
