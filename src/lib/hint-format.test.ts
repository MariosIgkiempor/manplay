import { describe, expect, it } from "vitest";
import { parseHint, repeatsVisibleText } from "#/lib/hint-format.ts";

describe("parseHint", () => {
	it.each([
		{ text: "Artist", expected: { title: "Artist", detail: [], keys: null } },
		{ text: "Add a key", expected: { title: "Add a key", detail: [], keys: null } },
		{ text: "  Rename  ", expected: { title: "Rename", detail: [], keys: null } },
		{ text: "Collapse sidebar.", expected: { title: "Collapse sidebar", detail: [], keys: null } },
		{ text: "", expected: { title: "", detail: [], keys: null } },
	])("keeps the short hint $text simple", ({ text, expected }) => {
		expect(parseHint(text)).toEqual(expected);
	});

	it.each([
		{ text: "Undo delete (⌘Z)", title: "Undo delete", keys: "⌘Z" },
		{ text: "Undo delete (Ctrl+Z)", title: "Undo delete", keys: "Ctrl+Z" },
		{ text: "Keyboard shortcuts (?)", title: "Keyboard shortcuts", keys: "?" },
		{ text: "Clear filter (Esc)", title: "Clear filter", keys: "Esc" },
		{ text: "Rename (F2)", title: "Rename", keys: "F2" },
		{ text: "Collapse sidebar (⌘\\)", title: "Collapse sidebar", keys: "⌘\\" },
	])("takes the key off $text", ({ text, title, keys }) => {
		expect(parseHint(text)).toEqual({ title, detail: [], keys });
	});

	it.each([
		"Stop analysis (results so far are kept)",
		"Delete 1 file (backed up first)",
		"Read by players (CDJ, XDJ)",
	])("leaves the aside in %j where it is", (text) => {
		expect(parseHint(text)).toEqual({ title: text, detail: [], keys: null });
	});

	it.each([
		{
			text: "Show songs with “House”. Double-click to rename.",
			expected: {
				title: "Show songs with “House”",
				detail: ["Double-click to rename."],
				keys: null,
			},
		},
		{
			text: "Off: manplay stops looking in this folder. Nothing is removed.",
			expected: {
				title: "Off: manplay stops looking in this folder",
				detail: ["Nothing is removed."],
				keys: null,
			},
		},
		{
			text: "Shared library: tags, playlists and analysis sync through here",
			expected: {
				title: "Shared library",
				detail: ["tags, playlists and analysis sync through here"],
				keys: null,
			},
		},
		{
			text: "Click to change the cover, or paste one (⌘V)",
			expected: { title: "Click to change the cover, or paste one", detail: [], keys: "⌘V" },
		},
		{
			text: "Synced\nOn studio-nas\nOn R2",
			expected: { title: "Synced", detail: ["On studio-nas", "On R2"], keys: null },
		},
		{
			text: "studio-nas: Music / DJ Library",
			expected: { title: "studio-nas", detail: ["Music / DJ Library"], keys: null },
		},
		{
			text: "/Users/dj/Music/Library/a very long path that is no title: x",
			expected: {
				title: "/Users/dj/Music/Library/a very long path that is no title: x",
				detail: [],
				keys: null,
			},
		},
		{
			text: "Finished at 0:37, took 2s",
			expected: { title: "Finished at 0:37, took 2s", detail: [], keys: null },
		},
	])("splits $text into a title and its detail", ({ text, expected }) => {
		expect(parseHint(text)).toEqual(expected);
	});
});

describe("repeatsVisibleText", () => {
	it.each([
		{ hint: "Balearic Letters", visible: "Balearic Letters", expected: true },
		{ hint: "Balearic  Letters", visible: " balearic letters\n", expected: true },
		{ hint: "Open Balearic Letters", visible: "Balearic Letters", expected: false },
		{ hint: "Metadata", visible: "", expected: false },
		{ hint: "", visible: "", expected: false },
	])("$hint over $visible: $expected", ({ hint, visible, expected }) => {
		expect(repeatsVisibleText(hint, visible)).toBe(expected);
	});
});
