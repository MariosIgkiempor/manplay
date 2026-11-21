import type { TrackAnalysis } from "#/lib/api.ts";

/** A constant-tempo beat grid, as kept with a track's analysis. */
export interface Grid {
	bpm: number | null;
	/** Seconds to the first beat. */
	firstBeat: number;
	/** Place in the bar of the first beat, 0 for a downbeat. */
	barOffset: number;
}

export const gridOf = (a: TrackAnalysis): Grid => ({
	bpm: a.gridBpm,
	firstBeat: a.firstBeat,
	barOffset: a.barOffset,
});

export const withGrid = (a: TrackAnalysis, g: Grid): TrackAnalysis => ({
	...a,
	gridBpm: g.bpm,
	firstBeat: g.firstBeat,
	barOffset: g.barOffset,
});

const mod4 = (n: number) => ((n % 4) + 4) % 4;

/** The same grid, described from its first beat at or after 0 s (as it is saved). */
export function normalize(g: Grid): Grid {
	if (g.bpm === null || g.bpm <= 0) {
		return { bpm: null, firstBeat: 0, barOffset: 0 };
	}
	const period = 60 / g.bpm;
	const steps = Math.ceil(-g.firstBeat / period - 1e-9);
	return {
		bpm: g.bpm,
		firstBeat: g.firstBeat + steps * period,
		barOffset: mod4(g.barOffset + steps),
	};
}

/** Moves every beat by `seconds`. */
export const nudge = (g: Grid, seconds: number): Grid =>
	normalize({ ...g, firstBeat: g.firstBeat + seconds });

/** Puts a downbeat at `time`, keeping the tempo. */
export const downbeatAt = (g: Grid, time: number): Grid =>
	normalize({ ...g, firstBeat: time, barOffset: 0 });

/** Moves where the bar starts by `beats`, keeping the beats where they are. */
export const shiftBar = (g: Grid, beats: number): Grid => ({
	...g,
	barOffset: mod4(g.barOffset - beats),
});

/**
 * A new tempo, keeping the beat nearest `anchor` (seconds) where it is, so the part being
 * listened to stays lined up.
 */
export function setBpm(g: Grid, bpm: number, anchor: number): Grid {
	if (!(bpm > 0)) {
		return g;
	}
	if (g.bpm === null || g.bpm <= 0) {
		return normalize({ bpm, firstBeat: anchor, barOffset: 0 });
	}
	const period = 60 / g.bpm;
	const k = Math.round((anchor - g.firstBeat) / period);
	const pinned = g.firstBeat + k * period;
	return normalize({ bpm, firstBeat: pinned - k * (60 / bpm), barOffset: g.barOffset });
}

/** The tempo rounded to a whole BPM, keeping the beat nearest `anchor` where it is. */
export const roundBpm = (g: Grid, anchor: number): Grid =>
	g.bpm === null ? g : setBpm(g, Math.round(g.bpm), anchor);

/** A beat of the grid: when it falls, and whether it is beat 1 of a bar. */
export interface Beat {
	time: number;
	downbeat: boolean;
}

/** The grid's beats after `from` up to and including `to` (seconds). */
export function beatsBetween(g: Grid, from: number, to: number): Beat[] {
	if (g.bpm === null || g.bpm <= 0 || to <= from) {
		return [];
	}
	const period = 60 / g.bpm;
	const beats: Beat[] = [];
	const first = Math.max(0, Math.floor((from - g.firstBeat) / period) + 1);
	for (let k = first; g.firstBeat + k * period <= to; k++) {
		beats.push({ time: g.firstBeat + k * period, downbeat: mod4(g.barOffset + k) === 0 });
	}
	return beats;
}

export function sameGrid(a: Grid, b: Grid): boolean {
	return (
		a.bpm === b.bpm && Math.abs(a.firstBeat - b.firstBeat) < 1e-6 && a.barOffset === b.barOffset
	);
}
