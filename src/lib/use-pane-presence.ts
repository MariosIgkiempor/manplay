import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

/** How long a side pane takes to open or shut. */
const PANE_MS = 220;
const EASE_IN = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EASE_OUT = "cubic-bezier(0.4, 0, 1, 1)";
/** How far the pane travels as it slides, in pixels: enough to read as coming from the edge. */
const SLIDE_PX = 48;

/**
 * Lifts a shutting pane out of the row where it stands, so the page beside it takes the room at
 * once and the pane leaves over the canvas. Returns how to put it back.
 */
function liftOut(el: HTMLElement): () => void {
	const { offsetTop, offsetLeft, offsetWidth, offsetHeight } = el;
	const before = el.getAttribute("style") ?? "";
	Object.assign(el.style, {
		position: "absolute",
		top: `${offsetTop}px`,
		left: `${offsetLeft}px`,
		width: `${offsetWidth}px`,
		height: `${offsetHeight}px`,
		// It has no card of its own, so it takes the canvas's colour to cover the page it leaves over.
		background: "var(--canvas)",
		zIndex: "20",
		pointerEvents: "none",
	});
	return () => el.setAttribute("style", before);
}

/**
 * Slides `el` in from the right, or out to the right; null with reduced motion. Only its position
 * and opacity move, never its width, so the page beside it lays out once rather than every frame.
 */
function slide(el: HTMLElement, opening: boolean): Animation | null {
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
		return null;
	}
	const open = { translate: "0 0", opacity: 1 };
	const shut = { translate: `${SLIDE_PX}px 0`, opacity: 0 };
	if (opening) {
		return el.animate([shut, open], { duration: PANE_MS, easing: EASE_IN });
	}
	const putBack = liftOut(el);
	const motion = el.animate([open, shut], {
		duration: PANE_MS - 60,
		easing: EASE_OUT,
		fill: "forwards",
	});
	const restore = () => putBack();
	motion.finished.then(restore, restore);
	return motion;
}

type PaneChange = "opening" | "closing";

/** Whether the pane is opening, shutting, or neither (a new view in an open pane). */
function paneChange(wasOpen: boolean, isOpen: boolean): PaneChange | null {
	if (wasOpen === isOpen) {
		return null;
	}
	return isOpen ? "opening" : "closing";
}

/** Runs the change; `letGo` drops the shut pane's content, once it has slid shut. */
function move(el: HTMLElement | null, change: PaneChange, letGo: () => void): Animation | null {
	const motion = el ? slide(el, change === "opening") : null;
	if (change === "closing") {
		if (motion) {
			motion.onfinish = letGo;
		} else {
			letGo();
		}
	}
	return motion;
}

/**
 * Opens and shuts a side pane by sliding it a short way in from the right edge and out again.
 * The page beside it takes its new width at once, in one layout, instead of reflowing every frame
 * of a width animation. While shutting the pane keeps showing what it showed (`shown`), then lets
 * go. With reduced motion it opens and shuts at once.
 */
export function usePanePresence<T>(value: T | null, pane: RefObject<HTMLElement | null>): T | null {
	const [shown, setShown] = useState<T | null>(value);
	const wasOpen = useRef(false);

	useEffect(() => {
		if (value !== null) {
			setShown(value);
		}
	}, [value]);

	const isOpen = value !== null;

	useLayoutEffect(() => {
		const change = paneChange(wasOpen.current, isOpen);
		wasOpen.current = isOpen;
		if (change === null) {
			return;
		}
		const motion = move(pane.current, change, () => setShown(null));
		return () => motion?.cancel();
	}, [isOpen, pane]);

	return value ?? shown;
}
