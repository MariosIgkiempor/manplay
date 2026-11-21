import { describe, expect, it } from "vitest";
import type { TrackAnalysis } from "#/lib/api.ts";
import { barsBetween, beatsBetween, column, columnsOf, overview } from "#/lib/waveform.ts";

const analysis = (over: Partial<TrackAnalysis> = {}): TrackAnalysis => ({
	gridBpm: 120,
	firstBeat: 0.25,
	barOffset: 3,
	duration: 10,
	rate: 150,
	detail: [],
	...over,
});

describe("waveform", () => {
	it("unpacks CDJ columns", () => {
		expect(column((7 << 5) | 31)).toEqual({ height: 1, white: 1 });
		expect(column(0)).toEqual({ height: 0, white: 0 });
	});

	it("summarises the detail into an overview", () => {
		const detail = [...new Array(50).fill(31), ...new Array(50).fill(0)];
		const cols = overview(detail, 2);
		expect(cols.map((c) => c.height)).toEqual([1, 0]);
		expect(overview([], 10)).toEqual([]);
	});

	it("lays out the beat grid with downbeats", () => {
		const beats = beatsBetween(analysis(), 0, 2);
		expect(beats.map((b) => b.time)).toEqual([0.25, 0.75, 1.25, 1.75]);
		// The first beat is the fourth of its bar, so the next one starts a bar.
		expect(beats.map((b) => b.downbeat)).toEqual([false, true, false, false]);
		expect(beatsBetween(analysis(), 9.6, 20).map((b) => b.time)).toEqual([9.75]);
		expect(beatsBetween(analysis({ gridBpm: null }), 0, 10)).toEqual([]);
	});
});

describe("waveform bars", () => {
	const detail = [1, 5, 3, 31, 2, (7 << 5) | 20, 4, 4];

	it("unpacks a detail once", () => {
		const columns = columnsOf(detail);
		expect(columnsOf(detail)).toBe(columns);
		expect([...columns.whites]).toEqual([0, 0, 0, 0, 0, 7, 0, 0]);
		expect(columns.heights[3]).toBe(1);
	});

	it.each([
		{ group: 1, first: 2, last: 4, indexes: [2, 3, 4] },
		{ group: 2, first: 3, last: 5, indexes: [2, 4] },
		{ group: 4, first: 5, last: 7, indexes: [4] },
		{ group: 4, first: 0, last: 100, indexes: [0, 4] },
	])("groups $group columns to a bar from fixed places", ({ group, first, last, indexes }) => {
		const bars = barsBetween(columnsOf(detail), first, last, group);
		expect(bars.map((bar) => bar.index)).toEqual(indexes);
	});

	it("makes a bar as tall and as white as its loudest column", () => {
		const [low, high] = barsBetween(columnsOf(detail), 0, 7, 4);
		expect(low).toMatchObject({ height: 1, white: 0 });
		expect(high?.white).toBe(7);
		expect(high?.height).toBeCloseTo(20 / 31);
	});

	it("numbers the bars of the grid", () => {
		const beats = beatsBetween(analysis(), 0, 3);
		expect(beats.map((beat) => beat.bar)).toEqual([1, 2, 2, 2, 2, 3]);
	});
});
