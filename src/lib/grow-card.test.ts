import { describe, expect, it } from "vitest";
import {
	drawnAs,
	placeInLayer,
	placeInWindow,
	type ScreenBox,
	windowCentre,
} from "#/lib/grow-card.ts";

const LAYER: ScreenBox = { left: 100, top: 50, width: 1000, height: 800 };
const originAt = (left: number, top = 250): ScreenBox => ({ left, top, width: 180, height: 180 });
const UNSCROLLED = { left: 0, top: 0 };

describe("placeInLayer", () => {
	it.each([
		["an origin in the middle: just outside the origin's corner", 400, 600, 284],
		["the first tile: held inside the layer's left edge", 100, 600, 8],
		["the last tile: moved left to stay inside", 920, 600, 1000 - 8 - 600],
	])("%s", (_, originLeft, wanted, left) => {
		expect(placeInLayer(originAt(originLeft), LAYER, UNSCROLLED, wanted)).toEqual({
			left,
			top: 184,
			width: wanted,
		});
	});

	it("is no wider than the layer", () => {
		const narrow: ScreenBox = { ...LAYER, width: 400 };
		expect(placeInLayer(originAt(100), narrow, UNSCROLLED, 600)).toEqual({
			left: 8,
			top: 184,
			width: 384,
		});
	});

	it("counts how far the layer is scrolled", () => {
		expect(placeInLayer(originAt(400), LAYER, { left: 0, top: 1200 }, 600).top).toBe(1384);
	});

	it("reaches as far as it is told, so a picture inside the card lines up with the origin", () => {
		const place = placeInLayer(originAt(400), LAYER, UNSCROLLED, 600, { x: 25, y: 60 });
		expect(place).toEqual({ left: 275, top: 140, width: 600 });
	});

	it("does not start above the layer's top", () => {
		expect(placeInLayer(originAt(400, 50), LAYER, UNSCROLLED, 600).top).toBe(8);
	});
});

describe("placeInWindow", () => {
	const WINDOW = { width: 1280, height: 820 };
	it.each([
		["an origin with room around it", { left: 300, top: 200 }, { left: 284, top: 184 }],
		[
			"an origin at the bottom (the player): raised to fit",
			{ left: 20, top: 760 },
			{ left: 8, top: 412 },
		],
		["an origin at the right edge: moved left", { left: 1200, top: 100 }, { left: 672, top: 84 }],
	])("%s", (_, at, place) => {
		const origin = { ...at, width: 40, height: 40 };
		expect(placeInWindow(origin, WINDOW, 600, 400)).toEqual({ ...place, width: 600 });
	});

	it("a card taller than the window starts at its top", () => {
		const origin = { left: 300, top: 400, width: 40, height: 40 };
		expect(placeInWindow(origin, WINDOW, 600, 2000).top).toBe(8);
	});
});

describe("windowCentre", () => {
	it("is a small box centred across the window", () => {
		const box = windowCentre({ width: 1000, height: 900 });
		expect(box.left + box.width / 2).toBe(500);
	});
});

describe("drawnAs", () => {
	const card: ScreenBox = { left: 100, top: 100, width: 600, height: 400 };
	it.each([
		["itself", card, "translate(0px, 0px) scale(1, 1)"],
		[
			"a smaller box elsewhere",
			{ left: 160, top: 80, width: 150, height: 100 },
			"translate(60px, -20px) scale(0.25, 0.25)",
		],
	])("draws a box as %s", (_, as, transform) => {
		expect(drawnAs(card, as)).toBe(transform);
	});

	it("does not scale a box with no size", () => {
		expect(drawnAs({ left: 0, top: 0, width: 0, height: 0 }, card)).toBe(
			"translate(100px, 100px) scale(1, 1)",
		);
	});
});
