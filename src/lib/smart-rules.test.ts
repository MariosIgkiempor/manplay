import { describe, expect, it } from "vitest";
import {
	autoName,
	dateInput,
	describeRules,
	EMPTY_RULES,
	fromDateInput,
	hasRules,
	placeTag,
	roleOf,
	sameRules,
	withAddedKind,
} from "#/lib/smart-rules.ts";

describe("autoName", () => {
	it("joins the tags' last levels", () => {
		expect(autoName({ ...EMPTY_RULES, allTags: ["instrumental", "Genre/House"] })).toBe(
			"instrumental + House",
		);
		expect(autoName({ ...EMPTY_RULES, allTags: ["a"], anyTags: ["b", "c"] })).toBe("a + b or c");
		expect(autoName(EMPTY_RULES)).toBe("New smart playlist");
	});
});

describe("date rules", () => {
	it("round-trips a date input", () => {
		const unix = fromDateInput("2026-09-01");
		expect(unix).not.toBeNull();
		expect(dateInput(unix ?? 0)).toBe("2026-09-01");
		expect(fromDateInput("2026-09")).toBeNull();
	});

	it("keeps the date when switching between after and before", () => {
		const after = withAddedKind(null, "after", new Date(2026, 10, 16));
		expect(after?.kind).toBe("after");
		const before = withAddedKind(after, "before");
		expect(before).toEqual({ ...after, kind: "before" });
		expect(withAddedKind(before, "within")).toEqual({ kind: "within", amount: 30, unit: "days" });
		expect(withAddedKind(before, "any")).toBeNull();
	});
});

describe("hasRules and sameRules", () => {
	it("tells empty rules and equal rules apart", () => {
		expect(hasRules(EMPTY_RULES)).toBe(false);
		expect(hasRules({ ...EMPTY_RULES, bpmMin: 120 })).toBe(true);
		expect(
			sameRules(
				{ ...EMPTY_RULES, added: { kind: "within", amount: 2, unit: "weeks" } },
				{ ...EMPTY_RULES, added: { unit: "weeks", amount: 2, kind: "within" } },
			),
		).toBe(true);
		expect(sameRules(EMPTY_RULES, { ...EMPTY_RULES, allTags: ["x"] })).toBe(false);
	});
});

describe("describeRules", () => {
	it("reads the rules back as a sentence", () => {
		expect(describeRules(EMPTY_RULES)).toBe("Every song in the library");
		expect(
			describeRules({
				...EMPTY_RULES,
				allTags: ["instrumental", "Genre/House"],
				noneTags: ["vocal"],
				added: { kind: "within", amount: 30, unit: "days" },
				bpmMin: 120,
				bpmMax: 128,
			}),
		).toBe(
			"Songs tagged instrumental and House, not tagged vocal, added in the last 30 days, at 120–128 BPM",
		);
		expect(
			describeRules({
				...EMPTY_RULES,
				anyTags: ["a", "b", "c"],
				added: { kind: "within", amount: 1, unit: "weeks" },
				bpmMax: 100,
			}),
		).toBe("Songs tagged a, b or c, added in the last week, at 100 BPM or slower");
		expect(
			describeRules(
				{ ...EMPTY_RULES, allTags: ["x"], anyTags: ["y", "z"], added: { kind: "after", date: 0 } },
				() => "1 Sep",
			),
		).toBe("Songs tagged x and at least one of y or z, added on or after 1 Sep");
	});
});

describe("placeTag", () => {
	it("keeps a tag in one group only", () => {
		const r = placeTag({ ...EMPTY_RULES, allTags: ["House"] }, "house", "none");
		expect(r.allTags).toEqual([]);
		expect(r.noneTags).toEqual(["house"]);
		expect(roleOf(r, "HOUSE")).toBe("none");
		expect(roleOf(r, "techno")).toBeNull();
	});
});
