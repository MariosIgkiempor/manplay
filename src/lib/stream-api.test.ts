import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
	convertFileSrc: (path: string, scheme = "asset") => `${scheme}://${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { fileStateSchema, trackUrl } = await import("#/lib/api.ts");
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
