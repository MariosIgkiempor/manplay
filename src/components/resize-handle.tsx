import type { KeyboardEvent, PointerEvent } from "react";
import { cn } from "#/lib/utils.ts";

/**
 * The draggable edge of a pane: drag to resize, arrow keys to step, double-click for the starting
 * width. `edge` is the side of the pane it sits on; dragging towards the pane makes it narrower.
 * `onWidth` gets the raw width, so a caller can treat a drag far below `min` as "collapse".
 */
export function ResizeHandle({
	edge,
	width,
	min,
	initial,
	label,
	onWidth,
	inGap = false,
}: {
	edge: "left" | "right";
	width: number;
	min: number;
	initial: number;
	label: string;
	onWidth: (w: number) => void;
	/** The pane is a card: the handle fills the gap outside its edge instead of straddling it. */
	inGap?: boolean;
}) {
	const sign = edge === "left" ? -1 : 1;
	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = width;
		const el = e.currentTarget;
		el.setPointerCapture(e.pointerId);
		document.body.style.cursor = "col-resize";
		const move = (ev: globalThis.PointerEvent) => onWidth(startW + sign * (ev.clientX - startX));
		const up = () => {
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
			el.removeEventListener("pointercancel", up);
			document.body.style.cursor = "";
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
		el.addEventListener("pointercancel", up);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const step = e.shiftKey ? 64 : 16;
		const wider = edge === "left" ? "ArrowLeft" : "ArrowRight";
		const narrower = edge === "left" ? "ArrowRight" : "ArrowLeft";
		if (e.key === wider) {
			e.preventDefault();
			onWidth(width + step);
		} else if (e.key === narrower) {
			e.preventDefault();
			onWidth(width - step);
		}
	};
	return (
		// biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA pattern for a splitter
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={width}
			aria-valuemin={min}
			tabIndex={0}
			data-hint="Drag to resize, double-click to reset"
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
			onDoubleClick={() => onWidth(initial)}
			className={cn(
				"group absolute inset-y-0 z-20 w-2 cursor-col-resize outline-none",
				edge === "left" ? (inGap ? "-left-2" : "-left-1") : inGap ? "-right-2" : "-right-1",
			)}
		>
			<div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary group-active:bg-primary" />
		</div>
	);
}
