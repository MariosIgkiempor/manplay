import { describe, expect, it } from "vitest";
import type { LookupCandidate, ReleaseId, SongLookup } from "#/lib/api.ts";
import {
	COVER,
	chosenCandidate,
	coverSuggestions,
	fillsOnly,
	isMatched,
	type MatchedSong,
	reasonWithoutMatch,
	remainingCovers,
	remainingSuggestions,
	showsInline,
	suggestions,
	takenBy,
	takenKey,
	tally,
	USING_SURE_MATCHES,
	type Using,
	writeOf,
} from "#/lib/tag-lookup.ts";

type Change = LookupCandidate["changes"][number];

const fill = (field: string, to: string): Change => ({ field, from: null, to });
const replace = (field: string, from: string, to: string): Change => ({ field, from, to });

const RELEASE = "170d8783-40b3-4b0b-879d-0ef6055dfeb3" as ReleaseId;
const OTHER_RELEASE = "b791a9cc-dc92-45ee-b5b9-be5617823411" as ReleaseId;

function candidate(
	likely: boolean,
	changes: Change[],
	cover: ReleaseId | null = null,
): LookupCandidate {
	return {
		recording: "de0c999d-ddd0-494b-8a52-463333df64fd",
		release: null,
		confidence: likely ? 100 : 70,
		likely,
		fields: Object.fromEntries(changes.map((c) => [c.field, c.to ?? ""])),
		changes,
		cover,
	} as LookupCandidate;
}

function matched(path: string, hasCover: boolean, ...candidates: LookupCandidate[]): MatchedSong {
	return { path, hasCover, outcome: { kind: "matched", candidates } };
}

const sure = matched(
	"a",
	false,
	candidate(
		true,
		[fill("label", "Virgin"), fill("track", "1"), replace("album", "hw", "Homework")],
		RELEASE,
	),
);
const alsoSure = matched(
	"b",
	true,
	candidate(
		true,
		[fill("label", "Virgin"), fill("track", "2"), fill("album", "Homework")],
		RELEASE,
	),
);
const unsure = matched(
	"c",
	false,
	candidate(false, [fill("label", "Soma")], OTHER_RELEASE),
	candidate(false, [fill("label", "Virgin"), fill("year", "1997")]),
);
const none: SongLookup = { path: "d", hasCover: false, outcome: { kind: "noMatch" } };
const songs = [sure, alsoSure, unsure, none];

const withUnsure: Using = { chosen: new Map(), includeUnsure: true };
const choosing = (path: string, index: number): Using => ({
	chosen: new Map([[path, index]]),
	includeUnsure: false,
});

describe("suggestions", () => {
	it("gives one per tag, from sure matches only, in the tag editor's order", () => {
		expect(suggestions(songs, USING_SURE_MATCHES)).toEqual([
			{
				field: "album",
				value: "Homework",
				fills: false,
				changes: [
					{ path: "a", from: "hw", to: "Homework" },
					{ path: "b", from: null, to: "Homework" },
				],
			},
			{
				field: "track",
				value: null,
				fills: true,
				changes: [
					{ path: "a", from: null, to: "1" },
					{ path: "b", from: null, to: "2" },
				],
			},
			{
				field: "label",
				value: "Virgin",
				fills: true,
				changes: [
					{ path: "a", from: null, to: "Virgin" },
					{ path: "b", from: null, to: "Virgin" },
				],
			},
		]);
	});

	it.each<[string, Using, string | null, string[]]>([
		["sure matches only", USING_SURE_MATCHES, "Virgin", ["a", "b"]],
		["unsure ones too, which disagree", withUnsure, null, ["a", "b", "c"]],
		["a match chosen by hand counts as right", choosing("c", 1), "Virgin", ["a", "b", "c"]],
		["a choice that does not exist is no match", choosing("c", 9), "Virgin", ["a", "b"]],
	])("the label, using %s", (_what, using, value, paths) => {
		const label = suggestions(songs, using).find((s) => s.field === "label");
		expect(label?.value).toBe(value);
		expect(label?.changes.map((c) => c.path)).toEqual(paths);
	});

	it("is empty when nothing matched", () => {
		expect(suggestions([none], withUnsure)).toEqual([]);
	});
});

describe("showsInline", () => {
	const all = suggestions(songs, USING_SURE_MATCHES);
	const of = (field: string) => all.find((s) => s.field === field) as (typeof all)[number];

	it.each([
		["one value for a tag shown for a group", "album", true, true],
		["one value for a tag shown for a song", "album", false, true],
		["a value per song", "track", true, false],
		["a value per song, even for one song's editor", "track", false, false],
	])("%s", (_what, field, group, expected) => {
		expect(showsInline(of(field), group)).toBe(expected);
	});

	it("keeps a tag only one song has out of a group's editor", () => {
		const title = { field: "title", value: "Song", fills: true, changes: [] };
		expect(showsInline(title, true)).toBe(false);
		expect(showsInline(title, false)).toBe(true);
	});

	it("does not show a tag the editor does not have", () => {
		expect(showsInline({ field: "nope", value: "x", fills: true, changes: [] }, false)).toBe(false);
	});
});

