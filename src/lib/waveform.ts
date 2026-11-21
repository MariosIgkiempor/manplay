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

/** How many levels of whiteness a column can have. */
export const WHITE_LEVELS = 8;

/** A track's columns unpacked for drawing: one entry per column of the detail. */
export interface Columns {
	/** 0–1. */
	heights: Float32Array;
	/** 0 to `WHITE_LEVELS - 1`. */
	whites: Uint8Array;
}

const unpacked = new WeakMap<readonly number[], Columns>();

/** The columns of a detail waveform, unpacked the first time it is drawn and kept with it. */
export function columnsOf(detail: readonly number[]): Columns {
	const known = unpacked.get(detail);
	if (known) {
		return known;
	}
	const heights = new Float32Array(detail.length);
	const whites = new Uint8Array(detail.length);
	detail.forEach((byte, index) => {
		heights[index] = (byte & 0x1f) / 31;
		whites[index] = byte >> 5;
	});
	const columns = { heights, whites };
	unpacked.set(detail, columns);
	return columns;
}

/**
 * The columns `[first, last]` of a detail as fewer, wider bars when one column would be thinner
 * than a pixel: `group` columns to a bar, each bar as tall as its loudest column. Groups start
 * at multiples of `group`, so a bar is made of the same columns however far the picture has
 * scrolled and does not flicker as it moves.
 */
export function barsBetween(
	columns: Columns,
	first: number,
	last: number,
	group: number,
): { index: number; height: number; white: number }[] {
	const bars: { index: number; height: number; white: number }[] = [];
	const end = Math.min(columns.heights.length - 1, last);
	for (let index = Math.max(0, Math.floor(first / group) * group); index <= end; index += group) {
		let height = 0;
		let white = 0;
		for (let member = index; member < index + group && member <= end; member++) {
			const candidate = columns.heights[member] ?? 0;
			if (candidate >= height) {
				height = candidate;
				white = columns.whites[member] ?? 0;
			}
		}
		bars.push({ index, height, white });
	}
	return bars;
}

export interface Beat {
	/** Seconds. */
	time: number;
	downbeat: boolean;
	/** The bar the beat is in, counted from 1 as a DJ counts it. */
	bar: number;
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
		const count = a.barOffset + k;
		beats.push({ time, downbeat: count % 4 === 0, bar: Math.floor(count / 4) + 1 });
	}
	return beats;
}

/** rekordbox-style blue, whiter where the sound is brighter; `alpha` dims unplayed parts. */
export function colour(white: number, alpha = 1): string {
	const mix = (a: number, b: number) => Math.round(a + (b - a) * white);
	return `rgba(${mix(32, 235)}, ${mix(110, 245)}, ${mix(235, 255)}, ${alpha})`;
}
