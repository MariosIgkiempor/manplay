import { describe, expect, it } from "vitest";
import type { PlanId, ScanStatus } from "#/lib/api.ts";
import {
	hasNewerRead,
	latestReads,
	type ReadRef,
	shownReads,
	unreadTargets,
	waitingOnOther,
} from "#/lib/review-reads.ts";

const read = (targetId: number, plan: string): ReadRef => ({
	targetId,
	planId: plan as PlanId,
});
const status = (scanning: number | null, queued: number[] = []): ScanStatus => ({
	scans: [],
	queued,
	scanning,
});

describe("latestReads", () => {
	it("drops reads the user waited past and missing ones", () => {
		const stale = new Set(["old" as PlanId]);
		expect(latestReads([read(1, "old"), read(2, "new"), null, undefined], stale)).toEqual([
			null,
			read(2, "new"),
			null,
			null,
		]);
	});
});

describe("shownReads", () => {
	const pinned = new Map([[1, read(1, "a")]]);
	it.each([
		{ name: "frozen keeps the pinned read", frozen: true, latest: read(1, "b"), shown: "a" },
		{ name: "unfrozen shows the latest", frozen: false, latest: read(1, "b"), shown: "b" },
		{ name: "no latest falls back to pinned", frozen: false, latest: null, shown: "a" },
	])("$name", ({ frozen, latest, shown }) => {
		expect(shownReads([1], [latest], pinned, frozen)[0]?.planId).toBe(shown);
	});

	it("frozen takes the same read shown again, e.g. with files ignored", () => {
		const again = { ...read(1, "a"), ignored: 1 };
		expect(shownReads([1], [again], pinned, true)).toEqual([again]);
	});

	it("frozen shows the latest where nothing is pinned yet", () => {
		expect(shownReads([2], [read(2, "c")], pinned, true)).toEqual([read(2, "c")]);
	});

	it("shows nothing for a destination never read", () => {
		expect(shownReads([3], [null], pinned, false)).toEqual([null]);
	});
});

describe("hasNewerRead", () => {
	const pinned = new Map([[1, read(1, "a")]]);
	it.each([
		{ name: "same read", latest: read(1, "a"), newer: false },
		{ name: "a newer read", latest: read(1, "b"), newer: true },
		{ name: "no read", latest: null, newer: false },
	])("$name", ({ latest, newer }) => {
		expect(hasNewerRead([1], [latest], pinned)).toBe(newer);
	});

	it("ignores a destination with nothing pinned", () => {
		expect(hasNewerRead([2], [read(2, "b")], pinned)).toBe(false);
	});
});

describe("unreadTargets", () => {
	it.each([
		{ name: "never read and idle", reads: [null], s: status(null), unread: [1] },
		{ name: "still loading", reads: [undefined], s: status(null), unread: [] },
		{ name: "already read", reads: [read(1, "a")], s: status(null), unread: [] },
		{ name: "being read", reads: [null], s: status(1), unread: [] },
		{ name: "queued", reads: [null], s: status(2, [1]), unread: [] },
		{ name: "status unknown", reads: [null], s: undefined, unread: [] },
	])("$name", ({ reads, s, unread }) => {
		expect(unreadTargets([1], reads, s)).toEqual(unread);
	});
});

describe("waitingOnOther", () => {
	it.each([
		{ name: "another is read", s: status(9), waiting: true },
		{ name: "this one is read", s: status(1), waiting: false },
		{ name: "nothing is read", s: status(null), waiting: false },
		{ name: "status unknown", s: undefined, waiting: false },
	])("$name", ({ s, waiting }) => {
		expect(waitingOnOther([1, 2], s)).toBe(waiting);
	});
});
