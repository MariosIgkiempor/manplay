import { type RefCallback, useCallback } from "react";

/** How long something takes to fade away once it has closed. */
export const EXIT_MS = 140;

/** A dialog's card shrinks back a touch as it fades. */
export const CARD_EXIT: Keyframe[] = [{ scale: 1 }, { scale: 0.97 }];

/**
 * Leaves a copy of `element`, a window-wide overlay (`fixed inset-0`), on the page for `EXIT_MS`
 * and fades it out. Each child marked `data-exit` also plays `exit`.
 */
function fadeAway(element: HTMLElement, exit: Keyframe[]) {
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
		return;
	}
	const copy = element.cloneNode(true);
	// Checked after the commit: still in the page means React only re-ran its refs (StrictMode
	// does that once in development), so it has not really gone.
	queueMicrotask(() => {
		if (element.isConnected || !(copy instanceof HTMLElement)) {
			return;
		}
		copy.inert = true;
		copy.style.pointerEvents = "none";
		copy.setAttribute("aria-hidden", "true");
		for (const part of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
			// Put back in the page, its entrance animations would play again.
			part.style.animation = "none";
			// Nor should it count as an open dialog to the page's shortcuts.
			part.removeAttribute("role");
		}
		document.body.appendChild(copy);
		const options = { duration: EXIT_MS, easing: "ease-in", fill: "forwards" } as const;
		const parts = [...copy.querySelectorAll<HTMLElement>("[data-exit]")];
		const animations = [
			copy.animate([{ opacity: 1 }, { opacity: 0 }], options),
			...parts.map((part) => part.animate(exit, options)),
		];
		void Promise.allSettled(animations.map((a) => a.finished)).then(() => copy.remove());
	});
}

/**
 * A ref for a modal overlay that lets it fade out after React removes it, so its owner can drop
 * it at once and it still closes smoothly. The copy left behind takes no presses.
 */
export function useExitGhost(exit: Keyframe[] = CARD_EXIT): RefCallback<HTMLElement> {
	return useCallback(
		(element: HTMLElement | null) => (element === null ? undefined : () => fadeAway(element, exit)),
		[exit],
	);
}
