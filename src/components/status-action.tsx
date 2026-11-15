import { type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";
import { SaveSlotContext } from "#/context/status-context.ts";
import { cn } from "#/lib/utils.ts";

/**
 * Puts something an editor offers (e.g. Revert) in the status bar, beside its save state, while
 * the editor is open. Renders nothing without a status bar.
 */
export function StatusPortal({ children }: { children: ReactNode }) {
	const slot = useContext(SaveSlotContext);
	return slot ? createPortal(children, slot) : null;
}

/** A small pill-shaped button for the status bar. */
export function StatusButton({
	children,
	onClick,
	title,
	className,
}: {
	children: ReactNode;
	onClick: () => void;
	title?: string;
	className?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			className={cn(
				"flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-foreground outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5",
				className,
			)}
		>
			{children}
		</button>
	);
}
