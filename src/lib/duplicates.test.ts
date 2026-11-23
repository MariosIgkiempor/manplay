import { describe, expect, it } from "vitest";
import type { DuplicateGroup } from "#/lib/api.ts";
import {
	copyMarker,
	type DuplicateCopy,
	decideGroups,
	extraCopies,
	type GroupChoice,
	suggestKeeper,
	trashPlan,
} from "#/lib/duplicates.ts";

const file = (id: number) => ({
	id,
	path: `/m/${id}.mp3`,
	title: "T",
	artist: "A",
	album: "B",
	size: 1,
	embeddedCues: [],
});

const copy = (
	path: string,
	size = 10,
	embeddedCues: DuplicateCopy["embeddedCues"] = [],
): DuplicateCopy => ({
	id: 1,
	path,
	title: "T",
	artist: "A",
	album: "B",
	size,
	embeddedCues,
});

const noIssues = () => 0;

describe("extraCopies", () => {
	it("counts the files beyond the first of each group", () => {
		const groups: DuplicateGroup[] = [
			{ audioFp: "x", tracks: [file(1), file(2)] },
			{ audioFp: "y", tracks: [file(3), file(4), file(5)] },
		];
		expect(extraCopies(groups)).toBe(3);
		expect(extraCopies([])).toBe(0);
	});
});

describe("copyMarker", () => {
	it.each([
		["browser download", "Song (1).mp3", " (1)"],
		["browser download, no space", "Song(2).mp3", "(2)"],
		["Windows copy", "Song - Copy.mp3", " - Copy"],
		["Windows second copy", "Song - Copy (2).mp3", " - Copy (2)"],
		["Finder second copy", "Song copy 2.mp3", " copy 2"],
		["underscore copy", "Song_copy.flac", "_copy"],
		["square brackets", "Song [1].mp3", " [1]"],
		["upper case", "Song - COPY.mp3", " - COPY"],
	])("finds the marker of a %s", (_what, name, marker) => {
		expect(copyMarker(name)?.text).toBe(marker);
		expect(name.slice(copyMarker(name)?.start)).toMatch(
			new RegExp(`^${marker.replace(/[()[\]]/g, "\\$&")}\\.`),
		);
	});

	it.each([
		["a plain title", "Song.mp3"],
		["a year in brackets", "Song (2019).mp3"],
		["a mix name", "Song (Extended Mix).mp3"],
		["a word ending in copy", "Carbon Copy.mp3"],
		["a lone track number", "Track 2.mp3"],
		["nothing but a marker", "(1).mp3"],
	])("finds none in %s", (_what, name) => {
		expect(copyMarker(name)).toBeNull();
	});

	it.each([
		["a space", "Song 2.mp3"],
		["a hyphen", "Song-1.mp3"],
		["an underscore", "Song_1.mp3"],
		["a dot", "Song.1.mp3"],
		["the word copy", "Song copy.mp3"],
	])("takes %s ending as a marker when a sibling has the bare name", (_what, name) => {
		expect(copyMarker(name, ["Song.mp3"])).not.toBeNull();
		expect(copyMarker(name, ["Other.mp3"])).toBeNull();
	});
});

