import { describe, expect, it } from "vitest";
import { addMemory, barBeat, defaultColor, sameCues, setHot, snap, stamp } from "#/lib/cues.ts";

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
		expect(one).toEqual([{ slot: 2, start: 10, name: "", color: defaultColor(2) }]);
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
});
