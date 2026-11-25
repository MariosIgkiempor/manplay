import { useRouter } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useRef } from "react";
import {
	GESTURE_GAP_MS,
	IDLE_SWIPE,
	type SwipeDirection,
	type SwipeState,
	swipeStep,
} from "#/lib/history-swipe.ts";

/** Mouse buttons that go back and forward, as `MouseEvent.button` numbers them. */
const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;

/** Whether something under the pointer scrolls or pans sideways itself, e.g. a tab row. */
function handlesSideways(target: EventTarget | null): boolean {
	for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
		if (el instanceof HTMLCanvasElement) {
			return true;
		}
		const { overflowX } = getComputedStyle(el);
		if ((overflowX === "auto" || overflowX === "scroll") && el.scrollWidth > el.clientWidth) {
			return true;
		}
	}
	return false;
}

/**
 * Places an edge arrow for how far a swipe towards it has come, 0 (hidden) to 1 (far enough):
 * it slides in from the edge and grows, then fills in the accent colour once letting go would go.
 */
function drawArrow(el: HTMLElement | null, edge: "left" | "right", towards: number) {
	if (!el) {
		return;
	}
	const amount = Math.max(0, towards);
	const side = edge === "right" ? -1 : 1;
	el.style.opacity = String(Math.min(1, amount * 1.5));
	el.style.transform = `translateX(${side * (amount * 56 - 48)}px) scale(${0.8 + amount * 0.2})`;
	// `card-surface` sets the ground, so the filled look goes on the element itself.
	const ready = amount >= 1;
	el.style.backgroundColor = ready ? "var(--primary)" : "";
	el.style.color = ready ? "var(--primary-foreground)" : "";
}

/**
 * Back and forward by a two-finger sideways swipe and by a mouse's side buttons, as in a browser
 * (⌘[ and ⌘] are in `AppShortcuts`). While a swipe is under way an arrow slides in from the edge
 * it goes towards, and fills once letting go would not be needed: the page changes as soon as the
 * swipe is far enough.
 */
export function HistorySwipe() {
	const router = useRouter();
	const backArrow = useRef<HTMLDivElement>(null);
	const forwardArrow = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const { history } = router;
		// The browser's history says if there is a page behind but not one ahead; count those.
		let ahead = 0;
		const unsubscribe = history.subscribe(({ action }) => {
			if (action.type === "BACK") {
				ahead += 1;
			} else if (action.type === "FORWARD") {
				ahead = Math.max(0, ahead - 1);
			} else if (action.type === "PUSH") {
				ahead = 0;
			}
		});
		const go = (direction: SwipeDirection) => {
			if (direction === "back" && history.canGoBack()) {
				history.back();
			} else if (direction === "forward" && ahead > 0) {
				history.forward();
			}
		};
		const canGo = (direction: SwipeDirection) =>
			direction === "back" ? history.canGoBack() : ahead > 0;

		const draw = (progress: number) => {
			drawArrow(backArrow.current, "left", canGo("back") ? progress : 0);
			drawArrow(forwardArrow.current, "right", canGo("forward") ? -progress : 0);
		};

		let state: SwipeState = IDLE_SWIPE;
		let settle: ReturnType<typeof setTimeout> | undefined;
		const onWheel = (e: WheelEvent) => {
			if (e.defaultPrevented || e.ctrlKey || handlesSideways(e.target)) {
				return;
			}
			const step = swipeStep(state, { deltaX: e.deltaX, deltaY: e.deltaY, at: e.timeStamp });
			state = step.state;
			draw(state.fired ? 0 : step.progress);
			if (step.go) {
				go(step.go);
			}
			clearTimeout(settle);
			settle = setTimeout(() => draw(0), GESTURE_GAP_MS);
		};
		const onMouseUp = (e: MouseEvent) => {
			if (e.button === MOUSE_BACK || e.button === MOUSE_FORWARD) {
				e.preventDefault();
				go(e.button === MOUSE_BACK ? "back" : "forward");
			}
		};
		window.addEventListener("wheel", onWheel, { passive: true });
		window.addEventListener("mouseup", onMouseUp);
		return () => {
			unsubscribe();
			clearTimeout(settle);
			window.removeEventListener("wheel", onWheel);
			window.removeEventListener("mouseup", onMouseUp);
		};
	}, [router]);

	const arrow =
		"pointer-events-none fixed top-1/2 z-[70] -mt-5 grid size-10 place-items-center rounded-full card-surface text-muted-foreground opacity-0 transition-[opacity,transform] duration-75 ease-out motion-reduce:transition-none [&_svg]:size-5";
	return (
		<>
			<div ref={backArrow} aria-hidden="true" className={`${arrow} left-2`}>
				<ArrowLeft />
			</div>
			<div ref={forwardArrow} aria-hidden="true" className={`${arrow} right-2`}>
				<ArrowRight />
			</div>
		</>
	);
}
