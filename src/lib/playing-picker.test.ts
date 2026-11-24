import { describe, expect, it } from "vitest";
import { PICK_LIMIT, type PickSource, pickerKey, pickRows } from "#/lib/playing-picker.ts";

const source = (name: string, checked = false): PickSource => ({ name, count: 3, checked });
const PLAYLISTS = [source("Warm up"), source("Peak time")];
const TAGS = [source("House", true), source("House/Deep"), source("Techno")];

const summary = (query: string) =>
	pickRows(query, PLAYLISTS, TAGS).map((r) => `${r.kind}:${r.name}${r.isNew ? "+" : ""}`);

describe("pickRows", () => {
	it.each([
		{
			query: "",
			rows: ["playlist:Warm up", "playlist:Peak time", "tag:House", "tag:House/Deep", "tag:Techno"],
		},
		{ query: "house", rows: ["tag:House", "tag:House/Deep", "playlist:house+"] },
		{ query: "  HOUSE ", rows: ["tag:House", "tag:House/Deep", "playlist:HOUSE+"] },
		{ query: "time", rows: ["playlist:Peak time", "playlist:time+", "tag:time+"] },
		{ query: "warm up", rows: ["playlist:Warm up", "tag:warm up+"] },
		{ query: "Disco", rows: ["playlist:Disco+", "tag:Disco+"] },
	])("lists $query as $rows", ({ query, rows }) => {
		expect(summary(query)).toEqual(rows);
	});

	it("keeps whether the song already has a tag", () => {
		const house = pickRows("house", PLAYLISTS, TAGS).find((r) => r.name === "House");
		expect(house?.checked).toBe(true);
	});

	it("shows at most PICK_LIMIT of each kind", () => {
		const many = Array.from({ length: PICK_LIMIT + 4 }, (_, i) => source(`Set ${i}`));
		const rows = pickRows("set", many, many);
		expect(rows.filter((r) => r.kind === "playlist" && !r.isNew)).toHaveLength(PICK_LIMIT);
		expect(rows.filter((r) => r.kind === "tag" && !r.isNew)).toHaveLength(PICK_LIMIT);
	});
});

describe("pickerKey", () => {
	const press = (key: string, code: string, ctrlKey = false) => ({ key, code, ctrlKey });
	it.each([
		{ name: "↓", event: press("ArrowDown", "ArrowDown"), expected: { kind: "step", by: 1 } },
		{ name: "↑", event: press("ArrowUp", "ArrowUp"), expected: { kind: "step", by: -1 } },
		{ name: "Ctrl+J", event: press("j", "KeyJ", true), expected: { kind: "step", by: 1 } },
		{ name: "Ctrl+K", event: press("k", "KeyK", true), expected: { kind: "step", by: -1 } },
		{ name: "Ctrl+N", event: press("n", "KeyN", true), expected: { kind: "step", by: 1 } },
		{ name: "Ctrl+P", event: press("p", "KeyP", true), expected: { kind: "step", by: -1 } },
		{ name: "Enter", event: press("Enter", "Enter"), expected: { kind: "pick" } },
		{ name: "Escape", event: press("Escape", "Escape"), expected: { kind: "escape" } },
		{ name: "j typed", event: press("j", "KeyJ"), expected: null },
		{ name: "k typed", event: press("k", "KeyK"), expected: null },
	])("reads $name", ({ event, expected }) => {
		expect(pickerKey(event)).toEqual(expected);
	});
});
