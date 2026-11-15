import { describe, expect, it } from "vitest";
import type { UsbPlaylist } from "#/lib/api.ts";
import { playlistTree } from "#/lib/usb-library.ts";

const p = (id: number, parentId: number, sortOrder: number, isFolder = false): UsbPlaylist => ({
	id,
	parentId,
	sortOrder,
	isFolder,
	name: `p${id}`,
	trackIds: [],
});

describe("playlistTree", () => {
	it("lists folders before their contents, in sort order", () => {
		const rows = playlistTree([p(3, 1, 1), p(1, 0, 1, true), p(2, 0, 0), p(4, 1, 0)]);
		expect(rows.map((r) => [r.playlist.id, r.depth])).toEqual([
			[2, 0],
			[1, 0],
			[4, 1],
			[3, 1],
		]);
	});

	it("survives a playlist that names itself as parent", () => {
		expect(playlistTree([p(1, 1, 0)])).toEqual([]);
	});
});
