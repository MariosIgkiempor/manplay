/** Zoom of the detail waveform: seconds shown either side of the playhead. */

/** The preset buttons, as on a CDJ's zoom. */
export const ZOOM_PRESETS = [2, 4, 8] as const;
export const ZOOM_DEFAULT = 4;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 32;
/** One press of + or −. */
const STEP = Math.SQRT2;

export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** Zooms in (`dir` 1, a shorter window) or out (−1) by one step. */
export const stepZoom = (z: number, dir: 1 | -1) => clampZoom(dir > 0 ? z / STEP : z * STEP);

/** The next preset wider than `z`, wrapping to the closest one in: Z's cycle. */
export function nextPreset(z: number): number {
	return ZOOM_PRESETS.find((p) => p > z + 1e-6) ?? ZOOM_PRESETS[0];
}

/**
 * The window after a pinch or ⌃-scroll of `deltaY` (positive spreads it, as pinching in does):
 * smooth and proportional, so small trackpad deltas zoom a little.
 */
export const wheelZoom = (z: number, deltaY: number) => clampZoom(z * Math.exp(deltaY * 0.01));

/** How long the window is, for labels: "8s", "1.5s". */
export function zoomLabel(z: number): string {
	const total = 2 * z;
	return `${total >= 10 ? Math.round(total) : Number(total.toFixed(1))}s`;
}
