import { describe, expect, it } from "vitest";
import { type GridMove, gridMoveIndex, type ListMove, moveIndex } from "#/lib/list-keys.ts";

describe("moveIndex", () => {
	it.each<{ move: ListMove; at: number; count: number; to: number | null }>([
		{ move: "listNext", at: -1, count: 5, to: 0 },
		{ move: "listNext", at: 0, count: 5, to: 1 },
		{ move: "listNext", at: 4, count: 5, to: 4 },
		{ move: "listExtendNext", at: 2, count: 5, to: 3 },
		{ move: "listPrev", at: -1, count: 5, to: 0 },
		{ move: "listPrev", at: 3, count: 5, to: 2 },
		{ move: "listPrev", at: 0, count: 5, to: 0 },
		{ move: "listExtendPrev", at: 1, count: 5, to: 0 },
		{ move: "listFirst", at: 3, count: 5, to: 0 },
		{ move: "listLast", at: 1, count: 5, to: 4 },
		{ move: "listLast", at: -1, count: 5, to: 4 },
		{ move: "listNext", at: 9, count: 5, to: 0 },
		{ move: "listNext", at: 0, count: 0, to: null },
		{ move: "listLast", at: -1, count: 0, to: null },
	])("$move from $at of $count lands on $to", ({ move, at, count, to }) => {
		expect(moveIndex(move, at, count)).toBe(to);
	});
});

describe("gridMoveIndex", () => {
	// Ten tiles, four to a row: 0-3, 4-7, 8-9.
	it.each<{ move: GridMove; at: number; to: number | null }>([
		{ move: "listNext", at: -1, to: 0 },
		{ move: "listNext", at: 1, to: 5 },
		{ move: "listNext", at: 5, to: 9 },
		{ move: "listNext", at: 7, to: 7 },
		{ move: "listNext", at: 9, to: 9 },
		{ move: "listPrev", at: 9, to: 5 },
		{ move: "listPrev", at: 2, to: 2 },
		{ move: "listOpen", at: 3, to: 4 },
		{ move: "listOpen", at: 9, to: 9 },
		{ move: "listBack", at: 4, to: 3 },
		{ move: "listBack", at: 0, to: 0 },
		{ move: "listFirst", at: 6, to: 0 },
		{ move: "listLast", at: 2, to: 9 },
		{ move: "listLast", at: -1, to: 9 },
	])("$move from $at lands on $to", ({ move, at, to }) => {
		expect(gridMoveIndex(move, at, 10, 4)).toBe(to);
	});

	it("finds nothing in an empty grid", () => {
		expect(gridMoveIndex("listNext", -1, 0, 4)).toBeNull();
	});

	it("reads a grid of no columns as one column", () => {
		expect(gridMoveIndex("listNext", 0, 3, 0)).toBe(1);
	});
});
