/**
 * The time under the pointer on a seek bar that spans the whole song edge to edge. A native range
 * input insets its ends by half a thumb, so its own mapping drifts towards the ends; this does not.
 */
export function seekSeconds(
	pointerX: number,
	bar: { left: number; width: number },
	duration: number,
): number {
	if (bar.width <= 0 || duration <= 0) return 0;
	const fraction = Math.min(1, Math.max(0, (pointerX - bar.left) / bar.width));
	return fraction * duration;
}
