import { describe, expect, it } from "vitest";
import type { TrackAnalysis } from "#/lib/api.ts";
import { beatsBetween, column, overview } from "#/lib/waveform.ts";

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
