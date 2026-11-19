import { describe, expect, it } from "vitest";
import { parseReviewView, type ReviewView } from "#/lib/sync-review-view.ts";

describe("parseReviewView", () => {
	it.each<{ raw: unknown; expected: ReviewView }>([
		{ raw: "albums", expected: "albums" },
		{ raw: "folders", expected: "folders" },
		{ raw: null, expected: "albums" },
		{ raw: "Folders", expected: "albums" },
		{ raw: "tree", expected: "albums" },
		{ raw: 1, expected: "albums" },
	])("$raw", ({ raw, expected }) => {
		expect(parseReviewView(raw)).toBe(expected);
	});
});
