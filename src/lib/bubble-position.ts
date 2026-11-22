/** Where a hint bubble goes: beside the thing it describes, and always inside the window. */

export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface Size {
	width: number;
	height: number;
}

export type BubbleSide = "top" | "bottom";

export interface BubblePosition {
	left: number;
	top: number;
	/** The side of the anchor the bubble ended up on. */
	side: BubbleSide;
}

/** The space between the anchor and its bubble. */
const GAP = 6;
/** The closest a bubble comes to the window's edge. */
const MARGIN = 8;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

/**
 * Centres a bubble over (or under) its anchor. It takes the side asked for when it fits there,
 * else the other one, else whichever has more room; it never leaves the window sideways.
 */
export function bubblePosition(
	anchor: Box,
	bubble: Size,
	viewport: Size,
	preferred: BubbleSide = "top",
): BubblePosition {
	const roomAbove = anchor.top - MARGIN;
	const roomBelow = viewport.height - (anchor.top + anchor.height) - MARGIN;
	const needed = bubble.height + GAP;
	const fits: Record<BubbleSide, boolean> = {
		top: roomAbove >= needed,
		bottom: roomBelow >= needed,
	};
	const other: BubbleSide = preferred === "top" ? "bottom" : "top";
	const roomier: BubbleSide = roomAbove >= roomBelow ? "top" : "bottom";
	const side = fits[preferred] ? preferred : fits[other] ? other : roomier;
	const top = side === "top" ? anchor.top - GAP - bubble.height : anchor.top + anchor.height + GAP;
	const centred = anchor.left + anchor.width / 2 - bubble.width / 2;
	return {
		left: clamp(centred, MARGIN, Math.max(MARGIN, viewport.width - bubble.width - MARGIN)),
		top: clamp(top, MARGIN, Math.max(MARGIN, viewport.height - bubble.height - MARGIN)),
		side,
	};
}
