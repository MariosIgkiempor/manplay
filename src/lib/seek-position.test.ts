import { describe, expect, it } from "vitest";
import { seekSeconds } from "#/lib/seek-position.ts";

describe("seekSeconds", () => {
	const bar = { left: 100, width: 400 };
	it.each<{ name: string; pointerX: number; expected: number }>([
		{ name: "left edge", pointerX: 100, expected: 0 },
		{ name: "a tenth in", pointerX: 140, expected: 20 },
		{ name: "middle", pointerX: 300, expected: 100 },
		{ name: "nine tenths in", pointerX: 460, expected: 180 },
		{ name: "right edge", pointerX: 500, expected: 200 },
		{ name: "left of the bar", pointerX: 20, expected: 0 },
		{ name: "right of the bar", pointerX: 900, expected: 200 },
	])("$name", ({ pointerX, expected }) => {
		expect(seekSeconds(pointerX, bar, 200)).toBeCloseTo(expected);
	});

	it.each<{ name: string; width: number; duration: number }>([
		{ name: "no width", width: 0, duration: 200 },
		{ name: "no duration", width: 400, duration: 0 },
	])("$name gives the start", ({ width, duration }) => {
		expect(seekSeconds(300, { left: 100, width }, duration)).toBe(0);
	});
});
