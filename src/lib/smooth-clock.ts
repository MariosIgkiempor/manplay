/** Farther than this from the audio's position and the shown position jumps (a seek). */
const SNAP = 0.25;
/** The audio's readings are compared over two spans of this many seconds. */
const SPAN = 0.5;
/** How fast the shown clock may run ahead of or behind real time while it catches up. */
const CATCH_UP = 0.04;

export interface SmoothClock {
	/** Seconds shown last frame. */
	shown: number;
	/** `performance.now()` of the last frame. */
	at: number;
	/**
	 * How far the audio's clock was ahead of the wall clock, at most, in the span being measured
	 * now and in the one before it. Null until the audio has been read while playing.
	 */
	lead: { now: number; before: number; since: number } | null;
}

export function createSmoothClock(seconds: number, nowMs: number): SmoothClock {
	return { shown: seconds, at: nowMs, lead: null };
}

/**
 * The position to draw this frame. The audio element's clock moves in steps and is never ahead
 * of the sound, so each reading is at or a little behind the truth: the largest lead it showed
 * over the wall clock lately is the best estimate of where the sound is. The shown position
 * runs with the wall clock and drifts toward that estimate, so it moves the same distance every
 * frame instead of surging at each of the audio's steps.
 */
export function tick(clock: SmoothClock, actual: number, nowMs: number, playing: boolean): number {
	const wall = nowMs / 1000;
	const elapsed = (nowMs - clock.at) / 1000;
	clock.at = nowMs;
	if (!playing || Math.abs(actual - (clock.shown + elapsed)) > SNAP) {
		clock.shown = actual;
		clock.lead = playing ? { now: actual - wall, before: actual - wall, since: wall } : null;
		return actual;
	}
	const lead = clock.lead ?? { now: actual - wall, before: actual - wall, since: wall };
	if (wall - lead.since > SPAN) {
		lead.before = lead.now;
		lead.now = actual - wall;
		lead.since = wall;
	} else {
		lead.now = Math.max(lead.now, actual - wall);
	}
	clock.lead = lead;
	const target = wall + Math.max(lead.now, lead.before);
	const predicted = clock.shown + elapsed;
	const reach = CATCH_UP * elapsed;
	clock.shown = predicted + Math.max(-reach, Math.min(reach, target - predicted));
	return clock.shown;
}
