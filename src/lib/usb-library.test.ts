import { describe, expect, it } from "vitest";
import type { Track, UsbPlaylist, UsbTrack } from "#/lib/api.ts";
import { freeName, moveTargets, playlistTree, usbAsTracks, within } from "#/lib/usb-library.ts";

const p = (id: number, parentId: number, sortOrder: number, isFolder = false): UsbPlaylist => ({
	id,
	parentId,
	sortOrder,
	isFolder,
	name: `p${id}`,
	trackIds: [],
});

describe("playlistTree", () => {
	it("lists folders before their contents, in sort order", () => {
		const rows = playlistTree([p(3, 1, 1), p(1, 0, 1, true), p(2, 0, 0), p(4, 1, 0)]);
		expect(rows.map((r) => [r.playlist.id, r.depth])).toEqual([
			[2, 0],
			[1, 0],
			[4, 1],
			[3, 1],
		]);
	});

	it("survives a playlist that names itself as parent", () => {
		expect(playlistTree([p(1, 1, 0)])).toEqual([]);
	});
});

describe("editing helpers", () => {
	const lists = [p(1, 0, 0, true), p(2, 1, 0, true), p(3, 2, 0), p(4, 0, 1), p(5, 0, 2, true)];

	it("finds everything inside a folder", () => {
		expect([...within(lists, 1)].sort()).toEqual([1, 2, 3]);
	});

	it("never offers a folder's own insides, or where it already is", () => {
		expect(moveTargets(lists, 1).map((t) => t.id)).toEqual([5]);
		expect(moveTargets(lists, 3).map((t) => t.id)).toEqual([0, 1, 5]);
	});

	it("numbers a name already used beside it", () => {
		expect(freeName(lists, 0, "p4")).toBe("p4 2");
		expect(freeName(lists, 1, "p4")).toBe("p4");
	});
});

describe("usbAsTracks", () => {
	const song = (id: number, fileSize: number): UsbTrack => ({
		id,
		title: "",
		artist: "DJ",
		album: "",
		genre: "",
		key: "8A",
		comment: "",
		path: `/Contents/DJ/s${id}.mp3`,
		analyzePath: "",
		dateAdded: "",
		durationSecs: 200,
		tempo: 12_800,
		bitrate: 320,
		sampleRate: 44_100,
		fileSize,
		year: 0,
		trackNumber: 0,
		fileType: 1,
		artworkId: 0,
	});
	const mine = { id: 7, size: 999, album: "LP", tags: ["Warm"] } as Track;

	it("plays off the drive and borrows a matching library song's id", () => {
		const [a, b] = usbAsTracks([song(1, 999), song(2, 5)], "/Volumes/STICK", [mine]);
		expect(a).toMatchObject({ id: 7, album: "LP", path: "/Volumes/STICK/Contents/DJ/s1.mp3" });
		expect(b).toMatchObject({ id: -2, title: "s2.mp3", bpm: 128, key: "Am", durationMs: 200_000 });
	});
});
