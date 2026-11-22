import type { TrackAnalysis } from "#/lib/api.ts";
import { type Cue, MEMORY_COLOR, PAD_LETTERS, START_COLOR } from "#/lib/cues.ts";
import {
	type Beat,
	barsBetween,
	beatsBetween,
	colour,
	columnsOf,
	overview,
	WHITE_LEVELS,
} from "#/lib/waveform.ts";

const DOWNBEAT = "rgba(255, 70, 70, 0.95)";
const BEAT = "rgba(255, 255, 255, 0.8)";
/** neutral-950, the deck the waveforms sit on: what dimming a part of them fades toward. */
const DECK = "10, 10, 10";
/** How much of the played part of the scrolling waveform is faded. */
const PLAYED_FADE = 0.5;
/** How much of the unplayed part of the overview shows. */
const UNPLAYED = 0.4;
/** The share of the height the loudest column fills, leaving the beat ticks a lane each side. */
const WAVE_HEIGHT = 0.76;

/** One fill colour per whiteness level, made once: a colour string a bar is slow to draw with. */
const PALETTE = Array.from({ length: WHITE_LEVELS }, (_, level) =>
	colour(level / (WHITE_LEVELS - 1)),
);

/**
 * The whole track as bars from the bottom, at full brightness, on a canvas of its own. It only
 * changes with the track or the size, so it is drawn once and copied each frame.
 */
export function renderOverview(analysis: TrackAnalysis, w: number, h: number): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return canvas;
	}
	const bar = Math.max(1, Math.round(w / 400));
	const gap = bar > 2 ? 1 : 0;
	const cols = overview(analysis.detail, Math.floor(w / bar));
	// Scaled to the loudest slice so the bar is filled; the drive keeps rekordbox's scale.
	const top = Math.max(1e-6, ...cols.map((c) => c.height));
	cols.forEach((c, i) => {
		const height = Math.max(1, (c.height / top) * h);
		ctx.fillStyle = colour(c.white);
		ctx.fillRect(i * bar, h - height, Math.max(1, bar - gap), height);
	});
	return canvas;
}

/**
 * The player bar's quiet timeline: thin bars mirrored about the middle in one colour, `tint`,
 * on a canvas of its own. Drawn twice, dim and lit, so the played part can light up.
 */
export function renderTimeline(
	analysis: TrackAnalysis,
	w: number,
	h: number,
	scale: number,
	tint: string,
): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return canvas;
	}
	const bar = Math.max(1, Math.round(2 * scale));
	const step = bar + Math.max(1, Math.round(scale));
	const cols = overview(analysis.detail, Math.floor(w / step));
	const top = Math.max(1e-6, ...cols.map((c) => c.height));
	ctx.fillStyle = tint;
	cols.forEach((c, i) => {
		const height = Math.max(bar, (c.height / top) * h * 0.9);
		ctx.fillRect(i * step, (h - height) / 2, bar, height);
	});
	return canvas;
}

/** How bright the part still to play is on the quiet timeline. */
const TIMELINE_UNPLAYED = 0.28;

/** The quiet timeline: dim bars, the played part in the accent colour, a slim playhead. */
export function drawTimeline(
	ctx: CanvasRenderingContext2D,
	size: { w: number; h: number; scale: number },
	dim: CanvasImageSource,
	lit: CanvasImageSource,
	played: number,
	playheadColour: string,
) {
	const { w, h, scale } = size;
	const at = Math.round(Math.max(0, Math.min(1, played)) * w);
	ctx.globalAlpha = TIMELINE_UNPLAYED;
	ctx.drawImage(dim, 0, 0);
	ctx.globalAlpha = 1;
	if (at > 0) {
		ctx.clearRect(0, 0, at, h);
		ctx.drawImage(lit, 0, 0, at, h, 0, 0, at, h);
	}
	const line = Math.max(1, Math.round(1.5 * scale));
	ctx.globalAlpha = 0.85;
	ctx.fillStyle = playheadColour;
	ctx.fillRect(at - line / 2, h * 0.1, line, h * 0.8);
	ctx.globalAlpha = 1;
}

