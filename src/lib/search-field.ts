import type { KeyboardEvent } from "react";
import { cn } from "#/lib/utils.ts";

/**
 * The look every search and filter field shares: no border and no fill, in any state. The
 * magnifier turns the accent colour while it holds a query. Height is the caller's.
 */
export const SEARCH_FIELD = "flex min-w-0 cursor-text items-center gap-1.5 rounded-md px-2";

/** Classes for a shell's input: it fills the open field and takes no room while folded. */
export function searchInputClass(open: boolean): string {
	return cn(
		"h-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60",
		"w-0",
		open && "flex-1",
	);
}

/**
 * Escape in a search field: it first empties the field, then folds it. Either way the key goes no
 * further, so a second Escape still reaches the page.
 */
export function escapeSearch(e: KeyboardEvent<HTMLInputElement>, value: string, clear: () => void) {
	if (e.key !== "Escape") {
		return;
	}
	e.preventDefault();
	e.stopPropagation();
	if (value !== "") {
		clear();
	} else {
		e.currentTarget.blur();
	}
}
