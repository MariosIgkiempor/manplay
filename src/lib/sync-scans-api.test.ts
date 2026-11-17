import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn(), save: vi.fn() }));

const { syncScan, syncScans } = await import("#/lib/api.ts");

const plan = {
	targetId: 1,
	name: "nas",
	error: null,
	actions: [],
	held: [],
	inSync: 4,
	remoteTotal: 4,
	unchecked: 0,
};

const scan = {
	targetId: 1,
	planId: "1700000000-1",
	scannedAt: 1_700_000_000,
	plan,
	pull: { total: 5, missing: [{ rel: ["a", "b.mp3"], size: 10, otherFormat: null }], error: null },
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
		expect((await syncScan(1))?.pull.missing).toHaveLength(1);
		invoke.mockResolvedValueOnce(null);
		expect(await syncScan(1)).toBeNull();
	});

	it.each([
		{ name: "plan id is a number", value: { ...scan, planId: 1 } },
		{ name: "pull is missing", value: { ...scan, pull: undefined } },
		{ name: "pull error is absent", value: { ...scan, pull: { total: 0, missing: [] } } },
		{ name: "scanned at is not an integer", value: { ...scan, scannedAt: 1.5 } },
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
