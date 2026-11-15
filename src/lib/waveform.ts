import type { TrackAnalysis } from "#/lib/api.ts";

export interface Column {
	/** 0–1. */
	height: number;
	/** 0–1: how much high-frequency content, drawn whiter. */
	white: number;
}

export function column(byte: number): Column {
	return { height: (byte & 0x1f) / 31, white: (byte >> 5) / 7 };
}

/**
 * `n` columns across the whole track: the root mean square of the heights and the average
 * whiteness in each slice, the way a CDJ draws its overview.
 */
export function overview(detail: readonly number[], n: number): Column[] {
	if (detail.length === 0 || n <= 0) {
		return [];
	}
	const out: Column[] = [];
	for (let i = 0; i < n; i++) {
		const lo = Math.floor((i * detail.length) / n);
		const hi = Math.max(lo + 1, Math.floor(((i + 1) * detail.length) / n));
		let squares = 0;
		let white = 0;
		for (let j = lo; j < hi; j++) {
			const c = column(detail[j] ?? 0);
			squares += c.height * c.height;
			white += c.white;
		}
		const len = hi - lo;
		out.push({ height: Math.sqrt(squares / len), white: white / len });
	}
	return out;
}

export interface Beat {
	/** Seconds. */
	time: number;
	downbeat: boolean;
}

/** Beats of the grid between `from` and `to` seconds. */
export function beatsBetween(a: TrackAnalysis, from: number, to: number): Beat[] {
	if (a.gridBpm === null || a.gridBpm <= 0) {
		return [];
	}
	const period = 60 / a.gridBpm;
	const beats: Beat[] = [];
	const start = Math.max(0, Math.ceil((from - a.firstBeat) / period));
	for (let k = start; ; k++) {
		const time = a.firstBeat + k * period;
		if (time > to || time > a.duration) {
			break;
		}
		beats.push({ time, downbeat: (a.barOffset + k) % 4 === 0 });
	}
	return beats;
}

/** rekordbox-style blue, whiter where the sound is brighter; `alpha` dims unplayed parts. */
export function colour(white: number, alpha = 1): string {
	const mix = (a: number, b: number) => Math.round(a + (b - a) * white);
	return `rgba(${mix(32, 235)}, ${mix(110, 245)}, ${mix(235, 255)}, ${alpha})`;
}
