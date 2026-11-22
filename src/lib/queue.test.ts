import { describe, expect, it } from "vitest";
import { withAdded, withNext } from "#/lib/queue.ts";

const q = (...numbers: number[]) => numbers.map((id) => ({ id }));
const ids = (list: readonly { id: number }[]) => list.map((t) => t.id);

describe("withNext", () => {
	it.each<[string, number[], number, number[], number[]]>([
		["after the playing song", [1, 2, 3], 0, [9], [1, 9, 2, 3]],
		["several, in their order", [1, 2, 3], 1, [8, 9], [1, 2, 8, 9, 3]],
		["moving one already waiting", [1, 2, 3, 4], 0, [4], [1, 4, 2, 3]],
		["not the playing song again", [1, 2, 3], 0, [1, 9], [1, 9, 2, 3]],
		["at the end of the queue", [1, 2], 1, [9], [1, 2, 9]],
	])("puts songs %s", (_, queue, index, songs, expected) => {
		expect(ids(withNext(q(...queue), index, q(...songs)))).toEqual(expected);
	});
});

describe("withAdded", () => {
	it.each<[string, number[], number, number[], number[]]>([
		["at the end", [1, 2, 3], 0, [9], [1, 2, 3, 9]],
		["moving one already waiting to the end", [1, 2, 3], 0, [2], [1, 3, 2]],
		["not the songs already played", [1, 2, 3], 1, [1], [1, 2, 3]],
	])("adds songs %s", (_, queue, index, songs, expected) => {
		expect(ids(withAdded(q(...queue), index, q(...songs)))).toEqual(expected);
	});
});
