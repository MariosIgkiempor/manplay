import { describe, expect, it } from "vitest";
import { sameSelection, setTagTree, tagCheck } from "#/lib/rekordbox-selection.ts";
import { buildTagTree } from "#/lib/tag-tree.ts";

const tree = buildTagTree([
	{ id: 1, name: "Genre", trackCount: 3 },
	{ id: 2, name: "Genre/House", trackCount: 2 },
	{ id: 3, name: "Genre/House/Deep", trackCount: 1 },
]);
const genre = tree[0];
if (!genre) {
	throw new Error("fixture");
}

describe("setTagTree", () => {
	it("checking a parent checks every tag below it", () => {
		expect(setTagTree([], genre, true).sort()).toEqual([
			"Genre",
			"Genre/House",
			"Genre/House/Deep",
		]);
	});
	it("unchecking a parent clears its children and keeps other tags", () => {
		expect(setTagTree(["Mood", "genre/house"], genre, false)).toEqual(["Mood"]);
	});
	it("does not duplicate names that differ only by case", () => {
		expect(setTagTree(["genre"], genre, true)).toHaveLength(3);
	});
});

describe("tagCheck", () => {
	it("is partial when only some of the subtree is selected", () => {
		expect(tagCheck([], genre)).toBe("off");
		expect(tagCheck(["Genre/House"], genre)).toBe("some");
		expect(tagCheck(["Genre", "Genre/House", "Genre/House/Deep"], genre)).toBe("on");
	});
});

describe("sameSelection", () => {
	it("ignores order and case", () => {
		expect(
			sameSelection(
				{ excludedPlaylists: [2, 1], tags: ["B", "a"] },
				{ excludedPlaylists: [1, 2], tags: ["A", "b"] },
			),
		).toBe(true);
	});
});
