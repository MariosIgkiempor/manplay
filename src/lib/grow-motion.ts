import { drawnAs, type ScreenBox } from "#/lib/grow-card.ts";
import { LEAVE_MOTION, popMotion } from "#/lib/motion.ts";

/** The content comes in a beat after the card starts to grow, and is gone before it shrinks. */
const CONTENT_DELAY_MS = 70;
const CONTENT_IN_MS = 180;
const CONTENT_OUT_MS = 90;
/** How small the origin's picture starts as it lands back, before it springs to its size. */
const LANDING_SCALE = 0.94;
/** With nothing left to shrink into, a card shrinks this far towards its own middle and fades. */
const FADE_SCALE = 0.9;

export function boxOf(element: Element): ScreenBox {
	const { left, top, width, height } = element.getBoundingClientRect();
	return { left, top, width, height };
}

/** The parts of a card that move: its frame (`shell`) and its content (`body`). */
export interface CardParts {
	card: HTMLElement;
	shell: HTMLElement;
	body: HTMLElement;
}

/** What a card grows out of and shrinks back into. */
export interface CardOrigin {
	/** The picture that flies into the card (a cover), when the origin has one. */
	picture: Element | null;
	/** The thing pressed. */
	element: Element | null;
	/** Where the thing pressed was, for when it is no longer on the page. */
	box: ScreenBox;
}

/** What is moving now, so a change of mind starts from where things are, not from the ends. */
export interface Running {
	animations: Animation[];
	ghost: HTMLElement | null;
}

/** Where the origin is now; once it has left the page, a spot inside the card to fade into. */
function originBox(origin: CardOrigin, card: ScreenBox, opening: boolean): ScreenBox {
	const live = origin.picture?.isConnected
		? origin.picture
		: origin.element?.isConnected
			? origin.element
			: null;
	if (live) {
		return boxOf(live);
	}
	if (opening) {
		return origin.box;
	}
	const inset = (1 - FADE_SCALE) / 2;
	return {
		left: card.left + card.width * inset,
		top: card.top + card.height * inset,
		width: card.width * FADE_SCALE,
		height: card.height * FADE_SCALE,
	};
}

/** A copy of the origin's picture that flies between the origin and the card, above them both. */
function makeGhost(picture: Element, hero: HTMLElement, card: HTMLElement): HTMLElement {
	const ghost = document.createElement("div");
	const at = boxOf(hero);
	const corner = boxOf(card);
	ghost.setAttribute("aria-hidden", "true");
	ghost.append(picture.cloneNode(true));
	Object.assign(ghost.style, {
		position: "absolute",
		left: `${at.left - corner.left}px`,
		top: `${at.top - corner.top}px`,
		width: `${at.width}px`,
		height: `${at.height}px`,
		borderRadius: getComputedStyle(hero).borderRadius,
		overflow: "hidden",
		transformOrigin: "0 0",
		pointerEvents: "none",
		willChange: "transform",
	});
	card.append(ghost);
	return ghost;
}

/** Lets go of everything that is moving and shows the card's own picture again. */
export function stopMotion(running: Running | null, hero: HTMLElement | null) {
	for (const animation of running?.animations ?? []) {
		animation.cancel();
	}
	running?.ghost?.remove();
	if (hero) {
		hero.style.visibility = "";
	}
}

/** Where the moving parts are now, read before they are let go; null when nothing is moving. */
interface Midway {
	shell: ScreenBox;
	ghost: ScreenBox | null;
	bodyOpacity: number;
}

function readMidway(parts: CardParts, was: Running | null): Midway | null {
	if (!was?.animations.some((a) => a.playState === "running")) {
		return null;
	}
	return {
		shell: boxOf(parts.shell),
		ghost: was.ghost ? boxOf(was.ghost) : null,
		bodyOpacity: Number(getComputedStyle(parts.body).opacity),
	};
}

