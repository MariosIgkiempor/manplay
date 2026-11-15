import { describe, expect, it } from "vitest";
import { downbeatAt, normalize, nudge, setBpm, shiftBar, tapBpm } from "#/lib/beat-grid.ts";

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

	it("taps a tempo", () => {
		expect(tapBpm([0, 500, 1000])).toBeNull();
		expect(tapBpm([0, 500, 1000, 1500, 2000])).toBe(120);
	});
});
