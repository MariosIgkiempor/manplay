import { describe, expect, it } from "vitest";
import type { FsEntry } from "#/lib/api.ts";
import {
	answerPick,
	existingEntry,
	extensionOf,
	type FilePick,
	type FolderPick,
	isUsable,
	type PickRequest,
	pickPath,
	pickTarget,
	type SavePick,
	saveDecision,
	saveName,
	visibleEntries,
} from "./file-picker.ts";

const FOLDER: FolderPick = {
	kind: "folder",
	purpose: "import",
	title: "Choose a folder",
	confirmLabel: "Choose",
};
const PICTURE: FilePick = {
	kind: "file",
	purpose: "cover",
	title: "Choose a picture",
	confirmLabel: "Choose",
	extensions: ["jpg", "jpeg", "png"],
};
const SAVE: SavePick = {
	kind: "save",
	purpose: "rekordbox",
	title: "Save",
	confirmLabel: "Save",
	defaultName: "manplay-rekordbox.xml",
	extension: "xml",
};

const entry = (name: string, isDir = false): FsEntry => ({ name, isDir, size: 1, modified: null });

describe("saveName", () => {
	it.each([
		["library", "library.xml"],
		["  library  ", "library.xml"],
		["library.xml", "library.xml"],
		["library.XML", "library.xml"],
		["my.set", "my.set.xml"],
		["Sets 2026 (final)", "Sets 2026 (final).xml"],
	])("saves %j as %j", (typed, name) => {
		expect(saveName(typed, "xml")).toEqual({ ok: true, name });
	});

	it.each([
		["nothing", ""],
		["only spaces", "   "],
		["only the extension", ".xml"],
		["a folder separator", "sets/library"],
		["a Windows separator", "sets\\library"],
		["a climb out of the folder", "../library"],
		["a colon", "C:library"],
		["a wildcard", "lib*"],
		["a question mark", "what?"],
		["quotes", 'the "one"'],
		["a pipe", "a|b"],
		["angle brackets", "<new>"],
		["a control character", "lib\u0007rary"],
		["only dots", ".."],
		["a trailing dot", "library."],
		["a trailing dot before the extension", "library..xml"],
	])("refuses %s", (_what, typed) => {
		expect(saveName(typed, "xml").ok).toBe(false);
	});
});

describe("extensionOf", () => {
	it.each([
		["cover.jpg", "jpg"],
		["cover.JPG", "jpg"],
		["a.b.png", "png"],
		["cover", ""],
		[".hidden", ""],
		["cover.", ""],
	])("reads %j as %j", (name, extension) => {
		expect(extensionOf(name)).toBe(extension);
	});
});

describe("isUsable", () => {
	const cases: [what: string, request: PickRequest, entry: FsEntry, usable: boolean][] = [
		["a folder, picking a folder", FOLDER, entry("Sets", true), true],
		["a file, picking a folder", FOLDER, entry("a.mp3"), false],
		["a folder, picking a file", PICTURE, entry("Covers", true), true],
		["a picture, picking a picture", PICTURE, entry("cover.JPEG"), true],
		["a song, picking a picture", PICTURE, entry("a.mp3"), false],
		["a folder, saving", SAVE, entry("Exports", true), true],
		["a file of the saved kind, saving", SAVE, entry("old.xml"), true],
		["another file, saving", SAVE, entry("a.mp3"), false],
	];
	it.each(cases)("%s", (_what, request, candidate, usable) => {
		expect(isUsable(candidate, request)).toBe(usable);
	});
});

describe("visibleEntries", () => {
	const entries = [entry("Covers", true), entry("cover.png"), entry("a.mp3"), entry("Notes.txt")];
	const names = (request: PickRequest, filter: string) =>
		visibleEntries(entries, request, filter).map((e) => e.name);

	it("shows every file when picking a folder, so its contents can be recognised", () => {
		expect(names(FOLDER, "")).toEqual(["Covers", "cover.png", "a.mp3", "Notes.txt"]);
	});

	it("leaves out files that cannot be picked", () => {
		expect(names(PICTURE, "")).toEqual(["Covers", "cover.png"]);
	});

	it("keeps names containing the filter, in any case", () => {
		expect(names(FOLDER, " COV ")).toEqual(["Covers", "cover.png"]);
	});
});

describe("existingEntry", () => {
	it("finds a name in any case, as the file system would", () => {
		const entries = [entry("Library.XML")];
		expect(existingEntry(entries, "library.xml")?.name).toBe("Library.XML");
		expect(existingEntry(entries, "other.xml")).toBeUndefined();
	});
});

describe("pickPath", () => {
	it("resolves to the answer", async () => {
		const picked = pickPath(FOLDER);
		answerPick("/Users/dj/Music");
		await expect(picked).resolves.toBe("/Users/dj/Music");
	});

	it("cancels a picker that another one replaces", async () => {
		const first = pickPath(FOLDER);
		const second = pickPath(SAVE);
		await expect(first).resolves.toBeNull();
		answerPick(null);
		await expect(second).resolves.toBeNull();
	});
});

describe("saveDecision", () => {
	const entries = [entry("Library.xml"), entry("Sets.xml", true)];
	const cases: [what: string, typed: string, replaceAsked: boolean, decision: string][] = [
		["a new name is saved", "fresh", false, "save"],
		["a taken name asks first", "library", false, "askReplace"],
		["a taken name is replaced once asked", "library", true, "save"],
		["a folder's name is never replaced", "sets", true, "problem"],
		["a bad name is refused", "a/b", false, "problem"],
	];
	it.each(cases)("%s", (_what, typed, replaceAsked, decision) => {
		expect(saveDecision(typed, "xml", entries, replaceAsked).kind).toBe(decision);
	});
});

describe("pickTarget", () => {
	const cases: [
		what: string,
		request: PickRequest,
		file: string | null,
		typed: string,
		target: string | null,
	][] = [
		["a folder pick hands back the open folder", FOLDER, null, "", "/Users/dj"],
		["a file pick waits for a file", PICTURE, null, "", null],
		["a file pick hands back the file", PICTURE, "cover.png", "", "/Users/dj/cover.png"],
		["a save hands back the named file", SAVE, null, "library", "/Users/dj/library.xml"],
		["a save waits for a usable name", SAVE, null, "a/b", null],
	];
	it.each(cases)("%s", (_what, request, file, typed, target) => {
		expect(pickTarget(request, "/Users/dj", file, typed)).toBe(target);
	});
});
