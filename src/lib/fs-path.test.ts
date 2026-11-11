import { describe, expect, it } from "vitest";
import { joinPath, parentPath, relSegments } from "#/lib/fs-path.ts";

describe("fs-path", () => {
	it("joins without doubling separators", () => {
		expect(joinPath("/music", "a", "b")).toBe("/music/a/b");
		expect(joinPath("/music/", "a")).toBe("/music/a");
		expect(joinPath("C:\\music", "a")).toBe("C:\\music\\a");
	});

	it("finds the parent", () => {
		expect(parentPath("/music/a/b")).toBe("/music/a");
		expect(parentPath("/music")).toBe("/");
	});

	it("lists folders below the root", () => {
		expect(relSegments("/music", "/music")).toEqual([]);
		expect(relSegments("/music", "/music/a/b")).toEqual(["a", "b"]);
		expect(relSegments("/music/", "/music/a")).toEqual(["a"]);
		expect(relSegments("/music", "/elsewhere")).toEqual([]);
	});
});
