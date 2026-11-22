import { describe, expect, it } from "vitest";
import type { CoverOption } from "#/lib/api.ts";
import {
	coverTypeOf,
	type DownloadStage,
	downloadStage,
	optionCaption,
} from "#/lib/cover-choice.ts";

const option = (year: number | null, country: string | null, format: string | null) =>
	({ release: "x", title: "Homework", artist: "Daft Punk", year, country, format }) as CoverOption;

describe("optionCaption", () => {
	it.each([
		[option(1997, "FR", "CD"), "1997, FR, CD"],
		[option(1997, null, "Vinyl"), "1997, Vinyl"],
		[option(null, "JP", null), "JP"],
		[option(null, "", ""), "Homework"],
		[option(null, null, null), "Homework"],
	])("%o", (release, expected) => {
		expect(optionCaption(release)).toBe(expected);
	});
});

describe("downloadStage", () => {
	type Now = Parameters<typeof downloadStage>[0];
	const settled: Now = {
		asked: true,
		allowed: true,
		searching: false,
		failed: false,
		candidates: 3,
		loaded: true,
	};

	it.each<[string, Partial<Now>, DownloadStage]>([
		["nothing asked for", { asked: false }, "idle"],
		["not asked, whatever else is true", { asked: false, searching: true, failed: true }, "idle"],
		["lookups are off", { allowed: false }, "ask"],
		["lookups are off, even with results from before", { allowed: false, loaded: true }, "ask"],
		["the search is running", { searching: true }, "searching"],
		["a new search runs over old results", { searching: true, failed: true }, "searching"],
		["the search has not answered yet", { candidates: null }, "searching"],
		["the search failed", { failed: true, candidates: null }, "failed"],
		["no release has a cover", { candidates: 0, loaded: false }, "none"],
		["a picture is on its way", { loaded: false }, "loading"],
		["a picture is showing", {}, "ready"],
	])("%s", (_what, change, expected) => {
		expect(downloadStage({ ...settled, ...change })).toBe(expected);
	});
});

describe("coverTypeOf", () => {
	it.each([
		["/Users/dj/Pictures/cover.jpg", "image/jpeg"],
		["C:\\Covers\\cover.JPEG", "image/jpeg"],
		["cover.png", "image/png"],
	])("reads %j as %j", (path, type) => {
		expect(coverTypeOf(path)).toBe(type);
	});

	it.each(["cover.gif", "cover.webp", "cover", "song.mp3"])("refuses %j", (path) => {
		expect(coverTypeOf(path)).toBeNull();
	});
});
