import type { TrackAnalysis } from "#/lib/api.ts";
import { type Cue, MEMORY_COLOR, PAD_LETTERS, START_COLOR } from "#/lib/cues.ts";
import { beatsBetween, colour, column, overview } from "#/lib/waveform.ts";

const PLAYHEAD = "rgba(255, 70, 70, 0.95)";

/** The whole track as bars from the bottom; the part before `played` (0–1) bright. */
export function drawOverview(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	analysis: TrackAnalysis,
	played: number,
	cues: readonly Cue[] = [],
) {
	const bar = Math.max(1, Math.round(w / 400));
	const gap = bar > 2 ? 1 : 0;
	const cols = overview(analysis.detail, Math.floor(w / bar));
	// Scaled to the loudest slice so the bar is filled; the drive keeps rekordbox's scale.
	const top = Math.max(1e-6, ...cols.map((c) => c.height));
	cols.forEach((c, i) => {
		const x = i * bar;
		const height = Math.max(1, (c.height / top) * h);
		ctx.fillStyle = colour(c.white, x / w < played ? 1 : 0.4);
		ctx.fillRect(x, h - height, Math.max(1, bar - gap), height);
	});
	drawCuePins(ctx, w, h, analysis.duration, cues);
	ctx.fillStyle = PLAYHEAD;
	ctx.fillRect(Math.round(played * w) - 1, 0, 2, h);
}

/** Cue pins across the whole track: hot cues full height, memory cues a notch at the top, the
 * start cue a pin from the bottom. */
function drawCuePins(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	length: number,
	cues: readonly Cue[],
) {
	if (length <= 0) {
		return;
	}
	for (const c of cues) {
		const x = Math.round((c.start / length) * w);
		if (c.main) {
			ctx.fillStyle = START_COLOR;
			ctx.fillRect(x - 1, h * 0.55, 2, h * 0.45);
		} else {
			ctx.fillStyle = c.slot === null ? MEMORY_COLOR : c.color || "#28e214";
			ctx.fillRect(x - 1, 0, 2, c.slot === null ? h * 0.3 : h);
		}
	}
}

/** Cue markers in the scrolling view: a lettered flag per hot cue, a red notch per memory cue. */
function drawCues(
	ctx: CanvasRenderingContext2D,
	h: number,
	cues: readonly Cue[],
	from: number,
	perPixel: number,
	w: number,
) {
	const flag = Math.round(h * 0.16);
	ctx.font = `600 ${Math.round(flag * 0.8)}px ui-sans-serif, system-ui, sans-serif`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	for (const c of cues) {
		const x = (c.start - from) / perPixel;
		if (x < -flag * 2 || x > w + flag * 2) {
			continue;
		}
		if (c.main) {
			// rekordbox's main cue: an orange triangle on the bottom edge.
			ctx.fillStyle = START_COLOR;
			ctx.beginPath();
			ctx.moveTo(x - flag * 0.7, h);
			ctx.lineTo(x + flag * 0.7, h);
			ctx.lineTo(x, h - flag);
			ctx.fill();
			ctx.fillRect(x - 0.75, 0, 1.5, h);
			continue;
		}
		if (c.slot === null) {
			ctx.fillStyle = MEMORY_COLOR;
			ctx.beginPath();
			ctx.moveTo(x - flag * 0.6, 0);
			ctx.lineTo(x + flag * 0.6, 0);
			ctx.lineTo(x, flag);
			ctx.fill();
			ctx.fillRect(x - 0.75, 0, 1.5, h);
			continue;
		}
		const color = c.color || "#28e214";
		ctx.fillStyle = color;
		ctx.fillRect(x - 0.75, 0, 1.5, h);
		ctx.fillRect(x, 0, flag * 1.1, flag);
		ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
		ctx.fillText(PAD_LETTERS[c.slot] ?? "", x + flag * 0.55, flag / 2 + 0.5);
	}
}

/**
 * One bar per waveform column at its exact (fractional) place, so the picture slides smoothly
 * instead of re-sampling different columns into each pixel every frame.
 */
function drawColumns(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	analysis: TrackAnalysis,
	from: number,
	now: number,
	perPixel: number,
) {
	const mid = h / 2;
	const step = 1 / analysis.rate;
	const width = step / perPixel;
	const first = Math.max(0, Math.floor(from * analysis.rate));
	const last = Math.min(
		analysis.detail.length - 1,
		Math.ceil((from + w * perPixel) * analysis.rate),
	);
	// Bars a little wider than their slot overlap instead of leaving hairline gaps.
	const drawn = Math.max(1, width + 0.5);
	for (let i = first; i <= last; i++) {
		const byte = analysis.detail[i];
		if (byte === undefined) {
			continue;
		}
		const t = i * step;
		const c = column(byte);
		const half = Math.max(0.5, (c.height * h) / 2);
		ctx.fillStyle = colour(c.white, t <= now ? 0.55 : 1);
		ctx.fillRect((t - from) / perPixel, mid - half, drawn, half * 2);
	}
}

/** `window` seconds either side of `now`, centred, with beat ticks and downbeats in red. */
export function drawDetail(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	analysis: TrackAnalysis,
	now: number,
	window: number,
	cues: readonly Cue[] = [],
) {
	const from = now - window;
	const perPixel = (2 * window) / w;
	drawColumns(ctx, w, h, analysis, from, now, perPixel);
	for (const beat of beatsBetween(analysis, from, now + window)) {
		const x = (beat.time - from) / perPixel;
		const tick = beat.downbeat ? h * 0.3 : h * 0.15;
		const width = beat.downbeat ? 2 : 1;
		ctx.fillStyle = beat.downbeat ? PLAYHEAD : "rgba(255, 255, 255, 0.85)";
		ctx.fillRect(x, 0, width, tick);
		ctx.fillRect(x, h - tick, width, tick);
	}
	drawCues(ctx, h, cues, from, perPixel, w);
	ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
	ctx.fillRect(Math.round(w / 2) - 1, 0, 2, h);
}
