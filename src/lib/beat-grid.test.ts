import { describe, expect, it } from "vitest";
import {
	beatsBetween,
	downbeatAt,
	normalize,
	nudge,
	roundBpm,
	setBpm,
	shiftBar,
} from "#/lib/beat-grid.ts";

const g = { bpm: 120, firstBeat: 0.1, barOffset: 0 };

describe("beat grid", () => {
	it("describes a grid from its first beat in the track", () => {
		const n = normalize({ bpm: 120, firstBeat: 1.35, barOffset: 1 });
		expect(n.firstBeat).toBeCloseTo(0.35);
		expect(n.barOffset).toBe(3);
	});

	it("nudges earlier than the start without losing the bar", () => {
		const n = nudge(g, -0.2);
		expect(n.firstBeat).toBeCloseTo(0.4);
		expect(n.barOffset).toBe(1);
	});

	it("puts a downbeat where asked", () => {
		const n = downbeatAt(g, 10.3);
		expect(n.firstBeat).toBeCloseTo(0.3);
		// 10.3 s is 20 beats after 0.3 s: a whole number of bars, so 0.3 s is a downbeat too.
		expect(n.barOffset).toBe(0);
	});

	it("moves the bar start without moving beats", () => {
		expect(shiftBar(g, 1)).toEqual({ ...g, barOffset: 3 });
	});

	it("keeps the beat at the playhead in place when the tempo changes", () => {
		const n = setBpm(g, 125, 30.1);
		const period = 60 / 125;
		const beat = Math.round((30.1 - n.firstBeat) / period);
		expect(n.firstBeat + beat * period).toBeCloseTo(30.1);
	});

	it.each([
		{ bpm: 127.96, whole: 128 },
		{ bpm: 124.49, whole: 124 },
		{ bpm: 128, whole: 128 },
	])("rounds $bpm BPM to $whole, keeping the beat at the playhead", ({ bpm, whole }) => {
		const n = roundBpm({ bpm, firstBeat: 0.2, barOffset: 0 }, 40);
		expect(n.bpm).toBe(whole);
		const period = 60 / whole;
		const beat = Math.round((40 - n.firstBeat) / period);
		expect(Math.abs(n.firstBeat + beat * period - 40)).toBeLessThan(60 / bpm / 2);
	});

	it("leaves a grid without a tempo alone when rounding", () => {
		const none = { bpm: null, firstBeat: 0, barOffset: 0 };
		expect(roundBpm(none, 10)).toBe(none);
	});
});

describe("beatsBetween", () => {
	it("lists the beats in a span, after its start and up to its end", () => {
		const beats = beatsBetween(g, 0.6, 1.6);
		expect(beats.map((b) => b.time)).toEqual([1.1, 1.6].map((t) => expect.closeTo(t)));
	});

	it("marks beat 1 of each bar by the bar offset", () => {
		const beats = beatsBetween({ bpm: 120, firstBeat: 0, barOffset: 1 }, -1, 2.9);
		expect(beats.map((b) => b.downbeat)).toEqual([false, false, false, true, false, false]);
	});

	it.each([
		{ name: "no tempo", grid: { bpm: null, firstBeat: 0, barOffset: 0 }, from: 0, to: 10 },
		{ name: "an empty span", grid: g, from: 5, to: 5 },
		{ name: "a backwards span", grid: g, from: 5, to: 4 },
	])("has no beats for $name", ({ grid, from, to }) => {
		expect(beatsBetween(grid, from, to)).toEqual([]);
	});
});
