import { useMatchRoute, useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";
import { cn } from "#/lib/utils.ts";

/**
 * Shared geometry of sidebar rows: a 20px gutter on the left where a chevron folds a group or
 * tag, the 16px icon, the label, and the count flush right. Nothing is reserved on the right: a
 * row's hover button (+, Browse files) takes the count's place while hovered.
 */
export const GUTTER = 20;
export const rowBase =
	"flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-5 text-sm text-muted-foreground";
export const rowIdle = "transition-colors hover:bg-foreground/[0.04] hover:text-foreground";
/**
 * The open page. Its raised chip is drawn once for the whole sidebar (`SidebarHighlight`), so it
 * can glide between rows; `CURRENT_ROW` marks the row for that, for scrolling it into view, and
 * for telling which way a click moves the page.
 */
export const CURRENT_ROW = "sidebar-current";

/**
 * The open page's row. A destination's page also marks its group (Export), so the deepest row,
 * the last marked, is the page itself.
 */
export function currentRow(within: ParentNode): Element | null {
	const rows = within.querySelectorAll(`.${CURRENT_ROW}`);
	return rows.item(rows.length - 1);
}
export const rowActive = `${CURRENT_ROW} font-medium text-foreground`;

/**
 * Marks a row's link or button as a page in the sidebar's order, holding the page's name. A page
 * change passes the pages listed between the old and the new one (`page-transition.ts`).
 */
export const PAGE_ROW_ATTRIBUTE = "data-page-row";
export const pageRow = (name: string) => ({ [PAGE_ROW_ATTRIBUTE]: name });

export function rowClass(active: boolean) {
	return cn("flex items-center rounded-md pr-2", active ? rowActive : rowIdle);
}

/** Indent of a row under a group heading: its icon sits under the heading's name. */
export const CHILD_INDENT = 24;
/** Left padding of a row under a group heading. */
export const CHILD_PAD = GUTTER + CHILD_INDENT;
/** Left edge of a row's chevron, `pad` being the row's left padding. */
export const chevronLeft = (pad: number) => pad - 18;

/** A chevron in a row's left gutter that folds what is under the row. */
export const CHEVRON =
	"-translate-y-1/2 absolute top-1/2 grid size-4 place-items-center rounded text-muted-foreground hover:bg-background/60 hover:text-foreground";

/** A row's hover button over its count at the right end (the count hides meanwhile). */
export const HOVER_END =
	"-translate-y-1/2 absolute top-1/2 right-1.5 opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100";
/** What hides under `HOVER_END` while the row is hovered. */
export const UNDER_HOVER_END = "group-focus-within/row:invisible group-hover/row:invisible";

/** Classes that show a heading's + only while the heading is hovered or focused. */
export const HOVER_ACTION = HOVER_END;

/**
 * `useMatchRoute` for marking the current row, matched against the page being opened. The
 * router's own matches the old page until the new one has finished loading, which marks a row
 * only after its page shows; the page's motion reads the marked row while the page changes.
 */
export function useRowMatch(): ReturnType<typeof useMatchRoute> {
	const matchRoute = useMatchRoute();
	const pending = useRouterState({ select: (s) => s.status === "pending" });
	return useCallback(
		((opts: Parameters<typeof matchRoute>[0]) => matchRoute({ ...opts, pending })) as ReturnType<
			typeof useMatchRoute
		>,
		[matchRoute, pending],
	);
}
