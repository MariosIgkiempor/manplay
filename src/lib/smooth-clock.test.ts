import { describe, expect, it } from "vitest";
import { createSmoothClock, tick } from "#/lib/smooth-clock.ts";

const FRAME = 1000 / 60;

/** Plays for `frames` frames with an audio clock that only moves every `stepMs`. */
function play(frames: number, stepMs: number): number[] {
	const clock = createSmoothClock(10, 0);
	const shown: number[] = [];
	for (let frame = 1; frame <= frames; frame++) {
		const nowMs = frame * FRAME;
		const audio = 10 + (Math.floor(nowMs / stepMs) * stepMs) / 1000;
		shown.push(tick(clock, audio, nowMs, true));
	}
	return shown;
}

describe("smooth clock", () => {
	it("keeps moving between the audio's coarse updates", () => {
		const clock = createSmoothClock(10, 0);
		tick(clock, 10, 0, true);
		// The audio still reports 10 s a frame later; the clock moves on regardless.
		expect(tick(clock, 10, 16, true)).toBeGreaterThan(10.01);
	});

	it("never steps backwards for a small correction", () => {
		const clock = createSmoothClock(10, 0);
		tick(clock, 10, 0, true);
		expect(tick(clock, 9.95, 16, true)).toBeGreaterThan(10);
	});

	it.each([
		{ stepMs: 40 },
		{ stepMs: 100 },
		{ stepMs: 250 },
	])("moves evenly while the audio's clock steps every $stepMs ms", ({ stepMs }) => {
		const shown = play(240, stepMs);
		const steps = shown.slice(1).map((value, index) => value - (shown[index] ?? 0));
		for (const step of steps) {
			// Within the catch-up allowance of one frame of real time: no surges, no stalls.
			expect(step).toBeGreaterThan((FRAME / 1000) * 0.95);
			expect(step).toBeLessThan((FRAME / 1000) * 1.05);
		}
	});

	it("stays with the sound", () => {
		const shown = play(600, 100);
		const truth = 10 + (600 * FRAME) / 1000;
		expect(Math.abs((shown.at(-1) ?? 0) - truth)).toBeLessThan(0.02);
	});

	it("jumps on a seek, and holds still while paused", () => {
		expect(tick(createSmoothClock(10, 0), 42, 16, true)).toBe(42);
		expect(tick(createSmoothClock(10, 0), 10, 500, false)).toBe(10);
	});
});
