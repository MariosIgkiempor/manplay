import { describe, expect, it } from "vitest";
import type { FieldMerge, Resolution } from "#/lib/api.ts";
import {
	classifyTagChange,
	type FieldDiff,
	fieldDiff,
	mergeDiffs,
	type TagChangeKind,
	type TagPart,
	type TagValue,
	tagDiffs,
} from "#/lib/tag-change.ts";

describe("classifyTagChange", () => {
	it.each<{ name: string; from: TagValue; to: TagValue; expected: TagChangeKind | null }>([
		{ name: "an empty tag that gets a value is added", from: null, to: "House", expected: "added" },
		{ name: "blank text counts as empty", from: "  ", to: "House", expected: "added" },
		{ name: "a value that goes away is removed", from: "House", to: null, expected: "removed" },
		{ name: "a value cleared to blank is removed", from: "House", to: "", expected: "removed" },
		{ name: "one value for another is changed", from: "128", to: "127.5", expected: "changed" },
		{ name: "a change of case is a change", from: "house", to: "House", expected: "changed" },
		{ name: "the same value is no change", from: "House", to: "House", expected: null },
		{ name: "empty to empty is no change", from: null, to: "", expected: null },
	])("$name", ({ from, to, expected }) => {
		expect(classifyTagChange(from, to)).toBe(expected);
	});
});

describe("fieldDiff", () => {
	it.each<{
		name: string;
		field: string;
		from: TagValue;
		to: TagValue;
		expected: TagPart[] | null;
	}>([
		{
			name: "a value for an empty tag is added",
			field: "genre",
			from: null,
			to: "Techno",
			expected: [{ kind: "added", value: "Techno" }],
		},
		{
			name: "a cleared tag is removed",
			field: "comment",
			from: "peak",
			to: null,
			expected: [{ kind: "removed", value: "peak" }],
		},
		{
			name: "one value for another is a rename",
			field: "bpm",
			from: "128",
			to: "127.5",
			expected: [{ kind: "renamed", from: "128", to: "127.5" }],
		},
		{
			name: "a credit split into names removes the joined one and adds each name",
			field: "artist",
			from: "Bow Street Runner & Lavery",
			to: "Bow Street Runner; Lavery",
			expected: [
				{ kind: "added", value: "Bow Street Runner" },
				{ kind: "added", value: "Lavery" },
				{ kind: "removed", value: "Bow Street Runner & Lavery" },
			],
		},
		{
			name: "names that stay are kept beside the ones that come and go",
			field: "artist",
			from: "A; B",
			to: "B; C; D",
			expected: [
				{ kind: "kept", value: "B" },
				{ kind: "added", value: "C" },
				{ kind: "added", value: "D" },
				{ kind: "removed", value: "A" },
			],
		},
		{
			name: "one name swapped for another in a list is a rename in place",
			field: "artist",
			from: "A; Bicep",
			to: "A; BICEP",
			expected: [
				{ kind: "kept", value: "A" },
				{ kind: "renamed", from: "Bicep", to: "BICEP" },
			],
		},
		{
			name: "a reorder of the same names is a rename of the whole value",
			field: "artist",
			from: "A; B",
			to: "B; A",
			expected: [{ kind: "renamed", from: "A; B", to: "B; A" }],
		},
		{
			name: "a tag that is not a list is one value, separators and all",
			field: "title",
			from: "A; B",
			to: "A; C",
			expected: [{ kind: "renamed", from: "A; B", to: "A; C" }],
		},
		{ name: "no change has no pills", field: "genre", from: "House", to: "House", expected: null },
	])("$name", ({ field, from, to, expected }) => {
		expect(fieldDiff(field, from, to)?.parts ?? null).toEqual(expected);
	});

	it("tagDiffs skips tags that do not change and keeps the order", () => {
		expect(
			tagDiffs([
				{ field: "bpm", from: "128", to: "127.5" },
				{ field: "key", from: "8A", to: "8A" },
				{ field: "genre", from: null, to: "Techno" },
			]).map((d) => d.field),
		).toEqual(["bpm", "genre"]);
	});
});

describe("mergeDiffs", () => {
	const fields: FieldMerge[] = [
		{ field: "label", base: "Warp", mine: "Ninja Tune", theirs: "Warp", side: "mine" },
		{ field: "year", base: null, mine: null, theirs: "1999", side: "theirs" },
		{ field: "bpm", base: "120", mine: "121", theirs: "122", side: null },
	];
	it.each<{ name: string; choice: Resolution | undefined; expected: FieldDiff[] }>([
		{
			name: "a field waiting for a choice has no pills yet",
			choice: undefined,
			expected: [
				{ field: "label", parts: [{ kind: "renamed", from: "Warp", to: "Ninja Tune" }] },
				{ field: "year", parts: [{ kind: "added", value: "1999" }] },
			],
		},
		{
			name: "a chosen side shows what the merged file gets",
			choice: { fields: { bpm: "theirs" } },
			expected: [
				{ field: "label", parts: [{ kind: "renamed", from: "Warp", to: "Ninja Tune" }] },
				{ field: "year", parts: [{ kind: "added", value: "1999" }] },
				{ field: "bpm", parts: [{ kind: "renamed", from: "120", to: "122" }] },
			],
		},
	])("$name", ({ choice, expected }) => {
		expect(mergeDiffs(fields, choice)).toEqual(expected);
	});
});
