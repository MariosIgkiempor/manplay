import { describe, expect, it } from "vitest";
import type { Box } from "#/lib/bubble-position.ts";
import { type ActionAnchor, ANCHOR_FRESH_MS, freshAnchor, litBoxes } from "./action-anchor.ts";

const anchor: ActionAnchor = {
	box: { left: 10, top: 20, width: 200, height: 28 },
	element: true,
	target: null,
	alsoSelected: [],
	at: 1000,
};

describe("freshAnchor", () => {
	const cases: [what: string, anchor: ActionAnchor | null, now: number, fresh: boolean][] = [
		["no action yet", null, 1000, false],
		["asked straight after the press", anchor, 1000, true],
		["asked after a short wait (a menu, a slow check)", anchor, 1000 + ANCHOR_FRESH_MS, true],
		["asked long after the press", anchor, 1001 + ANCHOR_FRESH_MS, false],
		["a clock that went backwards", anchor, 999, false],
	];
	it.each(cases)("%s", (_what, given, now, fresh) => {
		expect(freshAnchor(given, now)).toBe(fresh ? given : null);
	});
});

describe("litBoxes", () => {
	const second: Box = { left: 10, top: 48, width: 200, height: 28 };
	const third: Box = { left: 10, top: 76, width: 200, height: 28 };
	const row = {} as Element;
	const cases: [what: string, anchor: ActionAnchor, lit: Box[]][] = [
		["one row", anchor, [anchor.box]],
		[
			"a row with others selected",
			{
				...anchor,
				alsoSelected: [
					{ box: second, target: row },
					{ box: third, target: row },
				],
			},
			[anchor.box, second, third],
		],
		["a press on nothing in particular", { ...anchor, element: false }, []],
	];
	it.each(cases)("%s", (_what, given, lit) => {
		expect(litBoxes(given)).toEqual(lit);
	});
});
