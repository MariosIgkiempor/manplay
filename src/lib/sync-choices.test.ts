import { describe, expect, it } from "vitest";
import type { SyncAction } from "#/lib/api.ts";
import { type IncomingAction, isIncoming, isPush, isSettled } from "#/lib/sync-choices.ts";

const action = (kind: SyncAction["kind"], merge: SyncAction["merge"] = null) =>
	({ id: 1, kind, merge }) as SyncAction;

describe("incoming actions", () => {
	it("tells what comes into the library from what goes to the destination", () => {
		expect(["update", "merge", "conflict"].map((k) => isIncoming(action(k as never)))).toEqual([
			true,
			true,
			true,
		]);
		expect(isPush(action("replace"))).toBe(true);
		expect(isIncoming(action("upload"))).toBe(false);
	});

	it("runs an update as is", () => {
		expect(isSettled(action("update") as IncomingAction, undefined)).toBe(true);
	});

	it("needs a copy chosen for a conflict", () => {
		const a = action("conflict") as IncomingAction;
		expect(isSettled(a, undefined)).toBe(false);
		expect(isSettled(a, { keep: "theirs", fields: {} })).toBe(true);
	});

	it("needs every clashing field of a merge settled", () => {
		const merge = [
			{ field: "genre", base: "a", mine: "b", theirs: "c", side: null },
			{ field: "year", base: "1", mine: "1", theirs: "2", side: "theirs" as const },
		];
		const a = action("merge", merge) as IncomingAction;
		expect(isSettled(a, undefined)).toBe(false);
		expect(isSettled(a, { fields: { genre: "mine" } })).toBe(true);
	});
});
