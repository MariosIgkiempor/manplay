import type { Grid } from "#/lib/beat-grid.ts";

/** A hot cue (`slot` 0–7 for A–H) or memory cue (`slot` null). */
export interface Cue {
	slot: number | null;
	/** Seconds. */
	start: number;
	name: string;
	/** `#rrggbb`, or "" for the player's default. */
	color: string;
	/**
	 * The memory cue the song starts from: rekordbox's main (yellow) cue when it loads, with
	 * auto cue set to memory cues. Exported as a memory cue.
	 */
	main: boolean;
}

export const PAD_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

/** Hot cue colours from the CDJ palette, in the order the pads take them by default. */
export const CUE_COLORS = [
	{ name: "Green", hex: "#28e214" },
	{ name: "Aqua", hex: "#10b1c8" },
	{ name: "Blue", hex: "#305aff" },
	{ name: "Purple", hex: "#aa72ff" },
	{ name: "Pink", hex: "#ff127b" },
	{ name: "Red", hex: "#e62828" },
	{ name: "Orange", hex: "#ffa000" },
	{ name: "Yellow", hex: "#e2d420" },
] as const;

/** Memory cues show red on a CDJ. */
export const MEMORY_COLOR = "#e62828";

/** The main cue's colour in rekordbox and on a CDJ. */
export const START_COLOR = "#f5a623";

export const defaultColor = (slot: number) => CUE_COLORS[slot % CUE_COLORS.length]?.hex ?? "";

/** The nearest beat to `time`, or `time` itself without a grid. */
export function snap(grid: Grid, time: number): number {
	if (grid.bpm === null || grid.bpm <= 0) {
		return time;
	}
	const period = 60 / grid.bpm;
	return Math.max(0, grid.firstBeat + Math.round((time - grid.firstBeat) / period) * period);
}

/** Where `time` falls as a DJ counts it: bar and beat (1–4), or null before the grid. */
export function barBeat(grid: Grid, time: number): { bar: number; beat: number } | null {
	if (grid.bpm === null || grid.bpm <= 0 || time < grid.firstBeat - 1e-6) {
		return null;
	}
	const k = Math.floor((time - grid.firstBeat) / (60 / grid.bpm) + 1e-6);
	const n = grid.barOffset + k;
	return { bar: Math.floor(n / 4) + 1, beat: (n % 4) + 1 };
}

/** Sets hot cue `slot` at `time`, keeping its name and colour if it had them. */
export function setHot(cues: readonly Cue[], slot: number, time: number): Cue[] {
	const old = cues.find((c) => c.slot === slot);
	const rest = cues.filter((c) => c.slot !== slot);
	return [
		...rest,
		{
			slot,
			start: time,
			name: old?.name ?? "",
			color: old?.color || defaultColor(slot),
			main: false,
		},
	];
}

/** Adds a memory cue at `time`, unless one is already within 10 ms of it. */
export function addMemory(cues: readonly Cue[], time: number): Cue[] {
	if (cues.some((c) => c.slot === null && Math.abs(c.start - time) < 0.01)) {
		return [...cues];
	}
	return [...cues, { slot: null, start: time, name: "", color: "", main: false }];
}

/** The start (main) cue, if set. */
export const startOf = (cues: readonly Cue[]) => cues.find((c) => c.main);

/** Moves the start cue to `time` (making a memory cue already there the start), or sets one. */
export function setStart(cues: readonly Cue[], time: number): Cue[] {
	const rest = cues.filter((c) => !c.main);
	const there = rest.find((c) => c.slot === null && Math.abs(c.start - time) < 0.01);
	if (there) {
		return rest.map((c) => (c === there ? { ...c, main: true } : c));
	}
	const old = startOf(cues);
	return [...rest, { slot: null, start: time, name: old?.name ?? "", color: "", main: true }];
}

export const clearStart = (cues: readonly Cue[]) => cues.filter((c) => !c.main);

/**
 * Memory cues before the start cue. A player loads the song at the earliest memory cue, so any
 * of these would win over the start.
 */
export function beforeStart(cues: readonly Cue[]): Cue[] {
	const start = startOf(cues);
	return start ? cues.filter((c) => c.slot === null && !c.main && c.start < start.start) : [];
}

export function sameCues(a: readonly Cue[], b: readonly Cue[]): boolean {
	const key = (c: Cue) => `${c.slot}|${c.start.toFixed(3)}|${c.name}|${c.color}|${c.main}`;
	const ka = a.map(key).sort();
	const kb = b.map(key).sort();
	return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

/** `m:ss.mmm`. */
export function stamp(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds - m * 60;
	return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}
