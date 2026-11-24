import { useEffect } from "react";
import { KEY_LIST_ATTRIBUTE, keyTakenElsewhere } from "#/lib/keyboard.ts";
import { isListMove, type ListMove } from "#/lib/list-keys.ts";
import { shortcutFor } from "#/lib/use-shortcuts.ts";
import { GRID_ITEM_ATTRIBUTE } from "#/lib/use-tile-grid-keys.ts";

/** A song list's rows, and a grid's tiles (see `useTileGridKeys`). */
const ROWS = `[${KEY_LIST_ATTRIBUTE}] [role=option], [${KEY_LIST_ATTRIBUTE}] [${GRID_ITEM_ATTRIBUTE}]`;

/**
 * Puts the cursor on the first (or with `last`, the last drawn) song of the page's song list, or
 * of the side panel's when the page has none. False when neither shows songs.
 */
export function focusListRow({ last = false } = {}): boolean {
	const inPage = [...document.querySelectorAll<HTMLElement>(ROWS)].filter(
		(candidate) => candidate.closest("main") !== null,
	);
	const rows = inPage.length > 0 ? inPage : [...document.querySelectorAll<HTMLElement>(ROWS)];
	const row = last ? rows[rows.length - 1] : rows[0];
	if (!row) {
		return false;
	}
	row.focus();
	row.scrollIntoView({ block: "nearest" });
	return true;
}

/** The list move a key press asks for from outside any song list, or null when it is not one. */
function entryMove(e: KeyboardEvent): ListMove | null {
	if (keyTakenElsewhere(e) || e.metaKey || e.ctrlKey || e.altKey) {
		return null;
	}
	const id = shortcutFor(e, "list")?.id;
	if (id === undefined || !isListMove(id)) {
		return null;
	}
	const target = e.target instanceof Element ? e.target : null;
	if (target?.closest(`[${KEY_LIST_ATTRIBUTE}]`)) {
		return null;
	}
	// The grid editor's keys come first while it shows, and app keys always do.
	const deckShown = document.querySelector("[data-deck]") !== null;
	if ((deckShown && shortcutFor(e, "deck")) || shortcutFor(e, "app")) {
		return null;
	}
	return id;
}

/**
 * A list move (J, K, G, the arrows) pressed with nothing focused that takes keys puts the cursor
 * in the page's song list, so the keyboard reaches the songs without a click first. The grid
 * editor's keys come first while it shows (its arrows move the grid, K is the metronome), and so
 * do app keys.
 */
export function useListEntryKeys() {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const move = entryMove(e);
			if (move !== null && focusListRow({ last: move === "listLast" })) {
				e.preventDefault();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}
