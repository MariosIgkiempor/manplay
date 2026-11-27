import { describe, expect, it } from "vitest";
import type { Track } from "#/lib/api.ts";
import { tagTargetFor } from "#/lib/tag-target.ts";

const track = (id: number, album: string, artist = "A"): Track => ({
	id,
	path: `/m/${artist}/${album}/${id}.mp3`,
	artist,
	album,
	title: `t${id}`,
	size: 1,
	tags: [],
	syncedCount: 0,
	fields: {},
	durationMs: null,
	bitrate: null,
	sampleRate: null,
	bpm: null,
	key: null,
	analyzed: false,
	edited: { bpm: false, key: false, grid: false },
	fileState: "here",
});

describe("tagTargetFor", () => {
	it("edits one song as that file", () => {
		expect(tagTargetFor([track(1, "X")])).toEqual({
			path: "/m/A/X/1.mp3",
			name: "1.mp3",
			isDir: false,
		});
	});

	it("names songs of one album after it", () => {
		const t = tagTargetFor([track(1, "X"), track(2, "X")]);
		expect(t).toMatchObject({ name: "X", kind: "Album", isDir: true });
		expect(t?.paths).toEqual(["/m/A/X/1.mp3", "/m/A/X/2.mp3"]);
	});

	it("calls mixed songs a selection", () => {
		expect(tagTargetFor([track(1, "X"), track(2, "Y")])).toMatchObject({
			name: "2 songs",
			kind: "Selection",
		});
		expect(tagTargetFor([])).toBeNull();
	});
});