describe("suggestKeeper", () => {
	it("keeps the only copy without a marker", () => {
		const copies = [copy("/m/Song (1).mp3"), copy("/m/A/B/Song.mp3"), copy("/m/Song copy.mp3")];
		expect(suggestKeeper(copies, noIssues)).toEqual({
			kind: "keep",
			path: "/m/A/B/Song.mp3",
			reason: "unmarked",
		});
	});

	it("keeps the only tidy copy when the names do not tell", () => {
		const copies = [copy("/m/Unsorted/Song.mp3"), copy("/m/A/B/Song.mp3")];
		const issues = (path: string) => (path.includes("Unsorted") ? 1 : 0);
		expect(suggestKeeper(copies, issues)).toEqual({
			kind: "keep",
			path: "/m/A/B/Song.mp3",
			reason: "tidy",
		});
	});

	it.each([
		["neither name nor issues tell", [copy("/m/x/Song.mp3"), copy("/m/y/Song.mp3")], noIssues],
		["every name is marked alike", [copy("/m/Song (1).mp3"), copy("/m/Song (2).mp3")], noIssues],
		["every copy has issues", [copy("/m/x/Song.mp3"), copy("/m/y/Song.mp3")], () => 1],
	])("leaves it to the user when %s", (_what, copies, issues) => {
		expect(suggestKeeper(copies, issues)).toEqual({ kind: "undecided", why: "unclear" });
	});

	it("leaves it to the user when the plain name has issues and a marked copy has none", () => {
		const copies = [copy("/m/Downloads/Song.mp3"), copy("/m/A/B/Song (1).mp3")];
		const issues = (path: string) => (path.includes("Downloads") ? 1 : 0);
		expect(suggestKeeper(copies, issues)).toEqual({ kind: "undecided", why: "signsDisagree" });
	});

	it.each([
		["only the copy that would go has them", [], ["serato"], "undecided"],
		["the kept copy has them too", ["serato"], ["serato"], "keep"],
		["only the kept copy has them", ["traktor"], [], "keep"],
	] as const)("with cue points in the tags, when %s", (_what, keptCues, goingCues, expected) => {
		const copies = [
			copy("/m/Song.mp3", 10, [...keptCues]),
			copy("/m/Song (1).mp3", 10, [...goingCues]),
		];
		expect(suggestKeeper(copies, noIssues).kind).toBe(expected);
	});
});

describe("decideGroups and trashPlan", () => {
	const groups: DuplicateGroup[] = [
		{ audioFp: "a", tracks: [copy("/m/A.mp3", 5), copy("/m/A (1).mp3", 7)] },
		{ audioFp: "b", tracks: [copy("/m/x/B.mp3"), copy("/m/y/B.mp3")] },
		{ audioFp: "c", tracks: [copy("/m/C.mp3"), copy("/m/C copy.mp3", 3)] },
	];

	it("never throws away the kept path when a group lists it twice", () => {
		const twice: DuplicateGroup[] = [
			{ audioFp: "t", tracks: [copy("/m/T.mp3"), copy("/m/T.mp3"), copy("/m/T (1).mp3")] },
		];
		const choices = new Map<string, GroupChoice>([["t", { kind: "keep", path: "/m/T.mp3" }]]);
		expect(trashPlan(twice, decideGroups(twice, choices, noIssues)).paths).toEqual([
			"/m/T (1).mp3",
		]);
	});

	it("trashes the marked copies and leaves undecided groups alone", () => {
		const plan = trashPlan(groups, decideGroups(groups, new Map(), noIssues));
		expect(plan.paths).toEqual(["/m/A (1).mp3", "/m/C copy.mp3"]);
		expect(plan.bytes).toBe(10);
		expect(plan.undecided).toBe(1);
		expect(plan.keptAll).toBe(0);
	});

	it("follows the user's picks over the suggestion", () => {
		const choices = new Map<string, GroupChoice>([
			["a", { kind: "keep", path: "/m/A (1).mp3" }],
			["b", { kind: "keep", path: "/m/y/B.mp3" }],
			["c", { kind: "keepAll" }],
		]);
		const plan = trashPlan(groups, decideGroups(groups, choices, noIssues));
		expect(plan.paths).toEqual(["/m/A.mp3", "/m/x/B.mp3"]);
		expect(plan.undecided).toBe(0);
		expect(plan.keptAll).toBe(1);
	});

	it("drops a pick whose file is gone and suggests again", () => {
		const choices = new Map<string, GroupChoice>([["a", { kind: "keep", path: "/m/gone.mp3" }]]);
		expect(decideGroups(groups, choices, noIssues).get("a")).toEqual({
			kind: "keep",
			path: "/m/A.mp3",
			reason: "unmarked",
		});
	});
});
