import { describe, expect, it } from "vitest";
import { applyClick, EMPTY_SELECTION, type Selection } from "#/lib/selection.ts";

const ids = [10, 20, 30, 40, 50];
const plain = { shift: false, toggle: false };
const sorted = (s: Selection) => [...s.selected].sort((a, b) => a - b);

describe("applyClick", () => {
	it("plain click selects only that row and sets the anchor", () => {
		const s = applyClick(EMPTY_SELECTION, ids, 30, plain);
		expect(sorted(s)).toEqual([30]);
		expect(s.anchor).toBe(30);
	});

	it("plain click replaces an existing selection", () => {
		const first = applyClick(EMPTY_SELECTION, ids, 10, plain);
		const second = applyClick(first, ids, 40, plain);
		expect(sorted(second)).toEqual([40]);
	});

	it("cmd-click adds and removes individual rows", () => {
		const cmd = { shift: false, toggle: true };
		const a = applyClick(EMPTY_SELECTION, ids, 10, plain);
		const b = applyClick(a, ids, 30, cmd);
		expect(sorted(b)).toEqual([10, 30]);
		const c = applyClick(b, ids, 10, cmd);
		expect(sorted(c)).toEqual([30]);
		expect(c.anchor).toBe(10);
	});

	it("shift-click selects the range from the anchor, in either direction", () => {
		const shift = { shift: true, toggle: false };
		const a = applyClick(EMPTY_SELECTION, ids, 20, plain);
		expect(sorted(applyClick(a, ids, 40, shift))).toEqual([20, 30, 40]);
		expect(sorted(applyClick(a, ids, 10, shift))).toEqual([10, 20]);
	});

	it("shift-click keeps the anchor so the range can be adjusted", () => {
		const shift = { shift: true, toggle: false };
		const a = applyClick(EMPTY_SELECTION, ids, 20, plain);
		const b = applyClick(a, ids, 50, shift);
		const c = applyClick(b, ids, 30, shift);
		expect(sorted(c)).toEqual([20, 30]);
	});

	it("cmd+shift-click adds a range to the existing selection", () => {
		const both = { shift: true, toggle: true };
		const a = applyClick(EMPTY_SELECTION, ids, 10, plain);
		const b = applyClick(a, ids, 30, { shift: false, toggle: true });
		const c = applyClick(b, ids, 50, both);
		expect(sorted(c)).toEqual([10, 30, 40, 50]);
	});

	it("shift-click without an anchor behaves like a plain click", () => {
		const s = applyClick(EMPTY_SELECTION, ids, 40, { shift: true, toggle: false });
		expect(sorted(s)).toEqual([40]);
	});
});
