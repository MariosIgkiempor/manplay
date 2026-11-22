import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { Bubble } from "#/components/ui/bubble.tsx";

/** The attribute an element names its hover hint in. */
const HINT_ATTRIBUTE = "data-hint";
/** How long the pointer rests on something before its hint shows. */
const SHOW_DELAY_MS = 350;
/** After a hint closes, the next one shows at once for this long: reading along a row of icons. */
const FOLLOW_ON_MS = 400;

interface ShownHint {
	anchor: Element;
	text: string;
}

function hintAnchor(target: EventTarget | null): Element | null {
	return target instanceof Element ? target.closest(`[${HINT_ATTRIBUTE}]`) : null;
}

/**
 * Listens across the whole document for what to hint at, calling `setShown` as hints open and
 * close. Returns what stops the listening.
 */
function watchForHints(setShown: Dispatch<SetStateAction<ShownHint | null>>): () => void {
	let waiting: ReturnType<typeof setTimeout> | undefined;
	let pointed: Element | null = null;
	let closedAt = Number.NEGATIVE_INFINITY;

	const show = (anchor: Element) => {
		const text = anchor.getAttribute(HINT_ATTRIBUTE)?.trim();
		setShown(text && anchor.isConnected ? { anchor, text } : null);
	};
	const hide = () => {
		clearTimeout(waiting);
		pointed = null;
		setShown((was) => {
			if (was) {
				closedAt = performance.now();
			}
			return null;
		});
	};
	const point = (anchor: Element) => {
		pointed = anchor;
		const delay = performance.now() - closedAt < FOLLOW_ON_MS ? 0 : SHOW_DELAY_MS;
		waiting = setTimeout(() => show(anchor), delay);
	};
	const onPointerOver = (e: PointerEvent) => {
		const anchor = e.pointerType === "touch" ? null : hintAnchor(e.target);
		if (anchor === pointed) {
			return;
		}
		hide();
		if (anchor) {
			point(anchor);
		}
	};
	const onFocusIn = (e: FocusEvent) => {
		const anchor = hintAnchor(e.target);
		// A click focuses too; only keyboard focus asks for the hint.
		if (anchor && e.target instanceof Element && e.target.matches(":focus-visible")) {
			hide();
			show(anchor);
		}
	};
	const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && hide();

	document.addEventListener("pointerover", onPointerOver);
	document.addEventListener("pointerdown", hide, true);
	document.addEventListener("focusin", onFocusIn);
	document.addEventListener("focusout", hide);
	document.addEventListener("keydown", onKeyDown, true);
	document.addEventListener("scroll", hide, true);
	document.documentElement.addEventListener("pointerleave", hide);
	return () => {
		clearTimeout(waiting);
		document.removeEventListener("pointerover", onPointerOver);
		document.removeEventListener("pointerdown", hide, true);
		document.removeEventListener("focusin", onFocusIn);
		document.removeEventListener("focusout", hide);
		document.removeEventListener("keydown", onKeyDown, true);
		document.removeEventListener("scroll", hide, true);
		document.documentElement.removeEventListener("pointerleave", hide);
	};
}

/**
 * Shows the hint of whatever the pointer rests on or the keyboard focuses: any element with a
 * `data-hint`. One layer for the whole app, mounted in the shell, in place of the browser's own
 * `title` tooltips. A hint with more than words in it uses `Hint` instead.
 */
export function HintLayer() {
	const [shown, setShown] = useState<ShownHint | null>(null);

	useEffect(() => watchForHints(setShown), []);

	// What a hint points at can change under it (a count ticks up) or go away (a row is removed).
	useEffect(() => {
		if (!shown) {
			return;
		}
		const follow = new MutationObserver(() => {
			const text = shown.anchor.getAttribute(HINT_ATTRIBUTE)?.trim();
			if (!shown.anchor.isConnected || !text) {
				setShown(null);
			} else if (text !== shown.text) {
				setShown({ anchor: shown.anchor, text });
			}
		});
		follow.observe(document.body, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: [HINT_ATTRIBUTE],
		});
		return () => follow.disconnect();
	}, [shown]);

	return shown && <Bubble anchor={shown.anchor}>{shown.text}</Bubble>;
}
