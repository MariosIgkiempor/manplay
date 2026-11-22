import { describe, expect, it } from "vitest";
import { type PressOutcome, pressOutcome, SETTLE_MS } from "./two-press.ts";

describe("pressOutcome", () => {
	const cases: [what: string, armedAt: number | null, now: number, outcome: PressOutcome][] = [
		["the first press arms", null, 1000, "arm"],
		["the second half of a double-click is ignored", 1000, 1000 + SETTLE_MS - 1, "ignore"],
		["a press at the same instant is ignored", 1000, 1000, "ignore"],
		["a press once settled confirms", 1000, 1000 + SETTLE_MS, "confirm"],
		["a later press confirms", 1000, 5000, "confirm"],
	];
	it.each(cases)("%s", (_what, armedAt, now, outcome) => {
		expect(pressOutcome(armedAt, now)).toBe(outcome);
	});
});
