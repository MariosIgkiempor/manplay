import { type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";
import { StatusSlotContext } from "#/context/detail-context.ts";

/** A labelled value in a status bar. */
export function Stat({ label, value }: { label: string; value: number | string }) {
	return (
		<span>
			{label}: <span className="text-foreground">{value}</span>
		</span>
	);
}

/**
 * Pins `children` to the bottom edge of the current view (page or slide-over). Content
 * scrolls behind it; the spacer keeps the last row clear.
 */
export function StatusBar({ children }: { children: ReactNode }) {
	const slot = useContext(StatusSlotContext);
	return (
		<>
			<div aria-hidden="true" className="h-9" />
			{slot &&
				createPortal(
					<div className="flex items-center gap-4 border-t bg-background/70 px-4 py-2 text-muted-foreground text-xs backdrop-blur-md">
						{children}
					</div>,
					slot,
				)}
		</>
	);
}
