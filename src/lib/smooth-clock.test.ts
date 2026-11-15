import { describe, expect, it } from "vitest";
import { tick } from "#/lib/smooth-clock.ts";

describe("smooth clock", () => {
	it("keeps moving between the audio's coarse updates", () => {
		const c = { shown: 10, at: 0 };
		// The audio still reports 10 s a frame later; the clock moves on regardless.
		expect(tick(c, 10, 16, true)).toBeGreaterThan(10.01);
	});

	it("never steps backwards for a small correction", () => {
		const c = { shown: 10, at: 0 };
		const next = tick(c, 9.95, 16, true);
		expect(next).toBeGreaterThan(10);
	});

	it("jumps on a seek, and holds still while paused", () => {
		expect(tick({ shown: 10, at: 0 }, 42, 16, true)).toBe(42);
		expect(tick({ shown: 10, at: 0 }, 10, 500, false)).toBe(10);
	});
});
