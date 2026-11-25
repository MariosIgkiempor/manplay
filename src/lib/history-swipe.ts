/**
 * A two-finger sideways swipe on a trackpad goes back or forward, as in a browser. The webview
 * reports the swipe as a run of sideways wheel events; this reads one run as one gesture.
 */
export type SwipeDirection = "back" | "forward";

/** Pixels of sideways scroll that make a swipe count. */
export const SWIPE_DISTANCE = 140;
/** A pause longer than this ends a gesture; a trackpad's glide keeps it going. */
export const GESTURE_GAP_MS = 200;

export interface SwipeState {
	/** Sideways scroll so far in this gesture: negative when the fingers move right (back). */
	dx: number;
	/** The gesture has already gone back or forward; the rest of it does nothing. */
	fired: boolean;
	/** When the last event of the gesture came, in ms. */
	lastAt: number;
}

export const IDLE_SWIPE: SwipeState = { dx: 0, fired: false, lastAt: Number.NEGATIVE_INFINITY };

export interface WheelStep {
	deltaX: number;
	deltaY: number;
	at: number;
}

export interface SwipeStep {
	state: SwipeState;
	/** How far along the swipe is, -1 (forward) to 1 (back), for the arrow at the window's edge. */
	progress: number;
	/** Where to go now, once per gesture. */
	go: SwipeDirection | null;
}

/** Takes one wheel event into the gesture. Mostly-vertical scrolling never starts a swipe. */
export function swipeStep(previous: SwipeState, e: WheelStep): SwipeStep {
	const fresh = e.at - previous.lastAt > GESTURE_GAP_MS;
	const state = fresh ? IDLE_SWIPE : previous;
	const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
	if (state.dx === 0 && !sideways) {
		return { state: { ...IDLE_SWIPE, fired: state.fired, lastAt: e.at }, progress: 0, go: null };
	}
	const dx = state.dx + e.deltaX;
	const progress = Math.max(-1, Math.min(1, -dx / SWIPE_DISTANCE));
	const go: SwipeDirection | null =
		state.fired || Math.abs(progress) < 1 ? null : progress > 0 ? "back" : "forward";
	return { state: { dx, fired: state.fired || go !== null, lastAt: e.at }, progress, go };
}
