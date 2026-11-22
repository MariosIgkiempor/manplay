import { useCallback, useEffect, useRef, useState } from "react";

/** A second press this soon after the first is the tail of a double-click, not a decision. */
export const SETTLE_MS = 350;
/** An armed button nobody confirms goes back to rest after this long. */
export const DISARM_AFTER_MS = 6000;

export type PressOutcome = "arm" | "ignore" | "confirm";

/** What a press does, given when the button was armed (null: at rest) and the time now. */
export function pressOutcome(armedAt: number | null, now: number): PressOutcome {
	if (armedAt === null) {
		return "arm";
	}
	return now - armedAt < SETTLE_MS ? "ignore" : "confirm";
}

/**
 * A press that must be given twice: the first arms, the second confirms. Pressing anywhere else,
 * Escape, leaving the window or waiting disarms. `element` is the control being pressed.
 */
export function useTwoPress(onConfirm: () => void): {
	armed: boolean;
	press: () => void;
	element: HTMLElement | null;
	setElement: (element: HTMLElement | null) => void;
} {
	const [armedAt, setArmedAt] = useState<number | null>(null);
	const [element, setElement] = useState<HTMLElement | null>(null);
	const confirm = useRef(onConfirm);
	confirm.current = onConfirm;
	const armed = armedAt !== null;

	const press = useCallback(() => {
		const now = performance.now();
		const outcome = pressOutcome(armedAt, now);
		if (outcome === "arm") {
			setArmedAt(now);
		} else if (outcome === "confirm") {
			setArmedAt(null);
			confirm.current();
		}
	}, [armedAt]);

	useEffect(() => {
		if (!armed) {
			return;
		}
		const disarm = () => setArmedAt(null);
		const onPointerDown = (e: PointerEvent) => {
			if (!(e.target instanceof Node && element?.contains(e.target))) {
				disarm();
			}
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// Escape answers the armed button, not the drawer or dialog it sits in.
				e.stopPropagation();
				disarm();
			}
		};
		const expiry = setTimeout(disarm, DISARM_AFTER_MS);
		document.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("blur", disarm);
		return () => {
			clearTimeout(expiry);
			document.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("blur", disarm);
		};
	}, [armed, element]);

	return { armed, press, element, setElement };
}
