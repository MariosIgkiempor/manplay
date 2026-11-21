import { describe, expect, it } from "vitest";
import {
	BURST_MS,
	canRedo,
	canUndo,
	record,
	redo,
	replacePresent,
	startHistory,
	undo,
} from "#/lib/edit-history.ts";

const same = (a: number, b: number) => a === b;

describe("edit history", () => {
	it("undoes and redoes edits in order", () => {
		let h = startHistory(1);
		h = record(h, 2, same);
		h = record(h, 3, same);
		h = undo(h);
		expect(h.present).toBe(2);
		h = undo(h);
		expect(h.present).toBe(1);
		expect(canUndo(h)).toBe(false);
		h = redo(h);
		expect(h.present).toBe(2);
		expect(canRedo(h)).toBe(true);
	});

	it("makes no step for an edit that changes nothing", () => {
		const h = startHistory(1);
		expect(record(h, 1, same)).toBe(h);
	});

	it("forgets what was undone once something new is edited", () => {
		const h = record(undo(record(startHistory(1), 2, same)), 5, same);
		expect(h.present).toBe(5);
		expect(canRedo(h)).toBe(false);
	});

	it.each([
		{ name: "the same edit in a burst", second: { group: "tap", at: 500 }, steps: 1 },
		{ name: "the same edit after a pause", second: { group: "tap", at: BURST_MS + 1 }, steps: 2 },
		{ name: "another edit in a burst", second: { group: "nudge", at: 500 }, steps: 2 },
	])("counts $name as $steps undo steps", ({ second, steps }) => {
		let h = record(startHistory(0), 1, same, { group: "tap", at: 0 });
		h = record(h, 2, same, second);
		expect(h.past.length).toBe(steps);
	});

	it("starts a new step after an undo even in a burst", () => {
		let h = record(startHistory(0), 1, same, { group: "tap", at: 0 });
		h = record(h, 2, same, { group: "tap", at: 100 });
		h = undo(h);
		h = record(h, 3, same, { group: "tap", at: 200 });
		expect(h.past).toEqual([0]);
	});

	it("swaps the present without an undo step", () => {
		const h = replacePresent(record(startHistory(1), 2, same), 20);
		expect(h.present).toBe(20);
		expect(undo(h).present).toBe(1);
	});
});
