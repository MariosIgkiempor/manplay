import { describe, expect, it } from "vitest";
import type { FsEntry } from "#/lib/api.ts";
import {
	filterRows,
	flattenTree,
	forgetPaths,
	nameMatches,
	nextFlagged,
	sortEntries,
	stepFrom,
} from "#/lib/tree.ts";

const dir = (name: string): FsEntry => ({ name, isDir: true, size: 0, modified: null });
const file = (name: string): FsEntry => ({ name, isDir: false, size: 1, modified: null });

const listings = new Map<string, FsEntry[]>([
	["/lib", [dir("A"), file("z.mp3")]],
	["/lib/A", [dir("B"), file("a.mp3")]],
	["/lib/A/B", [file("deep.mp3")]],
]);

describe("flattenTree", () => {
	it("shows only the top level when nothing is expanded", () => {
		const rows = flattenTree("/lib", listings, new Set());
		expect(rows.map((r) => r.path)).toEqual(["/lib/A", "/lib/z.mp3"]);
	});

	it("nests expanded folders in place with their depth", () => {
		const rows = flattenTree("/lib", listings, new Set(["/lib/A", "/lib/A/B"]));
		expect(rows.map((r) => [r.path, r.depth])).toEqual([
			["/lib/A", 0],
			["/lib/A/B", 1],
			["/lib/A/B/deep.mp3", 2],
			["/lib/A/a.mp3", 1],
			["/lib/z.mp3", 0],
		]);
		expect(rows[2]?.parent).toBe("/lib/A/B");
	});

	it("skips folders whose listing has not loaded", () => {
		const rows = flattenTree("/lib", new Map([["/lib", [dir("A")]]]), new Set(["/lib/A"]));
		expect(rows).toHaveLength(1);
	});
});

describe("forgetPaths", () => {
	it("removes the folder and everything below it, nothing else", () => {
		const kept = forgetPaths(new Set(["/lib/A", "/lib/A/B", "/lib/AB"]), ["/lib/A"]);
		expect([...kept]).toEqual(["/lib/AB"]);
	});
});

describe("stepFrom", () => {
	const v = ["a", "b", "c"];
	it("moves and clamps at the ends", () => {
		expect(stepFrom(v, "a", 1)).toBe("b");
		expect(stepFrom(v, "c", 1)).toBe("c");
		expect(stepFrom(v, "a", -1)).toBe("a");
	});
	it("starts at the first or last row with nothing current", () => {
		expect(stepFrom(v, null, 1)).toBe("a");
		expect(stepFrom(v, undefined, -1)).toBe("c");
		expect(stepFrom([], "a", 1)).toBeNull();
	});
});

describe("nextFlagged", () => {
	const v = ["a", "b", "c", "d"];
	const flagged = new Set(["b", "d"]);
	it("jumps to the next flagged row and wraps", () => {
		expect(nextFlagged(v, flagged, "a", 1)).toBe("b");
		expect(nextFlagged(v, flagged, "b", 1)).toBe("d");
		expect(nextFlagged(v, flagged, "d", 1)).toBe("b");
	});
	it("goes backwards too", () => {
		expect(nextFlagged(v, flagged, "d", -1)).toBe("b");
		expect(nextFlagged(v, flagged, "b", -1)).toBe("d");
		expect(nextFlagged(v, flagged, null, -1)).toBe("d");
		expect(nextFlagged(v, flagged, null, 1)).toBe("b");
	});
	it("returns null when nothing is flagged", () => {
		expect(nextFlagged(v, new Set(), "a", 1)).toBeNull();
		expect(nextFlagged([], flagged, null, 1)).toBeNull();
	});
});

describe("sortEntries", () => {
	const names = (es: FsEntry[]) => es.map((e) => e.name);
	it("puts folders first and orders numbers by value, ignoring case", () => {
		const es = [file("Track 10.mp3"), file("track 2.mp3"), dir("b"), file("Abc.mp3"), dir("A")];
		expect(names(sortEntries(es, { key: "name", desc: false }))).toEqual([
			"A",
			"b",
			"Abc.mp3",
			"track 2.mp3",
			"Track 10.mp3",
		]);
	});
	it("sorts by size descending and keeps folders on top", () => {
		const es = [{ ...file("small"), size: 1 }, { ...file("big"), size: 9 }, dir("D")];
		expect(names(sortEntries(es, { key: "size", desc: true }))).toEqual(["D", "big", "small"]);
	});
	it("sorts by date modified", () => {
		const es = [
			{ ...file("new"), modified: 20 },
			{ ...file("old"), modified: 10 },
		];
		expect(names(sortEntries(es, { key: "modified", desc: false }))).toEqual(["old", "new"]);
	});
});

describe("filterRows", () => {
	const rows = flattenTree("/lib", listings, new Set(["/lib/A", "/lib/A/B"]));
	it("keeps matches and the open folders they sit in", () => {
		expect(filterRows(rows, "deep").map((r) => r.path)).toEqual([
			"/lib/A",
			"/lib/A/B",
			"/lib/A/B/deep.mp3",
		]);
	});
	it("keeps everything for an empty query", () => {
		expect(filterRows(rows, "  ")).toHaveLength(rows.length);
	});
	it("matches without case or accents", () => {
		expect(nameMatches("Beyoncé - Halo.mp3", "beyonce")).toBe(true);
	});
});
