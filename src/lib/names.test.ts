import { describe, expect, it } from "vitest";
import { joinNames, splitNames } from "#/lib/names.ts";

describe("names", () => {
	it("splits on semicolons and trims", () => {
		expect(splitNames(" A ;B;; C ")).toEqual(["A", "B", "C"]);
	});
	it("keeps a single name whole, including ampersands and slashes", () => {
		expect(splitNames("Simon & Garfunkel")).toEqual(["Simon & Garfunkel"]);
		expect(splitNames("AC/DC")).toEqual(["AC/DC"]);
	});
	it("joins with a plain semicolon", () => {
		expect(joinNames(["A", "B"])).toBe("A; B");
	});
});
