import { describe, expect, it } from "vitest";
import {
	FOLDER_NAME_MAX_PARTS,
	FOLDER_NAME_MAX_TEXT,
	FOLDER_NAME_TAGS,
	type FolderFileNames,
	type FolderNameTag,
	folderFileNamesSchema,
} from "#/lib/api.ts";
import {
	EXAMPLE_SONG,
	FOLDER_NAME_PRESETS,
	type FolderNameSong,
	formatFolderFileName,
	parseFolderFileName,
	renderFolderFileName,
	tagBeingTyped,
	tagsMatching,
	tokenAt,
} from "#/lib/folder-file-names.ts";

const artistTitle: FolderFileNames = [{ tag: "artist" }, { text: " - " }, { tag: "title" }];

describe("folderFileNamesSchema", () => {
	it.each<[string, unknown, boolean]>([
		["one tag", [{ tag: "title" }], true],
		["tags and text", artistTitle, true],
		["nothing", [], false],
		["text alone", [{ text: "set" }], false],
		["an unknown tag", [{ tag: "mood" }], false],
		["empty text", [{ tag: "title" }, { text: "" }], false],
		["too long a text", [{ tag: "title" }, { text: "x".repeat(FOLDER_NAME_MAX_TEXT + 1) }], false],
		["too many parts", new Array(FOLDER_NAME_MAX_PARTS + 1).fill({ tag: "title" }), false],
		["a part that is both", [{ tag: "title", text: "x" }], false],
		["not a list", { tag: "title" }, false],
	])("%s", (_, input, valid) => {
		expect(folderFileNamesSchema.safeParse(input).success).toBe(valid);
	});
});

describe("renderFolderFileName", () => {
	const song = (changes: Partial<FolderNameSong>): FolderNameSong => ({
		...EXAMPLE_SONG,
		...changes,
	});
	// The same cases as `names_are_filled_from_the_songs_tags` in `playlist_folders/file_name.rs`.
	it.each<[string, FolderFileNames, FolderNameSong, string]>([
		["the default keeps the file name", [{ tag: "fileName" }], EXAMPLE_SONG, "bicep-glue.mp3"],
		["artist and title", artistTitle, EXAMPLE_SONG, "Bicep - Glue.mp3"],
		["text beside a missing tag goes with it", artistTitle, song({ artist: "" }), "Glue.mp3"],
		[
			"brackets round a missing tag go too",
			[{ text: "[" }, { tag: "key" }, { text: "] " }, { tag: "title" }],
			song({ key: "" }),
			"Glue.mp3",
		],
		[
			"brackets round a tag that is there stay",
			[{ text: "[" }, { tag: "key" }, { text: "] " }, { tag: "title" }],
			EXAMPLE_SONG,
			"[8A] Glue.mp3",
		],
		[
			"nothing to show falls back to the file name",
			[{ tag: "genre" }],
			song({ genre: "" }),
			"bicep-glue.mp3",
		],
		[
			"characters a drive refuses are replaced",
			[{ tag: "artist" }, { text: " / " }, { tag: "title" }],
			song({ title: "What?" }),
			"Bicep _ What_.mp3",
		],
	])("%s", (_, parts, input, expected) => {
		expect(renderFolderFileName(parts, input)).toBe(expected);
	});
});

describe("parseFolderFileName", () => {
	it.each<[string, string, FolderFileNames]>([
		["tags and text", "{Artist} - {Title}", artistTitle],
		["any case, or the tag's key", "{artist} - {TITLE}", artistTitle],
		["a label with spaces", "{File name}", [{ tag: "fileName" }]],
		["a key in camel case", "{trackNumber}", [{ tag: "trackNumber" }]],
		[
			"braces that name no tag stay text",
			"{Mood} {Title}",
			[{ text: "{Mood} " }, { tag: "title" }],
		],
		["an unclosed brace stays text", "{Title} {Art", [{ tag: "title" }, { text: " {Art" }]],
	])("%s", (_, text, parts) => {
		expect(parseFolderFileName(text)).toEqual({ ok: true, parts });
	});

	it.each<[string, string, string]>([
		["no tag", "just text", "Add at least one tag."],
		["empty", "", "Add at least one tag."],
		[
			"too long a text",
			`{Title}${"x".repeat(FOLDER_NAME_MAX_TEXT + 1)}`,
			`Text between tags is ${FOLDER_NAME_MAX_TEXT} characters at most.`,
		],
		[
			"too many parts",
			"{Title}".repeat(FOLDER_NAME_MAX_PARTS + 1),
			`A name holds ${FOLDER_NAME_MAX_PARTS} tags and texts at most.`,
		],
	])("%s is refused", (_, text, error) => {
		expect(parseFolderFileName(text)).toEqual({ ok: false, error });
	});

	it("reads back what it writes", () => {
		for (const { parts } of FOLDER_NAME_PRESETS) {
			expect(parseFolderFileName(formatFolderFileName(parts))).toEqual({ ok: true, parts });
		}
	});
});

describe("tagBeingTyped", () => {
	it.each<[string, string, number, ReturnType<typeof tagBeingTyped>]>([
		["after an open brace", "{Ti", 3, { from: 0, query: "Ti" }],
		["right after the brace", "a {", 3, { from: 2, query: "" }],
		["after a closed tag", "{Title} ", 8, null],
		["no brace", "abc", 3, null],
	])("%s", (_, text, caret, expected) => {
		expect(tagBeingTyped(text, caret)).toEqual(expected);
	});
});

describe("tagsMatching", () => {
	it.each<[string, FolderNameTag[]]>([
		["ti", ["title", "artist"]],
		["a", ["artist", "album", "fileName", "year", "trackNumber"]],
		["", [...FOLDER_NAME_TAGS]],
		["zzz", []],
	])("%s", (query, expected) => {
		expect(tagsMatching(query)).toEqual(expected);
	});
});

describe("tokenAt", () => {
	const text = "{Artist} - {Title}";
	it.each<[string, number, "before" | "after", { start: number; end: number } | undefined]>([
		["ends at the caret", 8, "before", { start: 0, end: 8 }],
		["starts at the caret", 11, "after", { start: 11, end: 18 }],
		["inside text", 9, "before", undefined],
	])("%s", (_, caret, side, expected) => {
		expect(tokenAt(text, caret, side)).toEqual(expected);
	});
});
