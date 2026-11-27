import { describe, expect, it } from "vitest";
import { groupAlbums } from "#/lib/albums.ts";
import type { Track } from "#/lib/api.ts";
import { groupArtists } from "#/lib/artists.ts";
import { sortAlbums, sortArtists } from "#/lib/sorting.ts";

const track = (id: number, artist: string, album: string, extra: Partial<Track> = {}): Track => ({
	id,
	path: `/m/${id}`,
	artist,
	album,
	title: `Song ${id}`,
	size: 1,
	tags: [],
	syncedCount: 0,
	durationMs: null,
	bitrate: null,
	sampleRate: null,
	bpm: null,
	key: null,
	analyzed: false,
	fields: {},
	edited: { bpm: false, key: false, grid: false },
	addedAt: 0,
	fileState: "here",
	...extra,
});

describe("sortAlbums", () => {
	const albums = groupAlbums([
		track(1, "B", "Old", { fields: { year: "1999" }, addedAt: 100 }),
		track(2, "A", "New", { fields: { year: "2021" }, addedAt: 300 }),
		track(3, "C", "No year", { addedAt: 200 }),
	]);
	it("puts albums without a year last in either direction", () => {
		const names = (desc: boolean) => sortAlbums(albums, { key: "year", desc }).map((a) => a.album);
		expect(names(true)).toEqual(["New", "Old", "No year"]);
		expect(names(false)).toEqual(["Old", "New", "No year"]);
	});
	it("orders by the newest song added", () => {
		expect(sortAlbums(albums, { key: "added", desc: true }).map((a) => a.album)).toEqual([
			"New",
			"No year",
			"Old",
		]);
	});
});

describe("sortArtists", () => {
	it("breaks ties by name, ascending even when descending", () => {
		const artists = groupArtists([
			track(1, "B", "x"),
			track(2, "A", "y"),
			track(3, "C", "z"),
			track(4, "C", "w"),
		]);
		expect(sortArtists(artists, { key: "songs", desc: true }).map((a) => a.name)).toEqual([
			"C",
			"A",
			"B",
		]);
	});
});
