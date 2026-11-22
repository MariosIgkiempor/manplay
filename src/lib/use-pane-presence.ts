import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

/** How long a side pane takes to open or shut. */
const PANE_MS = 240;
const EASE = "cubic-bezier(0.3, 0, 0.2, 1)";
/** The gap between cards, which a shut pane gives back too. */
const GAP_PX = 8;

/** Grows `el` open, or shrinks it shut and holds it there; null with reduced motion. */
function slide(el: HTMLElement, opening: boolean, width: number): Animation | null {
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
		return null;
	}
	const open = { width: `${width}px`, marginLeft: "0px", opacity: 1 };
	const shut = { width: "0px", marginLeft: `-${GAP_PX}px`, opacity: 0 };
	return el.animate(opening ? [shut, open] : [open, shut], {
		duration: PANE_MS,
		easing: EASE,
		fill: opening ? "none" : "forwards",
	});
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
function move(
	el: HTMLElement | null,
	change: PaneChange,
	width: number,
	letGo: () => void,
): Animation | null {
	const motion = el ? slide(el, change === "opening", width) : null;
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
 * Opens and shuts a side pane by growing and shrinking its width, so the page beside it makes
 * room smoothly instead of jumping. While shutting it keeps showing what it showed (`shown`),
 * then lets go. With reduced motion it opens and shuts at once.
 */
export function usePanePresence<T>(
	value: T | null,
	pane: RefObject<HTMLElement | null>,
	width: number,
): T | null {
	const [shown, setShown] = useState<T | null>(value);
	const wasOpen = useRef(false);

	useEffect(() => {
		if (value !== null) {
			setShown(value);
		}
	}, [value]);

	// The width at the moment it opens or shuts; resizing an open pane does not animate.
	const widthRef = useRef(width);
	widthRef.current = width;
	const isOpen = value !== null;

	useLayoutEffect(() => {
		const change = paneChange(wasOpen.current, isOpen);
		wasOpen.current = isOpen;
		if (change === null) {
			return;
		}
		const motion = move(pane.current, change, widthRef.current, () => setShown(null));
		return () => motion?.cancel();
	}, [isOpen, pane]);

	return value ?? shown;
}
