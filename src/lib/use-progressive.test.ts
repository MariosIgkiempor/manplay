import { describe, expect, it } from "vitest";
import { firstPage } from "#/lib/use-progressive.ts";

describe("firstPage", () => {
	it.each<{ name: string; count: number; limit: number; shown: number; more: boolean }>([
		{ name: "a short list shows whole", count: 5, limit: 200, shown: 5, more: false },
		{ name: "exactly one page has nothing more", count: 200, limit: 200, shown: 200, more: false },
		{
			name: "a long list shows a page and has more",
			count: 450,
			limit: 200,
			shown: 200,
			more: true,
		},
		{ name: "after two pages", count: 450, limit: 400, shown: 400, more: true },
		{ name: "an empty list", count: 0, limit: 200, shown: 0, more: false },
	])("$name", ({ count, limit, shown, more }) => {
		const page = firstPage(
			Array.from({ length: count }, (_, i) => i),
			limit,
		);
		expect(page.shown.length).toBe(shown);
		expect(page.more).toBe(more);
	});
});
