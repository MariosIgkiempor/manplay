import type { ReactNode } from "react";
import { cn } from "#/lib/utils.ts";

/** Right-aligned song count. */
export function RowCount({ n, className }: { n: number; className?: string }) {
	return <span className={cn("ml-auto pl-2 text-xs tabular-nums", className)}>{n}</span>;
}

/** A sidebar section's heading, with an optional action (e.g. +) lined up with the row ends. */
export function SectionLabel({ children, action }: { children: string; action?: ReactNode }) {
	return (
		<div className="flex items-center justify-between pt-1 pr-1 pb-1 pl-2">
			<span className="font-medium text-muted-foreground text-xs">{children}</span>
			{action}
		</div>
	);
}
