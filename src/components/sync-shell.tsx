import type { ReactNode } from "react";
import { cn } from "#/lib/utils.ts";

/** Where a sync screen is shown: the slide-over, or a destination's own page. */
export type SyncShellVariant = "drawer" | "page";

/**
 * The frame of every sync screen: its content with a footer that stays in view and runs to the
 * edges of its container, border included. `drawer` is the slide-over, which scrolls the content
 * itself. `page` is a destination's page, which scrolls with the page header (so the header can
 * scroll away) and lines up with its 1.5rem padding; its footer is pinned to the bottom.
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
				"flex flex-col [--sync-top:0px]",
				variant === "page" ? "flex-1 [--diff-inset:1.5rem]" : "h-full min-h-0 [--diff-inset:1rem]",
			)}
		>
			<div
				className={cn(
					"flex-1",
					variant === "drawer" && "min-h-0 overflow-y-auto overscroll-contain",
				)}
			>
				{children}
			</div>
			{footer && (
				<div className="sticky bottom-0 z-30 shrink-0 space-y-3 border-t bg-background px-[var(--diff-inset)] py-3">
					{footer}
				</div>
			)}
		</div>
	);
}
