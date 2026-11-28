import type { Box } from "#/lib/bubble-position.ts";

/**
 * Where the user last acted: the button, row or menu trigger they pressed, or the row a keyboard
 * shortcut acts on. A confirmation opens beside it, so the question sits next to the thing it is
 * about instead of in the middle of the window.
 */
export interface ActionAnchor {
	box: Box;
	/** True when `box` is a control or row on screen, which the question can point out. */
	element: boolean;
	/** That control or row, while it is on screen. */
	target: Element | null;
	/** The other rows selected with `target`, which the action takes along with it. */
	alsoSelected: readonly SelectedItem[];
	at: number;
}

/** A selected row on screen, and where it was when the user acted. */
export interface SelectedItem {
	box: Box;
	target: Element;
}

/** An anchor older than this belongs to some earlier action; the question opens centred. */
export const ANCHOR_FRESH_MS = 4000;
/** Anything taller than this is a whole list or pane, not the thing acted on. */
const MAX_ANCHOR_HEIGHT = 96;

/** What a press lands on that names the thing acted on. */
const PRESSABLE =
	"button, a, [data-row-path], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=row], [role=treeitem], [role=tab], li";
/** Inside one of these the press picks from a list another control opened. */
const OPENED_LIST = "[role=menu], [role=listbox]";
/** An item in a list, which a destructive answer takes away. */
const ITEM = "a, li, [data-row-path], [role=row], [role=treeitem], [role=option]";
/** A selected row inside a focused list: what a keyboard shortcut acts on. */
const SELECTED = '[aria-selected="true"], [data-selected="true"]';
/** The list a selection lives in; another list's selection (the other Files pane) is its own. */
const SELECTION_SCOPE = "[role=listbox], [role=grid], [role=tree], [role=list], [data-file-pane]";

let last: ActionAnchor | null = null;

/**
 * The control or row the user last acted on, whatever its size, and where it was: what a card
 * opened by that action grows out of.
 */
export interface ActionOrigin {
	element: Element | null;
	box: Box;
	at: number;
}

let lastOrigin: ActionOrigin | null = null;

/** What the action happening now started from, or null when it is not known. */
export function currentActionOrigin(): ActionOrigin | null {
	const now = performance.now();
	return lastOrigin !== null && now - lastOrigin.at <= ANCHOR_FRESH_MS ? lastOrigin : null;
}

function boxOf(element: Element): Box {
	const { left, top, width, height } = element.getBoundingClientRect();
	return { left, top, width, height };
}

function anchorable(box: Box): boolean {
	return box.width > 0 && box.height > 0 && box.height <= MAX_ANCHOR_HEIGHT;
}

/**
 * The rows selected alongside `item`, when `item` is itself selected: a press or key on one row
 * of a selection acts on all of it.
 */
function selectedAlongside(item: Element): SelectedItem[] {
	if (!(item.matches(ITEM) && item.matches(SELECTED))) {
		return [];
	}
	const scope = item.closest(SELECTION_SCOPE) ?? item.parentElement;
	if (!scope) {
		return [];
	}
	return [...scope.querySelectorAll(SELECTED)]
		.filter((other) => other !== item && other.matches(ITEM))
		.map((other) => ({ box: boxOf(other), target: other }))
		.filter((other) => anchorable(other.box));
}

function elementAnchor(element: Element, at: number): ActionAnchor | null {
	const box = boxOf(element);
	if (!anchorable(box)) {
		return null;
	}
	return { box, element: true, target: element, alsoSelected: selectedAlongside(element), at };
}

/** The anchor for a press at (`x`, `y`) on `target`. */
function pressAnchor(target: Element | null, x: number, y: number, at: number): ActionAnchor {
	const pressed = target?.closest(PRESSABLE);
	return (
		(pressed && elementAnchor(pressed, at)) ?? {
			box: { left: x, top: y, width: 0, height: 0 },
			element: false,
			target: null,
			alsoSelected: [],
			at,
		}
	);
}

