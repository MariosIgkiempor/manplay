import { type KeyboardEvent, useRef } from "react";
import { KEY_LIST_ATTRIBUTE, typingKey } from "#/lib/keyboard.ts";
import { DOUBLE_PRESS_MS, type GridMove, gridMoveIndex, isGridMove } from "#/lib/list-keys.ts";
import { shortcutFor } from "#/lib/use-shortcuts.ts";

/** Marks the control that opens a tile in a grid (an album, an artist): where focus goes. */
export const GRID_ITEM_ATTRIBUTE = "data-grid-item";

/** Tiles in the first row: the grid's width in tiles as it is laid out now. */
function columnsOf(items: readonly HTMLElement[]): number {
	const top = items[0]?.getBoundingClientRect().top;
	return items.filter((item) => item.getBoundingClientRect().top === top).length;
}

/**
 * Keys for a grid of tiles, with the song lists' keys read across and down: J and K (or ↓ ↑) a
 * row down or up, L and H (or → ←) the next or previous tile, gg and G the ends. Enter and Space
 * press the focused tile, as on any button. Spread `props` on the grid; mark each tile's main
 * button with `GRID_ITEM_ATTRIBUTE`.
 */
export function useTileGridKeys({ more, loadMore }: { more: boolean; loadMore: () => void }) {
	const gridRef = useRef<HTMLDivElement>(null);
	const lastG = useRef(0);
	const items = () => [
		...(gridRef.current?.querySelectorAll<HTMLElement>(`[${GRID_ITEM_ATTRIBUTE}]`) ?? []),
	];
	const focusItem = (i: number) => {
		const item = items()[i];
		item?.focus();
		item?.scrollIntoView({ block: "nearest" });
	};

	/** g alone waits for a second g, as in Vim; true once the pair is complete. */
	const secondG = () => {
		const now = performance.now();
		const double = now - lastG.current < DOUBLE_PRESS_MS;
		lastG.current = double ? 0 : now;
		return double;
	};

	const move = (id: GridMove) => {
		const all = items();
		const active = document.activeElement;
		const at = active instanceof HTMLElement ? all.indexOf(active) : -1;
		const columns = columnsOf(all);
		const to = gridMoveIndex(id, at, all.length, columns);
		if (to === null) {
			return;
		}
		// Tiles come a page at a time; past the last drawn row, draw the next page.
		if (more && (id === "listLast" || to >= all.length - columns)) {
			loadMore();
		}
		focusItem(to);
	};

	const onKeyDown = (e: KeyboardEvent) => {
		const id = typingKey(e.nativeEvent) ? undefined : shortcutFor(e.nativeEvent, "list")?.id;
		if (id === undefined || e.defaultPrevented || !isGridMove(id)) {
			return;
		}
		e.preventDefault();
		if (id !== "listFirst" || e.code !== "KeyG") {
			move(id);
		} else if (secondG()) {
			focusItem(0);
		}
	};

	return {
		ref: gridRef,
		props: { onKeyDown, [KEY_LIST_ATTRIBUTE]: "" },
	};
}
