import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { songFetchProgressSchema } = await import("#/lib/api.ts");

describe("songFetchProgressSchema", () => {
	it.each([
		["a download under way", { done: 3, total: 40 }],
		["no download running", { done: 0, total: 0 }],
	])("takes %s", (_name, payload) => {
		expect(songFetchProgressSchema.parse(payload)).toEqual(payload);
	});

	it.each([
		["a count that is not whole", { done: 1.5, total: 40 }],
		["a count as text", { done: "3", total: 40 }],
		["no total", { done: 3 }],
		["nothing", null],
	])("refuses %s", (_name, payload) => {
		expect(songFetchProgressSchema.safeParse(payload).success).toBe(false);
	});
});
