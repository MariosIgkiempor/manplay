import { describe, expect, it } from "vitest";
import type { Brand } from "#/components/brand-icon.tsx";
import { folderBrand, folderName } from "#/lib/import-folders.ts";

describe("folderBrand", () => {
	it.each<[string, Brand]>([
		["/Users/dj/Music/iTunes/iTunes Media", "itunes"],
		["/Users/dj/Music/iTunes/Music", "itunes"],
		["/Users/dj/Music/Music/Media", "itunes"],
		["C:\\Users\\dj\\Music\\iTunes\\iTunes Media", "itunes"],
		["/Users/dj/Downloads", "downloads"],
		["C:\\Users\\dj\\Downloads", "downloads"],
		["/Users/dj/Music/Promos", "folder"],
		["/Volumes/Promos/Downloads stuff", "folder"],
	])("%s is %s", (path, brand) => {
		expect(folderBrand(path)).toBe(brand);
	});
});

describe("folderName", () => {
	it.each([
		["/Users/dj/Downloads", "Downloads"],
		["/Users/dj/Music/iTunes/iTunes Media/", "iTunes Media"],
		["C:\\Users\\dj\\Promos", "Promos"],
	])("%s is called %s", (path, name) => {
		expect(folderName(path)).toBe(name);
	});
});
