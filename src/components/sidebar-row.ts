import { cn } from "#/lib/utils.ts";

/** Shared geometry of sidebar rows: 16px icon, label, right-aligned count, 20px trailing slot. */
export const rowBase =
	"flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2 text-sm text-muted-foreground";
export const rowIdle = "hover:bg-muted hover:text-foreground";
export const rowActive = "bg-muted font-medium text-foreground";

export function rowClass(active: boolean) {
	return cn("flex items-center rounded-md pr-1", active ? rowActive : rowIdle);
}

/** Indent of a row under a group heading, past the heading's icon. */
export const CHILD_INDENT = 22;
/** Left padding of a row under a group heading. */
export const CHILD_PAD = 8 + CHILD_INDENT;

/** Classes that show a heading's + only while the heading is hovered or focused. */
export const HOVER_ACTION =
	"mr-0.5 opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100";
