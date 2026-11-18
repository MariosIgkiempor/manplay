import { describe, expect, it } from "vitest";
import { applySplit, dismissalKey, suggestSplits } from "#/lib/name-split.ts";

const none = new Set<string>();

describe("suggestSplits", () => {
	it.each([
		["A, B", ["A", "B"]],
		["Simon & Garfunkel", ["Simon", "Garfunkel"]],
		["A feat. B", ["A", "B"]],
		["A ft B", ["A", "B"]],
		["A x B", ["A", "B"]],
		["A + B", ["A", "B"]],
		["A / B", ["A", "B"]],
		["A, B & C", ["A", "B", "C"]],
	])("splits %s", (value, parts) => {
		expect(suggestSplits(value, none)).toEqual([{ name: value, parts }]);
	});

	it.each(["AC/DC", "Daft Punk", "Max Richter", "", "A; B", "Alex"])("leaves %j alone", (value) => {
		expect(suggestSplits(value, none)).toEqual([]);
	});

	it("skips dismissed names regardless of case", () => {
		const dismissed = new Set([dismissalKey("Simon & Garfunkel")]);
		expect(suggestSplits("simon & garfunkel; A, B", dismissed)).toEqual([
			{ name: "A, B", parts: ["A", "B"] },
		]);
	});
});

describe("applySplit", () => {
	it("replaces only the split name", () => {
		const [split] = suggestSplits("X; A & B", none);
		expect(split && applySplit("X; A & B", split)).toBe("X; A; B");
	});
});