/** The overview with the part before `played` (0–1) bright, cue pins and the playhead. */
export function drawOverview(
	ctx: CanvasRenderingContext2D,
	size: { w: number; h: number; scale: number },
	bars: CanvasImageSource,
	played: number,
	duration: number,
	cues: readonly Cue[] = [],
) {
	const { w, h, scale } = size;
	const at = Math.round(Math.max(0, Math.min(1, played)) * w);
	ctx.globalAlpha = UNPLAYED;
	ctx.drawImage(bars, 0, 0);
	ctx.globalAlpha = 1;
	if (at > 0) {
		ctx.clearRect(0, 0, at, h);
		ctx.drawImage(bars, 0, 0, at, h, 0, 0, at, h);
	}
	drawCuePins(ctx, size, duration, cues);
	const line = Math.max(2, Math.round(1.5 * scale));
	ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
	ctx.fillRect(at - line / 2, 0, line, h);
}

/** Cue pins across the whole track: hot cues full height, memory cues a notch at the top, the
 * start cue a pin from the bottom. */
function drawCuePins(
	ctx: CanvasRenderingContext2D,
	{ w, h, scale }: { w: number; h: number; scale: number },
	length: number,
	cues: readonly Cue[],
) {
	if (length <= 0) {
		return;
	}
	const pin = Math.max(2, Math.round(scale));
	for (const c of cues) {
		const x = Math.round((c.start / length) * w) - pin / 2;
		if (c.main) {
			ctx.fillStyle = START_COLOR;
			ctx.fillRect(x, h * 0.55, pin, h * 0.45);
		} else {
			ctx.fillStyle = c.slot === null ? MEMORY_COLOR : c.color || "#28e214";
			ctx.fillRect(x, 0, pin, c.slot === null ? h * 0.3 : h);
		}
	}
}

/** What the scrolling view shows: its size in device pixels and the stretch of time across it. */
interface View {
	w: number;
	h: number;
	/** Device pixels to a CSS pixel, so lines and text are the same size on any screen. */
	scale: number;
	/** Seconds at the left edge. */
	from: number;
	/** Seconds to a device pixel. */
	perPixel: number;
}

/** Cue markers in the scrolling view: a lettered flag per hot cue, a red notch per memory cue. */
function drawCues(ctx: CanvasRenderingContext2D, view: View, cues: readonly Cue[]) {
	const { w, h, scale } = view;
	const flag = Math.round(15 * scale);
	const line = 1.5 * scale;
	ctx.font = `600 ${Math.round(flag * 0.72)}px ui-sans-serif, system-ui, sans-serif`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	for (const c of cues) {
		const x = (c.start - view.from) / view.perPixel;
		if (x < -flag * 2 || x > w + flag * 2) {
			continue;
		}
		if (c.main) {
			// rekordbox's main cue: an orange triangle on the bottom edge.
			ctx.fillStyle = START_COLOR;
			ctx.beginPath();
			ctx.moveTo(x - flag * 0.6, h);
			ctx.lineTo(x + flag * 0.6, h);
			ctx.lineTo(x, h - flag * 0.9);
			ctx.fill();
			ctx.fillRect(x - line / 2, 0, line, h);
			continue;
		}
		if (c.slot === null) {
			ctx.fillStyle = MEMORY_COLOR;
			ctx.beginPath();
			ctx.moveTo(x - flag * 0.5, 0);
			ctx.lineTo(x + flag * 0.5, 0);
			ctx.lineTo(x, flag * 0.8);
			ctx.fill();
			ctx.fillRect(x - line / 2, 0, line, h);
			continue;
		}
		ctx.fillStyle = c.color || "#28e214";
		ctx.fillRect(x - line / 2, 0, line, h);
		ctx.fillRect(x - line / 2, 0, flag * 1.15, flag);
		ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
		ctx.fillText(PAD_LETTERS[c.slot] ?? "", x + flag * 0.55, flag / 2 + scale * 0.5);
	}
}

/**
 * The waveform's bars at their exact (fractional) places, so the picture slides smoothly instead
 * of re-sampling different columns into each pixel every frame.
 */
function drawColumns(ctx: CanvasRenderingContext2D, view: View, analysis: TrackAnalysis) {
	const { w, h, from, perPixel } = view;
	const slot = 1 / (analysis.rate * perPixel);
	const group = Math.max(1, Math.ceil(1 / slot));
	const bars = barsBetween(
		columnsOf(analysis.detail),
		Math.floor(from * analysis.rate),
		Math.ceil((from + w * perPixel) * analysis.rate),
		group,
	);
	// Bars a little wider than their slot overlap instead of leaving hairline gaps.
	const drawn = slot * group + 0.5;
	const mid = h / 2;
	const reach = (h * WAVE_HEIGHT) / 2;
	// Bars of one colour are drawn together: setting a fill colour costs more than a bar.
	const byLevel = PALETTE.map((): number[] => []);
	for (const bar of bars) {
		byLevel[bar.white]?.push((bar.index / analysis.rate - from) / perPixel, bar.height * reach);
	}
	byLevel.forEach((rects, level) => {
		ctx.fillStyle = PALETTE[level] ?? "";
		for (let at = 0; at < rects.length; at += 2) {
			const half = Math.max(0.5, rects[at + 1] ?? 0);
			ctx.fillRect(rects[at] ?? 0, mid - half, drawn, half * 2);
		}
	});
}

