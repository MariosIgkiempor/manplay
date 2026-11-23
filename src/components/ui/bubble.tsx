import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type BubblePosition, type BubbleSide, bubblePosition } from "#/lib/bubble-position.ts";
import { cn } from "#/lib/utils.ts";

/** How every hint in the app looks: the hover hints and what a confirm button says when armed. */
export const HINT_SURFACE =
	"max-w-64 rounded-md border bg-popover px-2 py-1 text-popover-foreground text-xs shadow-md";

/**
 * A small note floating beside `anchor`, above everything else and never in the way of the
 * pointer. It is placed once it has been measured, so it does not flash in the wrong spot.
 */
export function Bubble({
	anchor,
	side = "top",
	role = "tooltip",
	className,
	children,
}: {
	anchor: Element;
	side?: BubbleSide;
	role?: "tooltip" | "status";
	className?: string;
	children: ReactNode;
}) {
	const bubble = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<BubblePosition | null>(null);
	// Measured again whenever what it says or points at changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `children` changes the size measured
	useLayoutEffect(() => {
		const own = bubble.current;
		if (own) {
			setPosition(
				bubblePosition(
					anchor.getBoundingClientRect(),
					{ width: own.offsetWidth, height: own.offsetHeight },
					{ width: window.innerWidth, height: window.innerHeight },
					side,
				),
			);
		}
	}, [anchor, side, children]);
	return createPortal(
		<div
			ref={bubble}
			role={role}
			style={{ left: position?.left ?? 0, top: position?.top ?? 0 }}
			className={cn(
				HINT_SURFACE,
				"pointer-events-none fixed z-[80] whitespace-pre-line",
				position
					? "fade-in-0 animate-in animation-duration-100 motion-reduce:animate-none"
					: "invisible",
				className,
			)}
		>
			{children}
		</div>,
		document.body,
	);
}
