/** A `performance.now()` reading. */
export type Milliseconds = number;
export type Bpm = number;

/** What a run of taps says about the tempo. */
export interface TapReading {
	bpm: Bpm;
	/** Taps the reading rests on, once badly-timed ones are left out. */
	taps: number;
}

/** A pause this long between taps starts a new run. */
export const TAP_RUN_GAP: Milliseconds = 2000;
/** Fewer taps than this give no reading: the first few gaps vary too much. */
const MIN_TAPS = 4;
/** Only the latest taps count, so a tempo that drifts while tapping is followed. */
const MAX_TAPS = 16;
/** A tap further than this share of a beat off the fitted line is left out. */
const OUTLIER = 0.25;

/** The taps of the current run with one more at `now`: a long pause starts again. */
export function addTap(run: readonly Milliseconds[], now: Milliseconds): Milliseconds[] {
	const last = run.at(-1);
	return last !== undefined && now - last < TAP_RUN_GAP ? [...run, now] : [now];
}

interface Point {
	beat: number;
	at: Milliseconds;
}

/** Least squares line through the points: milliseconds per beat and where beat 0 falls. */
function fit(points: readonly Point[]): { beatLength: Milliseconds; origin: Milliseconds } {
	const n = points.length;
	const meanBeat = points.reduce((s, p) => s + p.beat, 0) / n;
	const meanAt = points.reduce((s, p) => s + p.at, 0) / n;
	let covariance = 0;
	let variance = 0;
	for (const p of points) {
		covariance += (p.beat - meanBeat) * (p.at - meanAt);
		variance += (p.beat - meanBeat) ** 2;
	}
	const beatLength = variance > 0 ? covariance / variance : 0;
	return { beatLength, origin: meanAt - beatLength * meanBeat };
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] ?? 0)
		: ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * The tempo of a run of taps, or null until there are enough. Each tap is counted as the beat
 * its gap suggests, so a skipped beat does not halve the tempo; then a line is fitted through
 * them and taps far off it (a stumble, a double tap) are left out before fitting again.
 */
export function tapTempo(run: readonly Milliseconds[]): TapReading | null {
	const recent = run.slice(-MAX_TAPS);
	if (recent.length < MIN_TAPS) {
		return null;
	}
	const gaps = recent.slice(1).map((t, i) => t - (recent[i] ?? t));
	const typical = median(gaps);
	if (!(typical > 0)) {
		return null;
	}
	let beat = 0;
	const points: Point[] = recent.map((at, i) => {
		if (i > 0) {
			beat += Math.max(1, Math.round((gaps[i - 1] ?? typical) / typical));
		}
		return { beat, at };
	});
	const first = fit(points);
	const kept = points.filter(
		(p) =>
			Math.abs(p.at - (first.origin + first.beatLength * p.beat)) <= OUTLIER * first.beatLength,
	);
	const final = kept.length >= MIN_TAPS ? fit(kept) : first;
	if (!(final.beatLength > 0)) {
		return null;
	}
	return {
		bpm: Math.round((60_000 / final.beatLength) * 100) / 100,
		taps: kept.length >= MIN_TAPS ? kept.length : points.length,
	};
}
