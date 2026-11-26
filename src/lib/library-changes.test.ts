import { describe, expect, it } from "vitest";
import type { LibraryChange } from "#/lib/api.ts";
import { changedBy, changeFacts, changeTitle } from "#/lib/library-changes.ts";

const PLAIN: LibraryChange = {
	kind: "playlist",
	name: "Warmup",
	standing: "existing",
	renamedFrom: null,
	mergedInto: null,
	rulesChanged: false,
	songsAdded: 0,
	songsRemoved: 0,
	songsMoved: 0,
	count: 0,
};

describe("changeFacts", () => {
	it.each<[string, Partial<LibraryChange>, string[]]>([
		["a new list with songs", { standing: "created", songsAdded: 3 }, ["New", "3 songs added"]],
		["one song each way", { songsAdded: 1, songsRemoved: 1 }, ["1 song added", "1 song removed"]],
		["a reorder", { songsMoved: 2 }, ["2 songs moved"]],
		["a rename", { renamedFrom: "Opening" }, ["Renamed from Opening"]],
		["a merge", { kind: "tag", mergedInto: "House" }, ["Merged into House"]],
		["a delete", { standing: "deleted" }, ["Deleted"]],
		["a restore", { standing: "restored", songsAdded: 4 }, ["Restored", "4 songs added"]],
		["new rules", { kind: "smart_playlist", rulesChanged: true }, ["Rules changed"]],
		["analysis", { kind: "analysis", name: "", count: 1200 }, ["1,200 songs"]],
		["one value", { kind: "tag_custom", name: "", count: 1 }, ["1 value"]],
		["retagged songs", { kind: "song_tags", name: "", count: 2 }, ["2 songs"]],
		["songs with another cover", { kind: "covers", name: "", count: 1 }, ["1 song"]],
		["songs moved", { kind: "songs_moved", name: "", count: 4 }, ["4 songs"]],
		["songs added", { kind: "songs_added", name: "", count: 1 }, ["1 song"]],
		["nothing worth a fact", {}, []],
	])("%s", (_name, change, facts) => {
		expect(changeFacts({ ...PLAIN, ...change })).toEqual(facts);
	});
});

describe("changeTitle", () => {
	it.each<[Partial<LibraryChange>, string]>([
		[{ name: "Warmup" }, "Warmup"],
		[{ name: "" }, "Unnamed"],
		[{ kind: "analysis", name: "" }, "BPM, key and beat grids"],
		[{ kind: "tag_custom", name: "" }, "Tag Database values"],
		[{ kind: "song_tags", name: "" }, "Tags in the songs' files"],
		[{ kind: "covers", name: "" }, "Covers"],
		[{ kind: "songs_moved", name: "" }, "Songs moved or renamed"],
		[{ kind: "songs_added", name: "" }, "Songs added"],
	])("%o", (change, title) => {
		expect(changeTitle({ ...PLAIN, ...change })).toBe(title);
	});
});

describe("changedBy", () => {
	it.each<[string[], string]>([
		[[], "Another device"],
		[["studio-mac"], "studio-mac"],
		[["booth", "studio-mac"], "booth and studio-mac"],
		[["a", "b", "c"], "3 devices"],
	])("%j", (by, text) => {
		expect(changedBy(by)).toBe(text);
	});
});
