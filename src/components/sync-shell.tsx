import type { ReactNode } from "react";
import { cn } from "#/lib/utils.ts";

/**
 * The frame of every sync screen: a scrolling area with a footer under it that never scrolls and
 * runs to the edges of its container, border included. `panel` is the destination panel, which
 * pads its content by 1.25rem; `drawer` is the slide-over, which gives its content all the room.
 */
export function SyncShell({
	variant,
	footer,
	children,
}: {
	variant: "drawer" | "panel";
	footer?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex h-full min-h-0 flex-col [--sync-top:0px]",
				variant === "panel" ? "-mx-5 [--diff-inset:1.25rem]" : "[--diff-inset:1rem]",
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
