/** A point in the window, in CSS pixels from its top left. */
export interface Point {
	x: number;
	y: number;
}

let last: Point | null = null;

if (typeof window !== "undefined") {
	window.addEventListener(
		"pointermove",
		(e) => {
			last = { x: e.clientX, y: e.clientY };
		},
		{ passive: true, capture: true },
	);
	// The pointer left the window: a shortcut pressed now has no point to open at.
	document.documentElement.addEventListener("mouseleave", () => {
		last = null;
	});
}

/** Where the mouse pointer is over the window, or null when it is outside it or has not moved. */
export function pointerInWindow(): Point | null {
	return last;
}
