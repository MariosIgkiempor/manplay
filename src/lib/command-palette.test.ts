import { describe, expect, it } from "vitest";
import { matchScore, type PaletteItem, rankMatches } from "#/lib/command-palette.ts";

const item = (label: string, detail = ""): PaletteItem<null> => ({
	id: label,
	label,
	detail,
	value: null,
});

describe("matchScore", () => {
	it.each<[string, string, string, number]>([
		["the whole name", "house", "House", 5],
		["the start of the name", "hou", "House music", 4],
		["the start of a later word", "mus", "House music", 3],
		["a word after a slash", "deep", "Genre/Deep House", 3],
		["the middle of a word", "ouse", "House", 2],
		["only the second line", "atlas", "Vacancy", 1],
		["nothing", "techno", "House", 0],
		["an empty search", "", "House", 1],
	])("scores a match on %s", (_, query, label, expected) => {
		expect(matchScore(item(label, "Atlas Motel"), query)).toBe(expected);
	});
});

describe("rankMatches", () => {
	const items = [item("Deep House"), item("House"), item("Housework"), item("Techno")];

	it("puts the closest matches first and drops the rest", () => {
		expect(rankMatches(items, " House ", 10).map((i) => i.label)).toEqual([
			"House",
			"Housework",
			"Deep House",
		]);
	});

	it("keeps at most the limit", () => {
		expect(rankMatches(items, "house", 2)).toHaveLength(2);
	});
});
