import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
	convertFileSrc: (path: string, scheme = "asset") => `${scheme}://${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { fileStateSchema, newSongsSchema, streamCacheUsageSchema, trackUrl } = await import(
	"#/lib/api.ts"
);
const invoked = vi.mocked(invoke);

describe("fileStateSchema", () => {
	it.each(["here", "streamed"])("takes %s", (state) => {
		expect(fileStateSchema.parse(state)).toBe(state);
	});

	it.each([
		["another word", "cached"],
		["a different case", "Streamed"],
		["nothing", null],
	])("refuses %s", (_name, value) => {
		expect(fileStateSchema.safeParse(value).success).toBe(false);
	});
});

describe("trackUrl", () => {
	beforeEach(() => invoked.mockReset());

	it("plays a kept song from its file without asking the backend", async () => {
		const url = await trackUrl({ id: 1, path: "/music/a.mp3", fileState: "here" });
		expect(url).toBe("asset:///music/a.mp3");
		expect(invoked).not.toHaveBeenCalled();
	});

	it("streams a streamed song from where the backend says", async () => {
		invoked.mockResolvedValueOnce("remote:7/House/a.mp3");
		const url = await trackUrl({ id: 2, path: "/music/House/a.mp3", fileState: "streamed" });
		expect(invoked).toHaveBeenCalledWith("stream_source", { trackId: 2 });
		expect(url).toBe("remote://7/House/a.mp3");
	});

	it("refuses an answer that is not a place", async () => {
		invoked.mockResolvedValueOnce(42);
		await expect(
			trackUrl({ id: 3, path: "/music/b.mp3", fileState: "streamed" }),
		).rejects.toThrow();
	});
});

describe("streamCacheUsageSchema", () => {
	it.each([
		["an empty cache", { used: 0, limit: 5_000_000_000 }],
		["a full one", { used: 5_000_000_000, limit: 5_000_000_000 }],
	])("takes %s", (_name, usage) => {
		expect(streamCacheUsageSchema.parse(usage)).toEqual(usage);
	});

	it.each([
		["a negative size", { used: -1, limit: 5_000_000_000 }],
		["no room at all", { used: 0, limit: 0 }],
		["a size that is not whole", { used: 1.5, limit: 5_000_000_000 }],
		["no limit", { used: 0 }],
	])("refuses %s", (_name, usage) => {
		expect(streamCacheUsageSchema.safeParse(usage).success).toBe(false);
	});
});

describe("newSongsSchema", () => {
	it.each(["stream", "download"])("takes %s", (choice) => {
		expect(newSongsSchema.parse(choice)).toBe(choice);
	});

	it.each([
		["another word", "keep"],
		["nothing", null],
	])("refuses %s", (_name, value) => {
		expect(newSongsSchema.safeParse(value).success).toBe(false);
	});
});
