import { describe, expect, it } from "vitest";
import {
	directionBetween,
	type PageDirection,
	passedPagesToShow,
	type ScrollMs,
	scrollMsFor,
} from "#/lib/page-transition.ts";

/** A sidebar row at `position` from the top; only its order matters. */
function row(position: number) {
	const self = {
		position,
		compareDocumentPosition: (other: Node) =>
			(other as unknown as typeof self).position > position ? 4 : 2,
	};
	return self as unknown as Node;
}

const playlists = row(3);

describe("directionBetween", () => {
	it.each<[string, Node | null, Node | null, PageDirection | null]>([
		["to a row lower down", playlists, row(7), "down"],
		["to a row higher up", playlists, row(1), "up"],
		["to the same row", playlists, playlists, null],
		["from a page with no row", null, playlists, null],
		["to a page with no row", playlists, null, null],
	])("going %s", (_, from, to, expected) => {
		expect(directionBetween(from, to)).toBe(expected);
	});
});

describe("passedPagesToShow", () => {
	it.each<[string, number, number, number[]]>([
		["none in between", 0, 10, []],
		["fewer than the most", 3, 10, [0, 1, 2]],
		["exactly the most", 4, 4, [0, 1, 2, 3]],
		["more than the most, spread evenly with both ends", 9, 3, [0, 4, 8]],
		["many more, keeping the first and last", 30, 4, [0, 10, 19, 29]],
		["a most of one", 5, 1, [0]],
	])("%s", (_, count, most, expected) => {
		expect(passedPagesToShow(count, most)).toEqual(expected);
	});
});

describe("scrollMsFor", () => {
	it.each<[string, number, ScrollMs]>([
		["the next page", 0, 420],
		["passing one page", 1, 460],
		["passing five pages", 5, 620],
		["passing many pages, capped", 40, 720],
	])("%s", (_, passed, expected) => {
		expect(scrollMsFor(passed)).toBe(expected);
	});
});
