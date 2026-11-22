import { type ReactNode, useRef } from "react";
import { createPortal } from "react-dom";
import { ResizeHandle } from "#/components/resize-handle.tsx";
import { useSplitSlot } from "#/context/split-slot.ts";
import { CARD } from "#/lib/page-layout.ts";
import { usePageMotion } from "#/lib/page-transition.ts";
import { usePaneWidth } from "#/lib/use-pane-width.ts";
import { cn } from "#/lib/utils.ts";

const INITIAL = 520;
const MIN = 320;
/** Leaves the page's own pane at least this much room. */
const PAGE_ROOM = 420;

/**
 * The Files page's second pane, in a card of its own beside the page's card. Drag the gap on its
 * left to resize it; double-click the gap for the starting width.
 */
export function FilesSplitCard({ children }: { children: ReactNode }) {
	const slot = useSplitSlot();
	const [width, setWidth] = usePaneWidth({
		key: "manplay.files-split-width",
		initial: INITIAL,
		min: MIN,
		max: () => window.innerWidth - PAGE_ROOM,
	});
	// Arrives the same way as the page beside it.
	const cardRef = useRef<HTMLElement>(null);
	usePageMotion(cardRef);
	if (!slot) {
		return null;
	}
	return createPortal(
		<section
			ref={cardRef}
			aria-label="Second pane"
			style={{ width }}
			className={cn(CARD, "relative flex max-w-[60%] shrink-0 flex-col")}
		>
			<ResizeHandle
				edge="left"
				inGap
				width={width}
				min={MIN}
				initial={INITIAL}
				label="Resize second pane"
				onWidth={setWidth}
			/>
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
				{children}
			</div>
		</section>,
		slot,
	);
}
