import { describe, expect, it } from "vitest";
import { forTarget } from "#/lib/tag-clipboard.ts";

describe("forTarget", () => {
	const values = { genre: "House", title: "Song", track: "3", albumArtist: "A; B" };
	it("keeps everything for a single song", () => {
		expect(forTarget(values, false)).toEqual(values);
	});
	it("drops song-only fields for a folder", () => {
		expect(forTarget(values, true)).toEqual({ genre: "House", albumArtist: "A; B" });
	});
});
