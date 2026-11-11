import { describe, expect, it } from "vitest";
import type { Playlist, Tag, Track } from "#/lib/api.ts";
import { filterTracks, type Pill, suggest } from "#/lib/search.ts";

const track = (id: number, artist: string, title: string, tags: string[] = []): Track => ({
	id,
	path: `/m/${id}`,
	artist,
	album: "Album",
	title,
	size: 1,
	tags,
	syncedCount: 0,
	durationMs: null,
	bitrate: null,
	sampleRate: null,
});

const tracks = [
	track(1, "Bonobo", "Kiara", ["chill"]),
	track(2, "Bonobo", "Cirrus", ["chill", "fav"]),
	track(3, "Floating Points", "Birth", ["fav"]),
];
const members = new Map([[7, new Set([1, 3])]]);
const artistPill = (name: string): Pill => ({ kind: "artist", label: name, id: name });
const tagPill = (name: string): Pill => ({ kind: "tag", label: name, id: name });
const ids = (ts: Track[]) => ts.map((t) => t.id);

describe("filterTracks", () => {
	it("passes everything with no filters", () => {
		expect(ids(filterTracks(tracks, [], "", members))).toEqual([1, 2, 3]);
	});

	it("matches typed text against title, artist and album", () => {
		expect(ids(filterTracks(tracks, [], "kiar", members))).toEqual([1]);
		expect(ids(filterTracks(tracks, [], "float", members))).toEqual([3]);
	});

	it("treats pills of one kind as alternatives and kinds as restrictions", () => {
		expect(
			ids(filterTracks(tracks, [artistPill("Bonobo"), artistPill("Floating Points")], "", members)),
		).toEqual([1, 2, 3]);
		expect(ids(filterTracks(tracks, [artistPill("Bonobo"), tagPill("fav")], "", members))).toEqual([
			2,
		]);
	});

	it("filters by playlist membership and single songs", () => {
		const pl: Pill = { kind: "playlist", label: "Fri", id: 7 };
		expect(ids(filterTracks(tracks, [pl], "", members))).toEqual([1, 3]);
		expect(
			ids(filterTracks(tracks, [{ kind: "song", label: "Cirrus", id: 2 }], "", members)),
		).toEqual([2]);
		expect(
			ids(filterTracks(tracks, [{ kind: "playlist", label: "?", id: 99 }], "", members)),
		).toEqual([]);
	});
});

describe("suggest", () => {
	const playlists: Playlist[] = [{ id: 7, name: "Friday", trackCount: 2 }];
	const tags: Tag[] = [{ id: 1, name: "chill", trackCount: 2 }];

	it("offers only playlists and tags before anything is typed", () => {
		expect(suggest("", tracks, playlists, tags, []).map((g) => g.title)).toEqual([
			"Playlists",
			"Tags",
		]);
	});

	it("groups matches by kind and leaves out picked pills", () => {
		const groups = suggest("bon", tracks, playlists, tags, []);
		expect(groups.map((g) => g.title)).toEqual(["Artists"]);
		expect(groups[0]?.items[0]?.hint).toBe("2 songs");
		expect(suggest("bon", tracks, playlists, tags, [artistPill("Bonobo")])).toEqual([]);
	});

	it("finds songs by title", () => {
		const groups = suggest("birth", tracks, playlists, tags, []);
		expect(groups[0]?.title).toBe("Songs");
		expect(groups[0]?.items[0]?.pill.id).toBe(3);
	});
});
