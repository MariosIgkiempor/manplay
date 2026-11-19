import { describe, expect, it } from "vitest";
import { pickRows } from "#/lib/folder-pick.ts";

const listed = new Map<string, readonly string[]>([
	["/m", ["house", "Disco", "techno"]],
	["/m/house", ["deep", "acid"]],
	["/m/techno", ["minimal"]],
]);

describe("pickRows", () => {
	it.each<{ name: string; expanded: string[]; filter: string; expected: [string, number][] }>([
		{
			name: "the folders beside the crumb, by name",
			expanded: [],
			filter: "",
			expected: [
				["/m/Disco", 0],
				["/m/house", 0],
				["/m/techno", 0],
			],
		},
		{
			name: "an opened folder's subfolders under it",
			expanded: ["/m/house"],
			filter: "",
			expected: [
				["/m/Disco", 0],
				["/m/house", 0],
				["/m/house/acid", 1],
				["/m/house/deep", 1],
				["/m/techno", 0],
			],
		},
		{
			name: "a filter keeps matching names at any depth, ignoring case",
			expanded: ["/m/house", "/m/techno"],
			filter: "DE",
			expected: [["/m/house/deep", 1]],
		},
		{
			name: "an opened folder not listed yet shows nothing under it",
			expanded: ["/m/Disco"],
			filter: "",
			expected: [
				["/m/Disco", 0],
				["/m/house", 0],
				["/m/techno", 0],
			],
		},
	])("$name", ({ expanded, filter, expected }) => {
		expect(pickRows("/m", listed, new Set(expanded), filter).map((r) => [r.path, r.depth])).toEqual(
			expected,
		);
	});
});
