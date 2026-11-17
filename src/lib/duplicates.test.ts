import { describe, expect, it } from "vitest";
import type { DuplicateGroup } from "#/lib/api.ts";
import { extraCopies } from "#/lib/duplicates.ts";

const file = (id: number) => ({
	id,
	path: `/m/${id}.mp3`,
	title: "T",
	artist: "A",
	album: "B",
	size: 1,
});

describe("extraCopies", () => {
	it("counts the files beyond the first of each group", () => {
		const groups: DuplicateGroup[] = [
			{ audioFp: "x", tracks: [file(1), file(2)] },
			{ audioFp: "y", tracks: [file(3), file(4), file(5)] },
		];
		expect(extraCopies(groups)).toBe(3);
		expect(extraCopies([])).toBe(0);
	});
});
