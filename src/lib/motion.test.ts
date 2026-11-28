import { describe, expect, it } from "vitest";
import { POP_SPRING, type Spring, springAt, springCurve, springDuration } from "#/lib/motion.ts";

const HEAVY: Spring = { stiffness: 100, damping: 40 };

describe("springAt", () => {
	it.each([
		["the pop spring", POP_SPRING],
		["a spring with no bounce", HEAVY],
	])("%s starts at 0 and comes to rest at 1", (_, spring) => {
		expect(springAt(spring, 0)).toBeCloseTo(0, 5);
		expect(springAt(spring, springDuration(spring) / 1000)).toBeCloseTo(1, 2);
	});

	it("the pop spring passes its mark once, by a little", () => {
		const seconds = springDuration(POP_SPRING) / 1000;
		const path = Array.from({ length: 200 }, (_, i) => springAt(POP_SPRING, (seconds * i) / 199));
		const peak = Math.max(...path);
		expect(peak).toBeGreaterThan(1.03);
		expect(peak).toBeLessThan(1.1);
	});

	it("a spring with no bounce never passes its mark", () => {
		const path = Array.from({ length: 200 }, (_, i) => springAt(HEAVY, i / 50));
		expect(Math.max(...path)).toBeLessThanOrEqual(1);
	});
});

describe("springCurve", () => {
	it("is a linear() curve from 0 to exactly 1", () => {
		const curve = springCurve(POP_SPRING);
		expect(curve).toMatch(/^linear\(0\.0000, .*, 1\.0000\)$/);
	});
});
