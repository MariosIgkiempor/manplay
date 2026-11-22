import { useRouterState } from "@tanstack/react-router";
import { type RefObject, useLayoutEffect } from "react";

/**
 * Pages slide like a scroll towards what was clicked in the sidebar: a row below the open one
 * brings the new page up from below, a row above brings it down from above. Other page changes
 * only fade in. Only the page moves, on the compositor, so the sidebar and player keep running.
 */
export type PageDirection = "up" | "down";

/** The vertical middle and edges of the sidebar's current row, as `getBoundingClientRect` gives. */
export interface RowBox {
	top: number;
	bottom: number;
}

/** Which way the page moves for a click at `clickY`; a click on the current row itself is null. */
export function directionTo(clickY: number, current: RowBox | null): PageDirection | null {
	if (current === null) {
		return "down";
	}
	if (clickY >= current.top && clickY <= current.bottom) {
		return null;
	}
	return clickY > current.bottom ? "down" : "up";
}

/** How long a click's direction waits for the navigation it starts before it is dropped. */
const DIRECTION_TTL_MS = 1000;
let clearTimer: number | undefined;
/** Where the direction waits on the root element until the page change uses it. */
const DIRECTION_ATTRIBUTE = "data-nav-direction";

/** Sets the direction for the next page change; other navigations only cross-fade. */
export function markDirection(direction: PageDirection | null) {
	const root = document.documentElement;
	window.clearTimeout(clearTimer);
	if (direction === null) {
		root.removeAttribute(DIRECTION_ATTRIBUTE);
		return;
	}
	root.setAttribute(DIRECTION_ATTRIBUTE, direction);
	clearTimer = window.setTimeout(() => root.removeAttribute(DIRECTION_ATTRIBUTE), DIRECTION_TTL_MS);
}

/**
 * The direction a sidebar click left, if any. Every card that moves for this page change reads
 * it (the page, and the Files page's second pane); it is cleared once they all have.
 */
function takeDirection(): PageDirection | null {
	const root = document.documentElement;
	const value = root.getAttribute(DIRECTION_ATTRIBUTE);
	window.setTimeout(() => markDirection(null), 0);
	return value === "up" || value === "down" ? value : null;
}

/**
 * How far a page travels as it arrives: a good part of the card, so it reads as the content
 * scrolling into place rather than a nudge, but never more than a short screen's worth.
 */
const travelFor = (height: number) => Math.min(220, Math.round(height * 0.28));
/** Long and gently settling, like a scroll that eases to a stop. */
const SCROLL_MS = 520;
const FADE_MS = 200;
const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Eases `el` in whenever the page (the path, not its search) changes, and when it first shows. */
export function usePageMotion(el: RefObject<HTMLElement | null>) {
	const path = useRouterState({ select: (s) => s.location.pathname });
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs again each time the page changes
	useLayoutEffect(() => {
		const node = el.current;
		const direction = takeDirection();
		if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			return;
		}
		if (direction === null) {
			const fade = node.animate([{ opacity: 0 }, { opacity: 1 }], {
				duration: FADE_MS,
				easing: "ease-out",
			});
			return () => fade.cancel();
		}
		const travel = travelFor(node.clientHeight);
		const from = direction === "down" ? travel : -travel;
		// The content is all there from the start, as in a real scroll; only its first moment
		// fades, so the jump from the old page is not a hard cut.
		const motion = node.animate(
			[
				{ opacity: 0.2, transform: `translateY(${from}px)` },
				{ opacity: 1, offset: 0.35 },
				{ opacity: 1, transform: "translateY(0)" },
			],
			{ duration: SCROLL_MS, easing: EASE_OUT },
		);
		return () => motion.cancel();
	}, [el, path]);
}
