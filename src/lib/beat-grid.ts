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

/** BPM from tap times (ms), from the last few taps; null until there are enough. */
export function tapBpm(taps: readonly number[]): number | null {
	const recent = taps.slice(-9);
	if (recent.length < 4) {
		return null;
	}
	const first = recent[0] ?? 0;
	const last = recent.at(-1) ?? 0;
	const beat = (last - first) / (recent.length - 1);
	return beat > 0 ? Math.round((60_000 / beat) * 100) / 100 : null;
}

export function sameGrid(a: Grid, b: Grid): boolean {
	return (
		a.bpm === b.bpm && Math.abs(a.firstBeat - b.firstBeat) < 1e-6 && a.barOffset === b.barOffset
	);
}
