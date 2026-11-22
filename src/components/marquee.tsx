import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "#/lib/utils.ts";

/** Brisk enough to read a long title in a few seconds, slow enough to read it at all. */
const SPEED_PX_PER_SECOND = 60;
/** How long the start of the text rests in place before each pass. */
const REST_MS = 1400;
/** Space between the end of the text and its repeat, in px. */
const GAP_PX = 40;
/** The fade at the left edge; the box reaches this far left so the text at rest is not faded. */
const EDGE_PX = 6;

interface Widths {
	box: number;
	content: number;
}

/**
 * One line of text that scrolls round, like a CDJ's title display, when it does not fit. It rests
 * at the start, then passes once; it holds still under the pointer or keyboard focus so its links
 * can be clicked, and never moves with reduced motion.
 */
export function Marquee({ children, className }: { children: ReactNode; className?: string }) {
	const box = useRef<HTMLDivElement>(null);
	const strip = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const motion = useRef<Animation | null>(null);
	const [widths, setWidths] = useState<Widths>({ box: 0, content: 0 });
	const overflows = widths.content > widths.box + 1;

	useLayoutEffect(() => {
		const boxEl = box.current;
		const contentEl = content.current;
		if (!boxEl || !contentEl) {
			return;
		}
		const measure = () =>
			setWidths({
				box: boxEl.clientWidth - EDGE_PX,
				content: contentEl.getBoundingClientRect().width,
			});
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(boxEl);
		observer.observe(contentEl);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const el = strip.current;
		if (!el || !overflows || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			return;
		}
		const distance = widths.content + GAP_PX;
		const total = (distance / SPEED_PX_PER_SECOND) * 1000 + REST_MS;
		const animation = el.animate(
			[
				{ transform: "translateX(0)" },
				{ transform: "translateX(0)", offset: REST_MS / total },
				{ transform: `translateX(${-distance}px)` },
			],
			{ duration: total, iterations: Number.POSITIVE_INFINITY },
		);
		motion.current = animation;
		return () => {
			animation.cancel();
			motion.current = null;
		};
	}, [overflows, widths.content]);

	useEffect(() => {
		const el = box.current;
		if (!el) {
			return;
		}
		const hold = () => motion.current?.pause();
		const resume = () => motion.current?.play();
		el.addEventListener("pointerenter", hold);
		el.addEventListener("pointerleave", resume);
		el.addEventListener("focusin", hold);
		el.addEventListener("focusout", resume);
		return () => {
			el.removeEventListener("pointerenter", hold);
			el.removeEventListener("pointerleave", resume);
			el.removeEventListener("focusin", hold);
			el.removeEventListener("focusout", resume);
		};
	}, []);

	return (
		<div
			ref={box}
			style={{ marginLeft: -EDGE_PX, paddingLeft: EDGE_PX }}
			className={cn(
				"min-w-0 overflow-hidden",
				// The text fades at the edges it passes, instead of being cut mid-letter.
				overflows &&
					"[mask-image:linear-gradient(to_right,transparent,black_6px,black_calc(100%-20px),transparent)]",
				className,
			)}
		>
			<div ref={strip} className="flex w-max" style={{ gap: GAP_PX }}>
				<div ref={content} className="shrink-0 whitespace-nowrap">
					{children}
				</div>
				{overflows && (
					<div aria-hidden="true" inert className="shrink-0 whitespace-nowrap">
						{children}
					</div>
				)}
			</div>
		</div>
	);
}
