import { describe, expect, it } from "vitest";
import type { ExportSelection } from "#/lib/api.ts";
import {
	EMPTY_SELECTION,
	type SelectionItem,
	selectionIncludes,
	toggleSelection,
} from "#/lib/export-selection.ts";

const chosen: ExportSelection = {
	...EMPTY_SELECTION,
	playlists: [1, 2],
	smart: [7],
	tags: ["Genre › House"],
};

describe("toggleSelection", () => {
	it.each<[string, SelectionItem, Partial<ExportSelection>]>([
		["adds a playlist", { kind: "playlist", id: 3 }, { playlists: [1, 2, 3] }],
		["takes a playlist out", { kind: "playlist", id: 1 }, { playlists: [2] }],
		["adds a smart playlist", { kind: "smart", id: 8 }, { smart: [7, 8] }],
		["takes a smart playlist out", { kind: "smart", id: 7 }, { smart: [] }],
		["adds a tag", { kind: "tag", name: "Mood" }, { tags: ["Genre › House", "Mood"] }],
		["takes a tag out", { kind: "tag", name: "Genre › House" }, { tags: [] }],
	])("%s and leaves the rest", (_, item, changed) => {
		const next = toggleSelection(chosen, item);
		expect(next).toEqual({ ...chosen, ...changed });
		expect(selectionIncludes(next, item)).toBe(!selectionIncludes(chosen, item));
	});

	it.each<[string, SelectionItem]>([
		["a playlist id that is a smart playlist id", { kind: "smart", id: 1 }],
		["a smart playlist id that is a playlist id", { kind: "playlist", id: 7 }],
	])("keeps kinds apart: %s", (_, item) => {
		expect(selectionIncludes(chosen, item)).toBe(false);
	});
});
