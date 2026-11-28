/**
 * Marks the scrolling area a card may live in (the page): a card grown from something inside it
 * is laid out in it and scrolls with it. A card grown from anywhere else floats over the window.
 */
export const GROW_LAYER_ATTRIBUTE = "data-grow-layer";
/** Marks the tile or row a card grows out of, when the thing pressed is only a part of it. */
export const GROW_CELL_ATTRIBUTE = "data-grow-cell";
/** Marks the picture in the cell (a cover) that flies into the card as it opens. */
export const GROW_FROM_ATTRIBUTE = "data-grow-from";
/**
 * Marks a control in the cell that opens the thing the picture shows (a tile's title, a song's
 * title): its card takes the picture too. A press on the picture's own button always does.
 */
export const GROW_OPENER_ATTRIBUTE = "data-grow-opener";
/** Marks where that picture lands inside the card. */
export const GROW_HERO_ATTRIBUTE = "data-grow-hero";
/** Set on a cell while its card is out: its picture is the one in the card (`styles.css`). */
export const GROW_LIFTED_ATTRIBUTE = "data-grow-lifted";

/** A box on screen, in pixels from the window's top left. */
export interface ScreenBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** How far a layer is scrolled, in pixels. */
export interface ScrollOffset {
	left: number;
	top: number;
}

/** Where a card sits, in pixels from the top left of what it is laid out in. */
export interface CardPlace {
	left: number;
	top: number;
	width: number;
}

/**
 * How far a card reaches past its origin to the left and up, so the origin sits inside it. A card
 * with a picture reaches as far as its picture is from its corner, so the picture grows in place.
 */
export interface Reach {
	x: number;
	y: number;
}

/** The reach of a card with no picture to line up. */
export const PLAIN_REACH: Reach = { x: 16, y: 16 };
/** The least room between a card and the edge of what holds it. */
const EDGE_ROOM_PX = 8;

const clamp = (value: number, least: number, most: number) =>
	Math.max(least, Math.min(most, value));

/**
 * Where a card `wanted` pixels wide goes inside a scrolling layer: its corner just outside its
 * origin's, moved left as far as it takes to stay inside the layer, and no wider than it. It is
 * placed in the layer's own scrolled space, so it scrolls with what it grew out of.
 */
export function placeInLayer(
	origin: ScreenBox,
	layer: ScreenBox,
	scroll: ScrollOffset,
	wanted: number,
	reach: Reach = PLAIN_REACH,
): CardPlace {
	const width = Math.min(wanted, layer.width - EDGE_ROOM_PX * 2);
	const leftmost = layer.left + EDGE_ROOM_PX;
	const rightmost = layer.left + layer.width - EDGE_ROOM_PX - width;
	const left = clamp(origin.left - reach.x, leftmost, rightmost);
	const top = Math.max(EDGE_ROOM_PX, origin.top - reach.y - layer.top + scroll.top);
	return { left: left - layer.left + scroll.left, top, width };
}

/**
 * Where a card `wanted` pixels wide and `height` tall goes when it floats over the window: its
 * corner just outside its origin's, moved as far as it takes to stay inside the window.
 */
export function placeInWindow(
	origin: ScreenBox,
	window: { width: number; height: number },
	wanted: number,
	height: number,
	reach: Reach = PLAIN_REACH,
): CardPlace {
	const width = Math.min(wanted, window.width - EDGE_ROOM_PX * 2);
	const left = clamp(origin.left - reach.x, EDGE_ROOM_PX, window.width - EDGE_ROOM_PX - width);
	const lowest = Math.max(EDGE_ROOM_PX, window.height - EDGE_ROOM_PX - height);
	const top = clamp(origin.top - reach.y, EDGE_ROOM_PX, lowest);
	return { left, top, width };
}

/** A small box in the middle of `window`: where a card grows from when nothing was pressed. */
export function windowCentre(window: { width: number; height: number }): ScreenBox {
	const size = 96;
	return {
		left: (window.width - size) / 2,
		top: (window.height - size) / 3,
		width: size,
		height: size,
	};
}

/**
 * The transform that draws something laid out at `at` as if it were at `as`, scaling from its top
 * left corner.
 */
export function drawnAs(at: ScreenBox, as: ScreenBox): string {
	const x = as.left - at.left;
	const y = as.top - at.top;
	const wide = at.width === 0 ? 1 : as.width / at.width;
	const tall = at.height === 0 ? 1 : as.height / at.height;
	return `translate(${x}px, ${y}px) scale(${wide}, ${tall})`;
}
