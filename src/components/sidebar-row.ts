import { cn } from "#/lib/utils.ts";

/** Shared geometry of sidebar rows: 16px icon, label, right-aligned count, 20px trailing slot. */
export const rowBase =
	"flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2 text-sm text-muted-foreground";
export const rowIdle = "hover:bg-muted hover:text-foreground";
export const rowActive = "bg-muted font-medium text-foreground";

export function rowClass(active: boolean) {
	return cn("flex items-center rounded-md pr-1", active ? rowActive : rowIdle);
}
