import { cn } from "#/lib/utils.ts";

/**
 * The look every search and filter field shares: no border, a faint shade on hover, a stronger
 * one while it is focused or `active` (holding a query). Height is the caller's.
 */
export const searchFieldClass = (active: boolean) =>
	cn(
		"flex min-w-0 cursor-text items-center gap-1.5 rounded-md px-2 transition-colors hover:bg-muted/40 focus-within:bg-muted/60",
		active && "bg-muted/60",
	);
