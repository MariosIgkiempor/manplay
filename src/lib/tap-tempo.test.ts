import { describe, expect, it } from "vitest";
import { addTap, TAP_RUN_GAP, tapTempo } from "#/lib/tap-tempo.ts";

/** Taps every `beat` ms, moved by `jitter[i]` ms each. */
const steady = (count: number, beat: number, jitter: readonly number[] = []) =>
	Array.from({ length: count }, (_, i) => 1000 + i * beat + (jitter[i] ?? 0));

describe("tapTempo", () => {
	it.each([
		{ name: "no taps", taps: [] },
		{ name: "three taps", taps: steady(3, 500) },
		{ name: "taps all at once", taps: [1000, 1000, 1000, 1000] },
	])("has no reading from $name", ({ taps }) => {
		expect(tapTempo(taps)).toBeNull();
	});

	it.each([
		{ name: "even taps", taps: steady(5, 500), bpm: 120 },
		{ name: "even taps at 128", taps: steady(8, 60_000 / 128), bpm: 128 },
		{
			name: "taps a little early and late",
			taps: steady(9, 500, [8, -6, 4, -9, 7, -3, 5, -8, 2]),
			bpm: 120,
		},
	])("reads $bpm BPM from $name", ({ taps, bpm }) => {
		expect(tapTempo(taps)?.bpm).toBeCloseTo(bpm, 0);
	});

	it("leaves out a stumbled tap", () => {
		const taps = steady(8, 500, [0, 0, 0, 180, 0, 0, 0, 0]);
		const reading = tapTempo(taps);
		expect(reading?.bpm).toBeCloseTo(120, 1);
		expect(reading?.taps).toBe(7);
	});

	it("counts a skipped beat as two beats instead of halving the tempo", () => {
		const taps = [1000, 1500, 2000, 3000, 3500, 4000];
		expect(tapTempo(taps)?.bpm).toBeCloseTo(120, 1);
	});

	it("follows the latest taps when the tempo changes", () => {
		const slow = steady(16, 600);
		const last = slow.at(-1) ?? 0;
		const fast = Array.from({ length: 16 }, (_, i) => last + (i + 1) * 500);
		expect(tapTempo([...slow, ...fast])?.bpm).toBeCloseTo(120, 1);
	});
});

describe("addTap", () => {
	it("adds to a run while the taps keep coming", () => {
		expect(addTap([1000, 1500], 2000)).toEqual([1000, 1500, 2000]);
	});

	it("starts a new run after a pause", () => {
		expect(addTap([1000, 1500], 1500 + TAP_RUN_GAP)).toEqual([1500 + TAP_RUN_GAP]);
	});
});
