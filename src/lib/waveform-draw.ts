import type { TrackAnalysis } from "#/lib/api.ts";
import { beatsBetween, colour, column, overview } from "#/lib/waveform.ts";

const PLAYHEAD = "rgba(255, 70, 70, 0.95)";

/** The whole track as bars from the bottom; the part before `played` (0–1) bright. */
export function drawOverview(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	analysis: TrackAnalysis,
	played: number,
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
	ctx.fillStyle = PLAYHEAD;
	ctx.fillRect(Math.round(played * w) - 1, 0, 2, h);
}

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
	for (let x = 0; x < w; x++) {
		const t = from + x * perPixel;
		const byte = t < 0 ? undefined : analysis.detail[Math.floor(t * analysis.rate)];
		if (byte === undefined) {
			continue;
		}
		const c = column(byte);
		const half = Math.max(0.5, (c.height * h) / 2);
		ctx.fillStyle = colour(c.white, t <= now ? 0.55 : 1);
		ctx.fillRect(x, mid - half, 1, half * 2);
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
) {
	const from = now - window;
	const perPixel = (2 * window) / w;
	drawColumns(ctx, w, h, analysis, from, now, perPixel);
	for (const beat of beatsBetween(analysis, from, now + window)) {
		const x = Math.round((beat.time - from) / perPixel);
		const tick = beat.downbeat ? h * 0.3 : h * 0.15;
		const width = beat.downbeat ? 2 : 1;
		ctx.fillStyle = beat.downbeat ? PLAYHEAD : "rgba(255, 255, 255, 0.85)";
		ctx.fillRect(x, 0, width, tick);
		ctx.fillRect(x, h - tick, width, tick);
	}
	ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
	ctx.fillRect(Math.round(w / 2) - 1, 0, 2, h);
}
