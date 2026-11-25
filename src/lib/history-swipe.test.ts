import { describe, expect, it } from "vitest";
import {
	GESTURE_GAP_MS,
	IDLE_SWIPE,
	SWIPE_DISTANCE,
	type SwipeDirection,
	type SwipeState,
	swipeStep,
	type WheelStep,
} from "#/lib/history-swipe.ts";

/** Runs a gesture of `steps` and says where it went, if anywhere, and how often. */
function run(steps: readonly WheelStep[]): SwipeDirection[] {
	let state: SwipeState = IDLE_SWIPE;
	const went: SwipeDirection[] = [];
	for (const step of steps) {
		const next = swipeStep(state, step);
		state = next.state;
		if (next.go) {
			went.push(next.go);
		}
	}
	return went;
}

const sideways = (deltaX: number, count: number, from = 0, every = 16): WheelStep[] =>
	Array.from({ length: count }, (_, i) => ({ deltaX, deltaY: 0, at: from + i * every }));

describe("swipeStep", () => {
	it.each<[string, WheelStep[], SwipeDirection[]]>([
		["fingers right, far enough: back", sideways(-20, 10), ["back"]],
		["fingers left, far enough: forward", sideways(20, 10), ["forward"]],
		["too short a swipe: nothing", sideways(-10, 5), []],
		["a long glide still goes once", sideways(-30, 40), ["back"]],
		[
			"vertical scrolling: nothing",
			Array.from({ length: 20 }, (_, i) => ({ deltaX: 8, deltaY: 40, at: i * 16 })),
			[],
		],
		[
			"two gestures with a pause between: twice",
			[...sideways(-30, 8), ...sideways(-30, 8, 8 * 16 + GESTURE_GAP_MS + 50)],
			["back", "back"],
		],
		[
			"halves of a swipe split by a pause do not add up",
			[...sideways(-SWIPE_DISTANCE / 4, 3), ...sideways(-SWIPE_DISTANCE / 4, 3, 1000)],
			[],
		],
	])("%s", (_, steps, expected) => {
		expect(run(steps)).toEqual(expected);
	});
});
