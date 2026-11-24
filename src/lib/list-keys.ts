import type { ListShortcutId, ShortcutId } from "#/lib/shortcuts.ts";

/** The song list keys that move the cursor. */
export type ListMove = Extract<
	ListShortcutId,
	"listNext" | "listPrev" | "listExtendNext" | "listExtendPrev" | "listFirst" | "listLast"
>;

const MOVES: ReadonlySet<ShortcutId> = new Set<ListMove>([
	"listNext",
	"listPrev",
	"listExtendNext",
	"listExtendPrev",
	"listFirst",
	"listLast",
]);

export function isListMove(id: ShortcutId): id is ListMove {
	return MOVES.has(id);
}

/**
 * The row a move lands on, from row `at` (-1 when no row has the cursor yet) in a list of
 * `count` rows: one on, one back, the first or the last; it stops at either end. Null when the
 * list is empty.
 */
export function moveIndex(move: ListMove, at: number, count: number): number | null {
	if (count === 0) {
		return null;
	}
	const last = count - 1;
	if (at < 0 || at > last) {
		return move === "listLast" ? last : 0;
	}
	switch (move) {
		case "listNext":
		case "listExtendNext":
			return Math.min(at + 1, last);
		case "listPrev":
		case "listExtendPrev":
			return Math.max(at - 1, 0);
		case "listFirst":
			return 0;
		case "listLast":
			return last;
	}
}

/** Two presses of a key closer than this make a double press, like Vim's `gg`. */
export const DOUBLE_PRESS_MS = 800;

/** A move in a grid of tiles (albums, artists): the list keys, read across and down. */
export type GridMove = Extract<
	ListShortcutId,
	"listNext" | "listPrev" | "listOpen" | "listBack" | "listFirst" | "listLast"
>;

const GRID_MOVES: ReadonlySet<ShortcutId> = new Set<GridMove>([
	"listNext",
	"listPrev",
	"listOpen",
	"listBack",
	"listFirst",
	"listLast",
]);

export function isGridMove(id: ShortcutId): id is GridMove {
	return GRID_MOVES.has(id);
}

/**
 * The tile a move lands on, from tile `at` (-1 when none has focus) in a grid of `count` tiles,
 * `columns` to a row: J and K a row down or up (staying put at the top or bottom row), L and H
 * the next or previous tile, wrapping onto the next row as text does. Null when the grid is empty.
 */
export function gridMoveIndex(
	move: GridMove,
	at: number,
	count: number,
	columns: number,
): number | null {
	if (count === 0) {
		return null;
	}
	const last = count - 1;
	if (at < 0 || at > last) {
		return move === "listLast" ? last : 0;
	}
	const width = Math.max(1, columns);
	switch (move) {
		case "listNext":
			return at + width <= last ? at + width : at;
		case "listPrev":
			return at - width >= 0 ? at - width : at;
		case "listOpen":
			return Math.min(at + 1, last);
		case "listBack":
			return Math.max(at - 1, 0);
		case "listFirst":
			return 0;
		case "listLast":
			return last;
	}
}
