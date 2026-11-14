import { describe, expect, it } from "vitest";
import { buildTagTree, flattenTagTree, tagLeaf, tagWithin } from "#/lib/tag-tree.ts";

describe("tagWithin", () => {
	it("matches the tag itself and anything below it", () => {
		expect(tagWithin("Genre/House", "genre")).toBe(true);
		expect(tagWithin("Genre", "Genre")).toBe(true);
		expect(tagWithin("Genres", "Genre")).toBe(false);
		expect(tagWithin("Genre", "Genre/House")).toBe(false);
	});
});

describe("buildTagTree", () => {
	it("nests by path, fills missing parents and sorts levels", () => {
		const tree = buildTagTree([
			{ id: 1, name: "Mood/Calm", trackCount: 1 },
			{ id: 2, name: "Genre", trackCount: 3 },
			{ id: 3, name: "Genre/House", trackCount: 2 },
			{ id: 4, name: "Genre/Ambient", trackCount: 1 },
		]);
		expect(tree.map((n) => n.name)).toEqual(["Genre", "Mood"]);
		expect(tree[0]?.children.map((n) => n.label)).toEqual(["Ambient", "House"]);
		expect(tree[1]).toMatchObject({ trackCount: 0, children: [{ name: "Mood/Calm" }] });
		expect(tagLeaf("a/b/c")).toBe("c");
	});
});

describe("flattenTagTree", () => {
	it("lists parents before children with their depth", () => {
		const rows = flattenTagTree([
			{ id: 1, name: "b", trackCount: 1 },
			{ id: 2, name: "a/y", trackCount: 1 },
			{ id: 3, name: "a", trackCount: 1 },
			{ id: 4, name: "a/x", trackCount: 1 },
		]);
		expect(rows.map((r) => `${r.depth}:${r.node.name}`)).toEqual(["0:a", "1:a/x", "1:a/y", "0:b"]);
	});
});