/** The anchor for a key pressed while `focused` has focus. */
function keyAnchor(focused: Element | null, at: number): ActionAnchor | null {
	// With nothing focused, a shortcut acts on the page's selection (the Files page's rows).
	const scope = !focused || focused === document.body ? document.body : focused;
	const own = scope === document.body ? null : elementAnchor(scope, at);
	if (own) {
		return own;
	}
	const selected = scope.querySelector(SELECTED);
	return selected ? elementAnchor(selected, at) : null;
}

/**
 * A pick from a menu or list keeps the anchor of whatever opened it (the row right-clicked, the
 * ⋯ button), since the menu is gone by the time the question shows.
 */
function insideOpenedList(target: EventTarget | null): boolean {
	const list = target instanceof Element ? target.closest(OPENED_LIST) : null;
	// A list that is part of the page (the songs) is where the thing acted on is, not a popup.
	return list !== null && list.closest("main") === null;
}

/** Starts noting where the user acts. Returns the function that stops it. */
export function trackActionAnchors(): () => void {
	const onPress = (event: PointerEvent | MouseEvent) => {
		if (insideOpenedList(event.target)) {
			return;
		}
		const target = event.target instanceof Element ? event.target : null;
		last = pressAnchor(target, event.clientX, event.clientY, performance.now());
		const pressed = target?.closest(PRESSABLE) ?? null;
		lastOrigin = { element: pressed, box: pressed ? boxOf(pressed) : last.box, at: last.at };
	};
	const onKey = (event: KeyboardEvent) => {
		if (event.repeat || insideOpenedList(event.target)) {
			return;
		}
		last = keyAnchor(document.activeElement, performance.now());
		lastOrigin = last && { element: last.target, box: last.box, at: last.at };
	};
	document.addEventListener("pointerdown", onPress, true);
	document.addEventListener("contextmenu", onPress, true);
	window.addEventListener("keydown", onKey, true);
	return () => {
		document.removeEventListener("pointerdown", onPress, true);
		document.removeEventListener("contextmenu", onPress, true);
		window.removeEventListener("keydown", onKey, true);
	};
}

/** `anchor` while it still belongs to the action happening `now`, else null. */
export function freshAnchor(anchor: ActionAnchor | null, now: number): ActionAnchor | null {
	return anchor !== null && now >= anchor.at && now - anchor.at <= ANCHOR_FRESH_MS ? anchor : null;
}

/** Where the action being confirmed started, or null when the question should open centred. */
export function currentActionAnchor(): ActionAnchor | null {
	return freshAnchor(last, performance.now());
}

/** How long a confirmed row takes to dim as it goes. */
const LEAVE_MS = 180;
/** A row still on screen this long after its removal was confirmed failed to go; it comes back. */
const LEAVE_GIVE_UP_MS = 3000;

/**
 * Dims the thing a destructive answer is removing, at once, so the answer shows before the list
 * catches up. If it is still there a few seconds on (the removal failed), it comes back.
 */
export function showLeaving(anchor: ActionAnchor | null): void {
	if (!anchor?.target || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
		return;
	}
	for (const target of [anchor.target, ...anchor.alsoSelected.map((item) => item.target)]) {
		// Only an item in a list goes away; a button that asked (Leave…, Reset) stays put.
		if (!(target instanceof HTMLElement && target.isConnected && target.matches(ITEM))) {
			continue;
		}
		const leaving = target.animate(
			[
				{ opacity: 1, filter: "saturate(1)" },
				{ opacity: 0.35, filter: "saturate(0)" },
			],
			{ duration: LEAVE_MS, easing: "ease-out", fill: "forwards" },
		);
		setTimeout(() => leaving.cancel(), LEAVE_GIVE_UP_MS);
	}
}

/** Every box the question points out: the thing acted on and the rows selected with it. */
export function litBoxes(anchor: ActionAnchor): Box[] {
	return anchor.element ? [anchor.box, ...anchor.alsoSelected.map((item) => item.box)] : [];
}
