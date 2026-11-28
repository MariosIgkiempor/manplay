import { type RefObject, useLayoutEffect } from "react";
import { currentActionOrigin } from "#/lib/action-anchor.ts";
import { popMotion, reducedMotion } from "#/lib/motion.ts";

/** How small a card starts as it grows out of the thing that opened it. */
const START_SCALE = 0.25;

/**
 * Grows `card` out of the control or row the user just acted on, as it first shows: a card too
 * big to sit on that control (a file picker, a review of many songs) still visibly comes from it.
 * With nothing acted on just now, the card shows as it otherwise would.
 */
export function useGrowFromAction(card: RefObject<HTMLElement | null>) {
	useLayoutEffect(() => {
		const element = card.current;
		const origin = currentActionOrigin();
		if (!(element && origin) || reducedMotion()) {
			return;
		}
		const box = element.getBoundingClientRect();
		const x = origin.box.left + origin.box.width / 2 - box.left;
		const y = origin.box.top + origin.box.height / 2 - box.top;
		const from = `${x}px ${y}px`;
		const grow = element.animate(
			[
				{ transformOrigin: from, scale: START_SCALE },
				{ transformOrigin: from, scale: 1 },
			],
			popMotion(),
		);
		const fade = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
		return () => {
			grow.cancel();
			fade.cancel();
		};
	}, [card]);
}
