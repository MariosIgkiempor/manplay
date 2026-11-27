import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { cacheSizeOptions } = await import("#/components/streaming-settings.tsx");
const GB = 1024 ** 3;

describe("cacheSizeOptions", () => {
	it.each([
		["a size offered", 5 * GB, 9, "5.0 GB"],
		["a size set some other way", 3 * GB, 10, "3.0 GB"],
	])("lists %s once, in order", (_name, limit, count, label) => {
		const options = cacheSizeOptions(limit);
		expect(options).toHaveLength(count);
		expect(options.filter((o) => o.value === String(limit)).map((o) => o.label)).toEqual([label]);
		const values = options.map((o) => Number(o.value));
		expect(values).toEqual([...values].sort((a, b) => a - b));
	});
});
