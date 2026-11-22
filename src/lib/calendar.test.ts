import { describe, expect, it } from "vitest";
import { formatIsoDate, monthWeeks, parseIsoDate, shiftMonth } from "#/lib/calendar.ts";

describe("parseIsoDate", () => {
	it.each([
		["2024-03-09", { year: 2024, month: 3, day: 9 }],
		["2024-02-29", { year: 2024, month: 2, day: 29 }],
		["1999-12-31", { year: 1999, month: 12, day: 31 }],
		["2023-02-29", null],
		["2024-13-01", null],
		["2024-00-10", null],
		["2024-04-31", null],
		["2024-3-9", null],
		["24-03-09", null],
		["2024-03-09T00:00", null],
		[" 2024-03-09", null],
		["", null],
		["not a date", null],
	])("reads %j as %j", (text, expected) => {
		expect(parseIsoDate(text)).toEqual(expected);
	});
});

describe("formatIsoDate", () => {
	it.each([
		[{ year: 2024, month: 3, day: 9 }, "2024-03-09"],
		[{ year: 2024, month: 12, day: 31 }, "2024-12-31"],
		[{ year: 987, month: 1, day: 2 }, "0987-01-02"],
	])("writes %j as %s", (date, expected) => {
		expect(formatIsoDate(date)).toBe(expected);
	});

	it.each(["2024-03-09", "2000-02-29", "1999-12-31"])("round-trips %s", (text) => {
		const parsed = parseIsoDate(text);
		expect(parsed && formatIsoDate(parsed)).toBe(text);
	});
});

describe("shiftMonth", () => {
	it.each([
		[2024, 3, 1, { year: 2024, month: 4 }],
		[2024, 12, 1, { year: 2025, month: 1 }],
		[2024, 1, -1, { year: 2023, month: 12 }],
		[2024, 3, 0, { year: 2024, month: 3 }],
		[2024, 3, -15, { year: 2022, month: 12 }],
	])("%i-%i shifted by %i is %j", (year, month, delta, expected) => {
		expect(shiftMonth(year, month, delta)).toEqual(expected);
	});
});

describe("monthWeeks", () => {
	it.each([
		// February 2026 starts on a Sunday and has 28 days.
		[2026, 2, 1, 5, "2026-01-26", "2026-03-01"],
		[2026, 2, 0, 4, "2026-02-01", "2026-02-28"],
		// March 2024 starts on a Friday.
		[2024, 3, 1, 5, "2024-02-26", "2024-03-31"],
		[2024, 3, 0, 6, "2024-02-25", "2024-04-06"],
	])("%i-%i, week starting %i: %i rows", (year, month, weekStartsOn, rows, firstDay, lastDay) => {
		const weeks = monthWeeks(year, month, weekStartsOn as 0 | 1);
		expect(weeks).toHaveLength(rows);
		expect(weeks.every((week) => week.length === 7)).toBe(true);
		expect(weeks[0]?.[0]?.iso).toBe(firstDay);
		expect(weeks.at(-1)?.at(-1)?.iso).toBe(lastDay);
	});

	it("marks only the days of the month as in the month", () => {
		const days = monthWeeks(2024, 3).flat();
		expect(days.filter((d) => d.inMonth)).toHaveLength(31);
		expect(days.find((d) => d.iso === "2024-02-29")?.inMonth).toBe(false);
	});
});
