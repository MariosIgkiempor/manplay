import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IgnoreRule } from "#/lib/api.ts";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { syncIgnore, syncScan, syncScans, syncUnignore } = await import("#/lib/api.ts");

const upload = {
	id: 1,
	targetId: 1,
	kind: "upload",
	rel: ["a", "c.mp3"],
	from: null,
	size: 10,
	remoteSize: null,
	note: null,
	optional: false,
	tags: null,
	localSize: null,
	merge: null,
	trackId: 7,
	duplicateOf: null,
};

const plan = {
	targetId: 1,
	name: "nas",
	error: null,
	actions: [upload],
	held: [],
	inSync: 4,
	remoteTotal: 4,
	unchecked: 0,
	folders: [{ rel: ["a"], files: 4 }],
};

const scan = {
	targetId: 1,
	planId: "1700000000-1",
	scannedAt: 1_700_000_000,
	plan,
	pull: { total: 5, missing: [{ rel: ["a", "b.mp3"], size: 10, otherFormat: null }], error: null },
	ignored: [{ rel: ["Them", "Live"], scope: "folder", files: 3 }],
};

const status = {
	scans: [{ targetId: 1, planId: "1-1", scannedAt: 1, error: null, toPull: 1, toPush: 0 }],
	queued: [2],
	scanning: null,
};

beforeEach(() => invoke.mockReset());

describe("syncScan", () => {
	it("accepts a read and no read yet", async () => {
		invoke.mockResolvedValueOnce(scan);
		const read = await syncScan(1);
		expect(read?.pull.missing).toHaveLength(1);
		expect(read?.plan.actions[0]?.trackId).toBe(7);
		expect(read?.plan.folders).toEqual([{ rel: ["a"], files: 4 }]);
		expect(read?.ignored).toEqual([{ rel: ["Them", "Live"], scope: "folder", files: 3 }]);
		invoke.mockResolvedValueOnce(null);
		expect(await syncScan(1)).toBeNull();
	});

	it.each([
		{ name: "plan id is a number", value: { ...scan, planId: 1 } },
		{ name: "pull is missing", value: { ...scan, pull: undefined } },
		{ name: "pull error is absent", value: { ...scan, pull: { total: 0, missing: [] } } },
		{ name: "scanned at is not an integer", value: { ...scan, scannedAt: 1.5 } },
		{ name: "the plan has no folders", value: { ...scan, plan: { ...plan, folders: undefined } } },
		{
			name: "a folder's count is text",
			value: { ...scan, plan: { ...plan, folders: [{ rel: ["a"], files: "4" }] } },
		},
		{
			name: "an action has no track id",
			value: { ...scan, plan: { ...plan, actions: [{ ...upload, trackId: undefined }] } },
		},
		{
			name: "a duplicate names its song as text",
			value: { ...scan, plan: { ...plan, actions: [{ ...upload, duplicateOf: "7" }] } },
		},
		{ name: "the ignored list is absent", value: { ...scan, ignored: undefined } },
		{
			name: "an ignored rule has an unknown scope",
			value: { ...scan, ignored: [{ rel: ["a"], scope: "everything", files: 1 }] },
		},
		{
			name: "an ignored rule has an empty path",
			value: { ...scan, ignored: [{ rel: [], scope: "folder", files: 1 }] },
		},
		{
			name: "an ignored rule has no count",
			value: { ...scan, ignored: [{ rel: ["a"], scope: "file" }] },
		},
	])("rejects a read when $name", async ({ value }) => {
		invoke.mockResolvedValueOnce(value);
		await expect(syncScan(1)).rejects.toThrow();
	});
});

describe("syncScans", () => {
	it("accepts the status", async () => {
		invoke.mockResolvedValueOnce(status);
		expect((await syncScans()).queued).toEqual([2]);
	});

	it.each([
		{ name: "scanning is absent", value: { scans: [], queued: [] } },
		{ name: "a count is text", value: { ...status, scans: [{ ...status.scans[0], toPush: "3" }] } },
		{ name: "queued holds text", value: { ...status, queued: ["2"] } },
	])("rejects the status when $name", async ({ value }) => {
		invoke.mockResolvedValueOnce(value);
		await expect(syncScans()).rejects.toThrow();
	});
});

describe("syncIgnore and syncUnignore", () => {
	const rule: IgnoreRule = { rel: ["Them", "Live"], scope: "folder" };

	it.each([
		{ name: "ignore", call: syncIgnore, command: "sync_ignore" },
		{ name: "unignore", call: syncUnignore, command: "sync_unignore" },
	])("$name sends the destination and its rules", async ({ call, command }) => {
		invoke.mockResolvedValueOnce(null);
		await call(1, [rule]);
		expect(invoke).toHaveBeenCalledWith(command, { targetId: 1, rules: [rule] });
	});

	it.each([
		{ name: "an empty path", rule: { rel: [], scope: "file" } },
		{ name: "an empty name in the path", rule: { rel: ["Them", ""], scope: "file" } },
		{ name: "an unknown scope", rule: { rel: ["Them"], scope: "everything" } },
	])("refuses to send a rule with $name", async ({ rule: bad }) => {
		await expect(syncIgnore(1, [bad as never])).rejects.toThrow();
		expect(invoke).not.toHaveBeenCalled();
	});
});
