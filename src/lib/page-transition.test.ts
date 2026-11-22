import { describe, expect, it } from "vitest";
import { directionTo, type PageDirection, type RowBox } from "#/lib/page-transition.ts";

const current: RowBox = { top: 100, bottom: 130 };

describe("directionTo", () => {
	it.each<[string, number, RowBox | null, PageDirection | null]>([
		["below the current row", 200, current, "down"],
		["just below its bottom edge", 131, current, "down"],
		["above the current row", 40, current, "up"],
		["just above its top edge", 99, current, "up"],
		["on the current row", 115, current, null],
		["on its top edge", 100, current, null],
		["with no current row", 40, null, "down"],
	])("a click %s", (_, clickY, box, expected) => {
		expect(directionTo(clickY, box)).toBe(expected);
	});
});
