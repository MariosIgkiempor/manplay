import { describe, expect, it } from "vitest";
import type { AuditIssue } from "#/lib/api.ts";
import { describeFixes, fixablePaths, indexIssues, kindLines } from "#/lib/audit.ts";

const issue = (path: string, kind: AuditIssue["kind"], fixable = true): AuditIssue => ({
	path,
	kind,
	message: kind,
	fixable,
	place: null,
});

const issues = [
	issue("/lib/A/B/1.flac", "notMp3"),
	issue("/lib/A/B/1.flac", "misplaced", false),
	issue("/lib/A/C/2.mp3", "tagVersion"),
	issue("/lib/loose.mp3", "misplaced", false),
];

describe("indexIssues", () => {
	const idx = indexIssues("/lib", issues);

	it("groups by file", () => {
		expect(idx.byPath.get("/lib/A/B/1.flac")?.length).toBe(2);
	});

	it("rolls counts up through every folder to the root", () => {
		expect(idx.folders.get("/lib/A/B")).toEqual({
			count: 2,
			fixable: 1,
			kinds: { notMp3: 1, misplaced: 1 },
			input: 0,
		});
		expect(idx.folders.get("/lib/A")?.count).toBe(3);
		expect(idx.folders.get("/lib/A")?.fixable).toBe(2);
		expect(idx.folders.get("/lib")?.kinds).toEqual({ notMp3: 1, misplaced: 2, tagVersion: 1 });
	});

	it("does not leak above the root", () => {
		expect(idx.folders.has("/")).toBe(false);
	});
});

describe("fixablePaths", () => {
	it("lists each file once, only when something is fixable", () => {
		expect(fixablePaths(issues)).toEqual(["/lib/A/B/1.flac", "/lib/A/C/2.mp3"]);
	});

	it("can be limited to folders or files", () => {
		expect(fixablePaths(issues, ["/lib/A/C"])).toEqual(["/lib/A/C/2.mp3"]);
		expect(fixablePaths(issues, ["/lib/A/B/1.flac"])).toEqual(["/lib/A/B/1.flac"]);
		expect(fixablePaths(issues, ["/lib/A/B/1"])).toEqual([]);
	});
});

describe("describeFixes", () => {
	it("names each kind of fix with its count", () => {
		const lines = describeFixes(issues, fixablePaths(issues));
		expect(lines[0]).toContain("Convert 1 file to MP3");
		expect(lines[1]).toContain("Rewrite tags");
		expect(lines.join("\n")).not.toContain("Move");
	});
});

describe("kindLines", () => {
	it("lists only the kinds present", () => {
		expect(kindLines({ notMp3: 3, misplaced: 1 })).toEqual(["3 not MP3", "1 in the wrong folder"]);
		expect(kindLines({})).toEqual([]);
	});
});
