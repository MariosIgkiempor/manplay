import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type BubblePosition, type BubbleSide, bubblePosition } from "#/lib/bubble-position.ts";
import { parseHint } from "#/lib/hint-format.ts";
import { FLOATING_FRAME, WELL } from "#/lib/page-layout.ts";
import { cn } from "#/lib/utils.ts";

/**
 * How a hint of a few words looks: one small well, e.g. "Artist". Anything with more to say is a
 * `HintCard` in a frame, as the app's sections and popups are.
 */
export const HINT_SURFACE =
	"max-w-64 rounded-lg border border-hairline bg-well px-2 py-1 text-foreground text-xs shadow-md";

/** The frame of a hint with detail: the floating frame at a hint's size. */
export const HINT_FRAME = cn(FLOATING_FRAME, "max-w-72 rounded-xl p-0.5 text-xs shadow-lg");

/** The key that does what the hint says, as a keycap at the end of its title. */
function HintKeys({ keys }: { keys: string }) {
	return (
		<kbd className="ml-auto shrink-0 rounded border border-hairline border-b-2 bg-muted/60 px-1 font-sans text-[0.6875rem] text-muted-foreground leading-4">
			{keys}
		</kbd>
	);
}

/**
 * What every hint in the app shows, whatever opened it: a title, the key for it when there is
 * one, and under them, in a well, whatever else there is to know. Without detail it is the title
 * alone, so short hints stay short.
 */
export function HintCard({
	title,
	keys,
	children,
	wide = false,
}: {
	title: ReactNode;
	keys?: string | null;
	/** The detail, in the well. */
	children?: ReactNode;
	/** Room for a card of several groups, such as what a button is about to do. */
	wide?: boolean;
}) {
	const head = (
		<span className="flex min-w-0 items-center gap-2">
			<span className="min-w-0">{title}</span>
			{keys && <HintKeys keys={keys} />}
		</span>
	);
	if (children === undefined || children === null || children === false) {
		return head;
	}
	return (
		<div className={cn("w-max", wide ? "max-w-80" : "max-w-[17rem]")}>
			<div className={cn("px-2 py-1 font-medium text-foreground", wide && "px-2.5 py-1.5 text-sm")}>
				{head}
			</div>
			<div
				className={cn(
					WELL,
					"space-y-1 rounded-lg px-2 py-1.5 text-muted-foreground leading-snug",
					wide && "px-2.5 py-2",
				)}
			>
				{children}
			</div>
		</div>
	);
}

/** A hint written as a sentence (`data-hint`, a `Hint`'s label), laid out as a `HintCard`. */
export function TextHint({ text }: { text: string }) {
	const { title, detail, keys } = parseHint(text);
	return (
		<HintCard title={title} keys={keys}>
			{detail.length > 0 && detail.map((line) => <p key={line}>{line}</p>)}
		</HintCard>
	);
}

/** Whether a written hint has detail under its title, and so gets a frame. */
export const hintHasDetail = (text: string) => parseHint(text).detail.length > 0;

/**
 * A small note floating beside `anchor`, above everything else and never in the way of the
 * pointer. It is placed once it has been measured, so it does not flash in the wrong spot.
 */
export function Bubble({
	anchor,
	side = "top",
	role = "tooltip",
	framed = false,
	className,
	children,
}: {
	anchor: Element;
	side?: BubbleSide;
	role?: "tooltip" | "status";
	/** Holds a `HintCard` with detail: a frame round its well, not one small well. */
	framed?: boolean;
	className?: string;
	children: ReactNode;
}) {
	const bubble = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<BubblePosition | null>(null);
	// Measured again whenever what it says or points at changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `children` changes the size measured
	useLayoutEffect(() => {
		const own = bubble.current;
		if (own) {
			setPosition(
				bubblePosition(
					anchor.getBoundingClientRect(),
					{ width: own.offsetWidth, height: own.offsetHeight },
					{ width: window.innerWidth, height: window.innerHeight },
					side,
				),
			);
		}
	}, [anchor, side, children]);
	return createPortal(
		<div
			ref={bubble}
			role={role}
			style={{ left: position?.left ?? 0, top: position?.top ?? 0 }}
			className={cn(
				framed ? HINT_FRAME : HINT_SURFACE,
				"pointer-events-none fixed z-[80]",
				position
					? "fade-in-0 animate-in animation-duration-100 motion-reduce:animate-none"
					: "invisible",
				className,
			)}
		>
			{children}
		</div>,
		document.body,
	);
}