describe("fillsOnly", () => {
	it("keeps the songs with an empty tag and drops what would replace", () => {
		const fills = fillsOnly(suggestions(songs, USING_SURE_MATCHES));
		expect(fills.map((s) => [s.field, s.fills, s.changes.map((c) => c.path)])).toEqual([
			["album", true, ["b"]],
			["track", true, ["a", "b"]],
			["label", true, ["a", "b"]],
		]);
	});

	it("drops a suggestion that only replaces", () => {
		const replaces = matched("a", false, candidate(true, [replace("album", "x", "y")]));
		expect(fillsOnly(suggestions([replaces], USING_SURE_MATCHES))).toEqual([]);
	});
});

describe("coverSuggestions", () => {
	it("groups by release, apart for songs that have a cover", () => {
		expect(coverSuggestions(songs, withUnsure)).toEqual([
			{ release: RELEASE, paths: ["a"], replaces: false },
			{ release: RELEASE, paths: ["b"], replaces: true },
			{ release: OTHER_RELEASE, paths: ["c"], replaces: false },
		]);
	});

	it("shares one entry between songs alike", () => {
		const twin = { ...sure, path: "e" };
		expect(coverSuggestions([sure, twin], USING_SURE_MATCHES)).toEqual([
			{ release: RELEASE, paths: ["a", "e"], replaces: false },
		]);
	});

	it("leaves out unsure matches and matches without a cover", () => {
		expect(coverSuggestions([unsure], USING_SURE_MATCHES)).toEqual([]);
		expect(coverSuggestions([unsure], choosing("c", 1))).toEqual([]);
	});
});

describe("tally", () => {
	it.each<[string, Using, number, number]>([
		["sure matches only", USING_SURE_MATCHES, 2, 1],
		["unsure ones too", withUnsure, 3, 0],
		["one chosen by hand", choosing("c", 1), 3, 0],
	])("using %s", (_what, using, used, leftOut) => {
		expect(tally(songs, using)).toEqual({
			songs: 4,
			used,
			leftOut,
			unmatched: [{ path: "d", reason: "No song like this was found online" }],
		});
	});
});

describe("writeOf", () => {
	it("writes each song its own values, and each cover once", () => {
		const using = USING_SURE_MATCHES;
		expect(writeOf(suggestions(songs, using), coverSuggestions(songs, using))).toEqual({
			changes: [
				{
					path: "a",
					changes: [
						replace("album", "hw", "Homework"),
						fill("track", "1"),
						fill("label", "Virgin"),
					],
				},
				{
					path: "b",
					changes: [fill("album", "Homework"), fill("track", "2"), fill("label", "Virgin")],
				},
			],
			covers: [
				{ release: RELEASE, paths: ["a"] },
				{ release: RELEASE, paths: ["b"] },
			],
		});
	});

	it("writes nothing for nothing", () => {
		expect(writeOf([], [])).toEqual({ changes: [], covers: [] });
	});
});

describe("what is left after taking", () => {
	const all = suggestions(songs, USING_SURE_MATCHES);
	const covers = coverSuggestions(songs, USING_SURE_MATCHES);

	it("marks what a write took, but not for songs that failed", () => {
		const write = writeOf(all, covers);
		expect(takenBy(write, new Set(["b"]))).toEqual([
			takenKey("album", "a"),
			takenKey("track", "a"),
			takenKey("label", "a"),
			takenKey(COVER, "a"),
		]);
	});

	it("drops taken songs from a suggestion, and the suggestion once none is left", () => {
		const taken = new Set([takenKey("album", "a"), takenKey("label", "a"), takenKey("label", "b")]);
		expect(remainingSuggestions(all, taken)).toEqual([
			{
				field: "album",
				value: "Homework",
				fills: true,
				changes: [{ path: "b", from: null, to: "Homework" }],
			},
			{
				field: "track",
				value: null,
				fills: true,
				changes: [
					{ path: "a", from: null, to: "1" },
					{ path: "b", from: null, to: "2" },
				],
			},
		]);
	});

	it("turns a value per song into one value when one song is left", () => {
		const left = remainingSuggestions(all, new Set([takenKey("track", "a")]));
		expect(left.find((s) => s.field === "track")?.value).toBe("2");
	});

	it("drops songs that got their cover", () => {
		expect(remainingCovers(covers, new Set([takenKey(COVER, "a")]))).toEqual([
			{ release: RELEASE, paths: ["b"], replaces: true },
		]);
		expect(remainingCovers(covers, new Set())).toEqual(covers);
	});
});

describe("chosenCandidate", () => {
	it.each([
		["the best when none is chosen", USING_SURE_MATCHES, "Soma"],
		["the one chosen", choosing("c", 1), "Virgin"],
	])("%s", (_what, using, label) => {
		expect(chosenCandidate(unsure, using)?.fields).toMatchObject({ label });
	});
});

describe("reasonWithoutMatch", () => {
	it.each<[SongLookup["outcome"], string | null]>([
		[{ kind: "noMatch" }, "No song like this was found online"],
		[{ kind: "notEnoughTags" }, "Needs a title and an artist to search with"],
		[{ kind: "failed", message: "MusicBrainz is not answering" }, "MusicBrainz is not answering"],
		[{ kind: "matched", candidates: [candidate(true, [])] }, null],
	])("%o", (outcome, expected) => {
		const song: SongLookup = { path: "a", hasCover: false, outcome };
		expect(reasonWithoutMatch(song)).toBe(expected);
		expect(isMatched(song)).toBe(expected === null);
	});
});
