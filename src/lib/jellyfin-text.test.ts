import { describe, expect, it } from "vitest";
import type { JellyfinPushSummary } from "#/lib/api.ts";
import { pushSummaryText } from "#/lib/jellyfin-text.ts";

const none: JellyfinPushSummary = {
	created: 0,
	updated: 0,
	renamed: 0,
	reshared: 0,
	removed: 0,
	waiting: 0,
	failed: [],
};

describe("pushSummaryText", () => {
	it.each<[Partial<JellyfinPushSummary>, string]>([
		[{}, "nothing changed"],
		[{ created: 2, updated: 1 }, "2 new, 1 updated"],
		[{ renamed: 1, removed: 3 }, "1 renamed, 3 removed"],
		[{ reshared: 2 }, "2 shared anew"],
		[{ waiting: 1 }, "nothing changed. 1 change waiting for review"],
		[{ created: 1, waiting: 2 }, "1 new. 2 changes waiting for review"],
		[
			{ failed: ["House: Jellyfin adding songs: 500", "x"] },
			"nothing changed. 2 failed: House: Jellyfin adding songs: 500",
		],
	])("%o reads %s", (changes, text) => {
		expect(pushSummaryText({ ...none, ...changes })).toBe(text);
	});
});