/** The stretches before the song starts and after it ends, a shade apart from the song itself. */
function drawOutside(ctx: CanvasRenderingContext2D, view: View, duration: number) {
	const { w, h, from, perPixel } = view;
	const start = -from / perPixel;
	const end = (duration - from) / perPixel;
	ctx.fillStyle = "rgba(255, 255, 255, 0.045)";
	if (start > 0) {
		ctx.fillRect(0, 0, Math.min(w, start), h);
	}
	if (end < w) {
		ctx.fillRect(Math.max(0, end), 0, w - Math.max(0, end), h);
	}
}

/** A faint line down the picture for each beat, so a beat can be followed into the waveform. */
function drawBeatLines(ctx: CanvasRenderingContext2D, view: View, beats: readonly Beat[]) {
	const width = Math.max(1, Math.round(view.scale));
	for (const beat of beats) {
		ctx.fillStyle = beat.downbeat ? "rgba(255, 70, 70, 0.28)" : "rgba(255, 255, 255, 0.07)";
		ctx.fillRect((beat.time - view.from) / view.perPixel - width / 2, 0, width, view.h);
	}
}

/** Beat ticks along the top and bottom edges, downbeats in red with their bar number. */
function drawBeatTicks(
	ctx: CanvasRenderingContext2D,
	view: View,
	beats: readonly Beat[],
	/** Whether the bars are wide enough apart for their numbers. */
	numbered: boolean,
) {
	const { h, scale } = view;
	ctx.font = `500 ${Math.round(10 * scale)}px ui-sans-serif, system-ui, sans-serif`;
	ctx.textAlign = "left";
	ctx.textBaseline = "top";
	for (const beat of beats) {
		const width = Math.max(1, Math.round(scale * (beat.downbeat ? 2 : 1)));
		const x = (beat.time - view.from) / view.perPixel - width / 2;
		const tick = h * (beat.downbeat ? 0.11 : 0.06);
		ctx.fillStyle = beat.downbeat ? DOWNBEAT : BEAT;
		ctx.fillRect(x, 0, width, tick);
		ctx.fillRect(x, h - tick, width, tick);
		if (beat.downbeat && numbered) {
			ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
			ctx.fillText(String(beat.bar), x + width + 3 * scale, 3 * scale);
		}
	}
}

/** The playhead: a line down the middle with an arrow at each end, as on a CDJ. */
function drawPlayhead(ctx: CanvasRenderingContext2D, { w, h, scale }: View) {
	const x = Math.round(w / 2);
	const line = Math.max(2, Math.round(1.5 * scale));
	const arrow = 5 * scale;
	ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
	ctx.fillRect(x - line / 2, 0, line, h);
	ctx.beginPath();
	ctx.moveTo(x - arrow, 0);
	ctx.lineTo(x + arrow, 0);
	ctx.lineTo(x, arrow * 1.2);
	ctx.moveTo(x - arrow, h);
	ctx.lineTo(x + arrow, h);
	ctx.lineTo(x, h - arrow * 1.2);
	ctx.fill();
}

/** `window` seconds either side of `now`, centred, with the beat grid, cues and playhead. */
export function drawDetail(
	ctx: CanvasRenderingContext2D,
	size: { w: number; h: number; scale: number },
	analysis: TrackAnalysis,
	now: number,
	window: number,
	cues: readonly Cue[] = [],
) {
	const view: View = { ...size, from: now - window, perPixel: (2 * window) / size.w };
	const beats = beatsBetween(analysis, view.from, now + window);
	drawOutside(ctx, view, analysis.duration);
	drawBeatLines(ctx, view, beats);
	drawColumns(ctx, view, analysis);
	// What has played fades toward the deck, in one fill instead of a colour per bar.
	ctx.fillStyle = `rgba(${DECK}, ${PLAYED_FADE})`;
	ctx.fillRect(0, 0, size.w / 2, size.h);
	const barWidth = analysis.gridBpm ? 240 / analysis.gridBpm / view.perPixel : 0;
	drawBeatTicks(ctx, view, beats, barWidth > 34 * size.scale);
	drawCues(ctx, view, cues);
	drawPlayhead(ctx, view);
}
