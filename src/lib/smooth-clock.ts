/** Farther than this from the audio's position and the shown position jumps (a seek). */
const SNAP = 0.25;
/** Share of the remaining gap closed each frame, so small corrections never show as a jump. */
const EASE = 0.1;

export interface SmoothClock {
	/** Seconds shown last frame. */
	shown: number;
	/** `performance.now()` of the last frame. */
	at: number;
}

/**
 * The position to draw this frame: last frame's plus the time since, eased toward where the
 * audio says it is. The audio element's clock moves in steps; this one moves every frame.
 */
export function tick(clock: SmoothClock, actual: number, nowMs: number, playing: boolean): number {
	const predicted = playing ? clock.shown + (nowMs - clock.at) / 1000 : actual;
	const gap = actual - predicted;
	clock.shown = Math.abs(gap) > SNAP ? actual : predicted + gap * EASE;
	clock.at = nowMs;
	return clock.shown;
}