/** The frame scales between the origin (`shut`) and the card's own box. */
function moveShell(shell: HTMLElement, opening: boolean, shut: string, start: string | null) {
	const timing = opening ? popMotion() : LEAVE_MOTION;
	const from = start ?? (opening ? shut : "none");
	return [
		shell.animate([{ transform: from }, { transform: opening ? "none" : shut }], {
			...timing,
			fill: "both",
		}),
		shell.animate(
			opening
				? [{ opacity: start === null ? 0 : 1 }, { opacity: 1 }]
				: [{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }],
			{ duration: opening ? 90 : timing.duration, easing: "linear", fill: "both" },
		),
	];
}

/** The content fades, and rises a little on the spring as it comes in. */
function moveBody(body: HTMLElement, opening: boolean, opacityNow: number | null) {
	const delay = opening && opacityNow === null ? CONTENT_DELAY_MS : 0;
	const fade = body.animate(
		[{ opacity: opacityNow ?? (opening ? 0 : 1) }, { opacity: opening ? 1 : 0 }],
		{
			duration: opening ? CONTENT_IN_MS : CONTENT_OUT_MS,
			delay,
			easing: "ease-out",
			fill: "both",
		},
	);
	if (!opening) {
		return [fade];
	}
	const rise = body.animate([{ translate: "0 10px" }, { translate: "0 0" }], {
		...popMotion(),
		delay,
		fill: "both",
	});
	return [fade, rise];
}

interface GhostEnds {
	from: ScreenBox;
	hero: ScreenBox;
	now: ScreenBox | null;
}

/** A copy of the picture flies between the origin (`from`) and its place in the card (`hero`). */
function moveGhost(ghost: HTMLElement, opening: boolean, ends: GhostEnds) {
	const start = ends.now ?? (opening ? ends.from : ends.hero);
	return ghost.animate(
		[
			{ transform: drawnAs(ends.hero, start) },
			{ transform: opening ? "none" : drawnAs(ends.hero, ends.from) },
		],
		{ ...(opening ? popMotion() : LEAVE_MOTION), fill: "both" },
	);
}

const endTime = (animation: Animation) => Number(animation.effect?.getComputedTiming().endTime);

/**
 * Grows a card out of its origin, or shrinks it back in. The frame scales between the origin and
 * the card's own box; a copy of the origin's picture flies to `hero`, its place in the card; the
 * content fades. Only transforms and opacity move. Started mid-way, it carries on from where
 * everything is. `done` runs once it has all come to rest.
 */
export function growOrShrink(
	parts: CardParts,
	origin: CardOrigin,
	hero: HTMLElement | null,
	opening: boolean,
	was: Running | null,
	done: () => void,
): Running {
	const { card, shell, body } = parts;
	const midway = readMidway(parts, was);
	stopMotion(was, hero);

	const cardBox = boxOf(card);
	const fromBox = originBox(origin, cardBox, opening);
	const shellStart = midway ? drawnAs(cardBox, midway.shell) : null;
	// Measured before the content starts to move, so the copy lands exactly on the card's picture.
	const heroBox = hero ? boxOf(hero) : null;
	const picture = origin.picture?.isConnected ? origin.picture : null;
	let ghost: HTMLElement | null = null;
	if (hero && picture) {
		ghost = makeGhost(picture, hero, card);
		hero.style.visibility = "hidden";
	}
	const animations = [
		...moveShell(shell, opening, drawnAs(cardBox, fromBox), shellStart),
		...moveBody(body, opening, midway?.bodyOpacity ?? null),
	];
	if (ghost && heroBox) {
		animations.push(
			moveGhost(ghost, opening, { from: fromBox, hero: heroBox, now: midway?.ghost ?? null }),
		);
	}

	const running: Running = { animations, ghost };
	const longest = animations.reduce((a, b) => (endTime(a) >= endTime(b) ? a : b));
	longest.finished.then(
		() => {
			if (opening) {
				stopMotion(running, hero);
			}
			done();
		},
		// Cancelled: something else took over from here.
		() => undefined,
	);
	return running;
}

/** The origin's picture springs back to its size as it lands, so a close ends with a small bounce. */
export function land(picture: Element | null) {
	if (picture?.isConnected) {
		picture.animate([{ scale: LANDING_SCALE }, { scale: 1 }], popMotion());
	}
}
