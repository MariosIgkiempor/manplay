import { describe, expect, it } from "vitest";
import { type Box, type BubbleSide, bubblePosition } from "./bubble-position.ts";

const VIEWPORT = { width: 1000, height: 600 };
const BUBBLE = { width: 100, height: 20 };
const box = (left: number, top: number, width = 40, height = 20): Box => ({
	left,
	top,
	width,
	height,
});

describe("bubblePosition", () => {
	const cases: [
		what: string,
		anchor: Box,
		preferred: BubbleSide,
		expected: { left: number; top: number; side: BubbleSide },
	][] = [
		["sits centred above", box(480, 300), "top", { left: 450, top: 274, side: "top" }],
		["sits below when asked", box(480, 300), "bottom", { left: 450, top: 326, side: "bottom" }],
		["drops below at the top edge", box(480, 4), "top", { left: 450, top: 30, side: "bottom" }],
		[
			"rises above at the bottom edge",
			box(480, 576),
			"bottom",
			{ left: 450, top: 550, side: "top" },
		],
		["stays inside the left edge", box(0, 300), "top", { left: 8, top: 274, side: "top" }],
		["stays inside the right edge", box(980, 300), "top", { left: 892, top: 274, side: "top" }],
	];
	it.each(cases)("%s", (_what, anchor, preferred, expected) => {
		expect(bubblePosition(anchor, BUBBLE, VIEWPORT, preferred)).toEqual(expected);
	});

	it("takes the roomier side, inside the window, when it fits on neither", () => {
		const tall = { width: 100, height: 400 };
		const position = bubblePosition(box(480, 200), tall, VIEWPORT);
		expect(position.side).toBe("bottom");
		expect(position.top + tall.height).toBeLessThanOrEqual(VIEWPORT.height - 8);
	});

	it("keeps a bubble wider than the window at the left margin", () => {
		expect(bubblePosition(box(480, 300), { width: 2000, height: 20 }, VIEWPORT).left).toBe(8);
	});
});
