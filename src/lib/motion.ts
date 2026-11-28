/**
 * The app's motion in one place: how things arrive (a spring that overshoots once and settles)
 * and how they leave (quickly, with no bounce). Scripted animations take these as they are.
 */

type Milliseconds = number;
/** How far along an animation is, from 0 (start) to 1 (settled); a spring passes 1 on its way. */
type Progress = number;

/** A spring: how hard it pulls (`stiffness`) and how fast it comes to rest (`damping`). */
export interface Spring {
	stiffness: number;
	damping: number;
}

/** A timing an animation runs with (`element.animate`). */
export interface Motion {
	easing: string;
	duration: Milliseconds;
}

/** The spring behind everything that grows or arrives: about 7% past its mark, once. */
export const POP_SPRING: Spring = { stiffness: 560, damping: 31 };

/** A spring is at rest once it stays this close to its mark. */
const REST = 0.001;
/** Points along the curve given to the browser; enough that the overshoot stays round. */
const CURVE_POINTS = 48;

/** No spring here runs longer than this. */
const LONGEST: Milliseconds = 3000;

/** How long `spring` takes to come to rest: the last moment it is still away from its mark. */
export function springDuration(spring: Spring): Milliseconds {
	for (let at = LONGEST; at > 0; at -= 1) {
		if (Math.abs(1 - springAt(spring, at / 1000)) > REST) {
			return at + 1;
		}
	}
	return 0;
}

/** Where `spring` is `seconds` after it is let go from 0 towards 1. */
export function springAt(spring: Spring, seconds: number): Progress {
	const frequency = Math.sqrt(spring.stiffness);
	const decay = spring.damping / 2;
	const ratio = decay / frequency;
	if (ratio >= 1) {
		// No bounce left in it: it only eases up to its mark.
		return 1 - Math.exp(-frequency * seconds) * (1 + frequency * seconds);
	}
	const swing = frequency * Math.sqrt(1 - ratio * ratio);
	return (
		1 -
		Math.exp(-decay * seconds) *
			(Math.cos(swing * seconds) + (decay / swing) * Math.sin(swing * seconds))
	);
}

/** `spring` as a CSS `linear()` curve over its whole duration. */
export function springCurve(spring: Spring): string {
	const seconds = springDuration(spring) / 1000;
	const points = Array.from({ length: CURVE_POINTS + 1 }, (_, i) => {
		const at = i === CURVE_POINTS ? 1 : springAt(spring, (seconds * i) / CURVE_POINTS);
		return at.toFixed(4);
	});
	return `linear(${points.join(", ")})`;
}

/** For a webview too old for `linear()` curves (macOS 11 to 13): one overshoot, close enough. */
const POP_FALLBACK: Motion = { easing: "cubic-bezier(0.34, 1.4, 0.64, 1)", duration: 340 };

let pop: Motion | null = null;

/** How things grow and arrive. */
export function popMotion(): Motion {
	if (pop === null) {
		const curves =
			typeof CSS !== "undefined" && CSS.supports("transition-timing-function", "linear(0, 1)");
		pop = curves
			? { easing: springCurve(POP_SPRING), duration: springDuration(POP_SPRING) }
			: POP_FALLBACK;
	}
	return pop;
}

/** How things shrink back and leave: quicker than they came, and without a bounce. */
export const LEAVE_MOTION: Motion = { easing: "cubic-bezier(0.3, 0, 0.2, 1)", duration: 220 };

/** How things travel from one place to another (a pane, a row): smoothly, with no bounce. */
export const TRAVEL_MOTION: Motion = { easing: "cubic-bezier(0.32, 0.72, 0, 1)", duration: 240 };

/** True when the user asked the system for less motion: everything then changes at once. */
export function reducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
