import { describe, expect, it } from "vitest";
import {
	addMemory,
	barBeat,
	beforeStart,
	clearStart,
	defaultColor,
	sameCues,
	setHot,
	setStart,
	snap,
	stamp,
	startOf,
} from "#/lib/cues.ts";

const grid = { bpm: 120, firstBeat: 0.5, barOffset: 0 };

describe("cues", () => {
	it("snaps to the nearest beat", () => {
		expect(snap(grid, 1.24)).toBeCloseTo(1);
		expect(snap(grid, 1.26)).toBeCloseTo(1.5);
		expect(snap({ bpm: null, firstBeat: 0, barOffset: 0 }, 1.26)).toBe(1.26);
	});

	it("counts bars and beats from the grid", () => {
		expect(barBeat(grid, 0.5)).toEqual({ bar: 1, beat: 1 });
		expect(barBeat(grid, 2.6)).toEqual({ bar: 2, beat: 1 });
		expect(barBeat({ ...grid, barOffset: 3 }, 0.5)).toEqual({ bar: 1, beat: 4 });
		expect(barBeat(grid, 0.1)).toBeNull();
	});

	it("moves a hot cue, keeping its name and colour", () => {
		const one = setHot([], 2, 10);
		expect(one).toEqual([{ slot: 2, start: 10, name: "", color: defaultColor(2), main: false }]);
		const named = [{ ...one[0], name: "Drop" }];
		expect(setHot(named as never, 2, 20)[0]).toMatchObject({ start: 20, name: "Drop" });
	});

	it("does not stack memory cues on the same spot", () => {
		const one = addMemory([], 5);
		expect(addMemory(one, 5.004)).toHaveLength(1);
		expect(addMemory(one, 6)).toHaveLength(2);
	});

	it("compares regardless of order, and stamps times", () => {
		const a = setHot(addMemory([], 1), 0, 2);
		expect(sameCues(a, [...a].reverse())).toBe(true);
		expect(stamp(62.5)).toBe("1:02.500");
	});

	it("keeps one start cue, which a memory cue already there can become", () => {
		const a = setStart(addMemory([], 4), 4);
		expect(a).toHaveLength(1);
		expect(startOf(a)?.start).toBe(4);
		const moved = setStart(a, 8);
		expect(moved.filter((c) => c.main)).toHaveLength(1);
		expect(startOf(moved)?.start).toBe(8);
		expect(clearStart(moved)).toHaveLength(0);
	});

	it("flags memory cues a player would load before the start", () => {
		const cues = setStart(addMemory([], 2), 8);
		expect(beforeStart(cues).map((c) => c.start)).toEqual([2]);
	});
});
