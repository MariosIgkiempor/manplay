import { describe, expect, it } from "vitest";
import type { Track } from "#/lib/api.ts";
import { groupArtists } from "#/lib/artists.ts";

const track = (id: number, artist: string, album: string) => ({ id, artist, album }) as Track;

describe("groupArtists", () => {
	it("counts a shared credit for each artist", () => {
		const out = groupArtists([track(1, "B; A", "X"), track(2, "A", "Y")]);
		expect(out.map((a) => [a.name, a.tracks.length, a.albumCount])).toEqual([
			["A", 2, 2],
			["B", 1, 1],
		]);
	});

	it("puts songs without an artist last", () => {
		const out = groupArtists([track(1, "", "X"), track(2, "Z", "Y")]);
		expect(out.map((a) => a.name)).toEqual(["Z", ""]);
	});
});
