import type { ReactNode } from "react";
import { cn } from "#/lib/utils.ts";

/** Where a sync screen is shown: the slide-over, or a destination's own page. */
export type SyncShellVariant = "drawer" | "page";

/**
 * The frame of every sync screen: a scrolling area with a footer under it that never scrolls and
 * runs to the edges of its container, border included. `page` is a destination's page, whose
 * content lines up with the page header's 1.5rem padding; `drawer` is the slide-over.
 */
export function SyncShell({
	variant,
	footer,
	children,
}: {
	variant: SyncShellVariant;
	footer?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex h-full min-h-0 flex-col [--sync-top:0px]",
				variant === "page" ? "[--diff-inset:1.5rem]" : "[--diff-inset:1rem]",
			)}
		>
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
			{footer && (
				<div className="shrink-0 space-y-3 border-t bg-background px-[var(--diff-inset)] py-3">
					{footer}
				</div>
			)}
		</div>
	);
}
