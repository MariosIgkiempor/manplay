import { describe, expect, it } from "vitest";
import type { AuditIssue } from "#/lib/api.ts";
import {
	describeFixes,
	fixablePaths,
	fixablePathsOfKind,
	fixSteps,
	indexIssues,
	issueChip,
	kindLines,
	nameAfterFix,
} from "#/lib/audit.ts";

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

	// Issues can arrive before the library folder is known; this used to never return.
	it.each([
		["no library folder yet", ""],
		["a root the issues are outside of", "/elsewhere"],
	])("returns with %s, Windows paths included", (_, root) => {
		const index = indexIssues(root, [...issues, issue("C:\\Music\\x.mp3", "notMp3")]);
		expect(index.byPath.size).toBe(4);
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
		expect(lines[1]).toContain("Rewrite metadata");
		expect(lines.join("\n")).not.toContain("Move");
	});
});

describe("kindLines", () => {
	it("lists only the kinds present", () => {
		expect(kindLines({ notMp3: 3, misplaced: 1 })).toEqual(["3 not MP3", "1 in the wrong folder"]);
		expect(kindLines({})).toEqual([]);
	});
});

describe("bulk fix helpers", () => {
	it("finds the files with a fixable issue of one kind", () => {
		expect(fixablePathsOfKind(issues, "notMp3")).toEqual(["/lib/A/B/1.flac"]);
		expect(fixablePathsOfKind(issues, "misplaced")).toEqual([]);
	});

	it.each([
		["a converted file takes .mp3", "1.flac", [issue("/x", "notMp3")], "1.mp3"],
		["an unfixable conversion keeps its name", "1.flac", [issue("/x", "notMp3", false)], "1.flac"],
		["a tag fix keeps the name", "2.mp3", [issue("/x", "tagVersion")], "2.mp3"],
	])("names the file after the fix: %s", (_what, name, list, expected) => {
		expect(nameAfterFix(name, list)).toBe(expected);
	});

	it("lists only fixable steps, in the order they run", () => {
		const steps = fixSteps([
			issue("/x", "misplaced"),
			issue("/x", "tagVersion", false),
			issue("/x", "notMp3"),
		]);
		expect(steps).toHaveLength(2);
		expect(steps[0]).toMatch(/^Convert to MP3/);
		expect(steps[1]).toBe("misplaced");
	});
});

describe("issueChip", () => {
	const withMessage = (path: string, kind: AuditIssue["kind"], message: string): AuditIssue => ({
		...issue(path, kind),
		message,
	});
	it.each([
		["a FLAC to convert", withMessage("/l/a.flac", "notMp3", "FLAC file, not MP3"), "FLAC → MP3"],
		["a file without an ending", withMessage("/l.d/song", "notMp3", "file, not MP3"), "File → MP3"],
		["old tags", withMessage("/l/a.mp3", "tagVersion", "ID3v2.4 tags"), "ID3v2.4 → v2.3"],
		["a move", withMessage("/l/a.mp3", "misplaced", "Belongs in A/B"), "Move to A/B"],
		[
			"a file outside",
			withMessage("/a.mp3", "misplaced", "Misplaced: outside the library"),
			"Outside the library",
		],
	])("words %s in a few words", (_what, given, expected) => {
		expect(issueChip(given)).toBe(expected);
	});
});
