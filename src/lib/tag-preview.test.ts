import { describe, expect, it } from "vitest";
import { diffNames, isReorder, summarize } from "#/lib/tag-preview.ts";

describe("summarize", () => {
	it("groups changes by tag with counts of the old values", () => {
		const rows = summarize([
			{ path: "a", changes: [{ field: "genre", from: "Techno", to: "House" }] },
			{ path: "b", changes: [{ field: "genre", from: "Techno", to: "House" }] },
			{
				path: "c",
				changes: [
					{ field: "genre", from: null, to: "House" },
					{ field: "label", from: "X", to: null },
				],
			},
		]);
		expect(rows.map((r) => r.field)).toEqual(["genre", "label"]);
		expect(rows[0]).toMatchObject({ songs: 3, to: "House" });
		expect(rows[0]?.was).toEqual([
			{ value: "Techno", count: 2 },
			{ value: null, count: 1 },
		]);
		expect(rows[1]).toMatchObject({ songs: 1, to: null });
	});
});

describe("diffNames", () => {
	it("marks added and removed names", () => {
		expect(diffNames("A; B", "B; C")).toEqual([
			{ name: "B", state: "kept" },
			{ name: "C", state: "added" },
			{ name: "A", state: "removed" },
		]);
	});
	it("treats empty as no names", () => {
		expect(diffNames(null, "A")).toEqual([{ name: "A", state: "added" }]);
	});
	it("spots a pure reorder", () => {
		expect(isReorder("A; B", "B; A")).toBe(true);
		expect(isReorder("A; B", "A; B")).toBe(false);
		expect(isReorder("A", "A; B")).toBe(false);
	});
});
