import { describe, expect, it } from "vitest";
import { beatsToQueue, heardLatency } from "#/lib/use-metronome.ts";

const grid = { bpm: 120, firstBeat: 0, barOffset: 0 };
const times = (r: ReturnType<typeof beatsToQueue>) => r.beats.map((b) => b.time);

describe("beatsToQueue", () => {
	it("queues the beats coming up, once each", () => {
		const first = beatsToQueue(grid, 9.9, 9.9);
		expect(times(first)).toEqual([10]);
		const second = beatsToQueue(grid, first.queuedTo, 9.95);
		expect(times(second)).toEqual([]);
		const third = beatsToQueue(grid, second.queuedTo, 10.4);
		expect(times(third)).toEqual([10.5]);
	});

	it.each([
		{ name: "a seek back", queuedTo: 60, now: 9.9 },
		{ name: "a seek on", queuedTo: 5, now: 9.9 },
	])("starts again from the song's position after $name", ({ queuedTo, now }) => {
		const r = beatsToQueue(grid, queuedTo, now);
		expect(times(r)).toEqual([10]);
		expect(r.queuedTo).toBeCloseTo(now + 0.15);
	});

	it("skips beats already past", () => {
		expect(times(beatsToQueue(grid, 9.7, 10.05))).toEqual([]);
	});
});

describe("heardLatency", () => {
	it.each([
		{ name: "both reported", ctx: { baseLatency: 0.01, outputLatency: 0.2 }, seconds: 0.21 },
		{ name: "only the base", ctx: { baseLatency: 0.01 }, seconds: 0.01 },
		{ name: "nothing", ctx: {}, seconds: 0 },
		{ name: "not a number", ctx: { baseLatency: Number.NaN, outputLatency: 0.2 }, seconds: 0.2 },
		{ name: "negative", ctx: { baseLatency: -1, outputLatency: 0.05 }, seconds: 0.05 },
	])("adds up the delay with $name", ({ ctx, seconds }) => {
		expect(heardLatency(ctx)).toBeCloseTo(seconds);
	});
});
