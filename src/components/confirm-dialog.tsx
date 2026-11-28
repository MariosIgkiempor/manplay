import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "#/components/ui/button.tsx";
import {
	type ActionAnchor,
	currentActionAnchor,
	litBoxes,
	showLeaving,
} from "#/lib/action-anchor.ts";
import { type Box, type BubblePosition, bubblePosition } from "#/lib/bubble-position.ts";
import { useExitGhost } from "#/lib/exit-ghost.ts";
import { DIALOG_BACKDROP, DIALOG_FRAME, WELL } from "#/lib/page-layout.ts";
import { useGrowFromAction } from "#/lib/use-grow-from-action.ts";
import { cn } from "#/lib/utils.ts";

/** Stands in for the card where it does not grow from the middle of the window. */
const NO_CARD = { current: null };

/** The space kept clear round the thing a question is about, so its own edge still shows. */
const SPOTLIGHT_PAD = 3;

/** The outline of one hole, starting and ending at its top-left corner. */
function holePoints(box: Box): string {
	const left = box.left - SPOTLIGHT_PAD;
	const top = box.top - SPOTLIGHT_PAD;
	const right = box.left + box.width + SPOTLIGHT_PAD;
	const bottom = box.top + box.height + SPOTLIGHT_PAD;
	return [
		[left, top],
		[right, top],
		[right, bottom],
		[left, bottom],
		[left, top],
	]
		.map(([x, y]) => `${x}px ${y}px`)
		.join(", ");
}

/**
 * A backdrop with a hole over each of `boxes`, so the things being asked about stay lit. Each
 * hole is reached from the corner and left back to it, so the joining lines enclose nothing.
 */
function spotlightClip(boxes: readonly Box[]): string {
	const holes = boxes.map((box) => `${holePoints(box)}, 0 0`).join(", ");
	return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${holes})`;
}

/** Where the card goes beside `anchor`, and the point it grows out of. */
function placeCard(anchor: ActionAnchor, card: HTMLElement): BubblePosition & { origin: string } {
	const size = { width: card.offsetWidth, height: card.offsetHeight };
	const placed = bubblePosition(
		anchor.box,
		size,
		{ width: window.innerWidth, height: window.innerHeight },
		"bottom",
	);
	const pointX = anchor.box.left + anchor.box.width / 2 - placed.left;
	const originX = Math.max(0, Math.min(size.width, pointX));
	return { ...placed, origin: `${originX}px ${placed.side === "bottom" ? "0" : "100%"}` };
}

type Placed = ReturnType<typeof placeCard>;

/** A card beside its anchor sits where it was placed, growing out of the anchor's side. */
function anchoredCardStyle(placed: Placed | null): CSSProperties {
	return {
		position: "fixed",
		left: placed?.left ?? 0,
		top: placed?.top ?? 0,
		...(placed ? { transformOrigin: placed.origin } : {}),
	};
}

/** Its size, and how it comes in: hidden until placed, then sliding off the anchor's side. */
function cardLook(anchored: boolean, placed: Placed | null): string {
	if (!anchored) {
		return "w-[28rem] max-w-[calc(100%-2rem)]";
	}
	return cn(
		"w-[22rem] max-w-[calc(100%-1rem)] shadow-xl motion-pop",
		placed === null && "invisible animate-none",
		placed?.side === "bottom" && "slide-in-from-top-1",
		placed?.side === "top" && "slide-in-from-bottom-1",
	);
}

/**
 * A question's frame: a title, a body and a footer row. Escape or a click outside cancels. It
 * opens as a card beside the thing the user just acted on (or `anchor`), which is outlined; the
 * window behind is not dimmed. With nothing acted on just now (`anchor` null, or a question
 * that opens by itself) it opens in the middle of the window, grown from there, over a dimmed one.
 */
export function Dialog({
	title,
	children,
	footer,
	onCancel,
	anchor: given,
	destructive = false,
}: {
	title: string;
	children?: ReactNode;
	footer: ReactNode;
	onCancel: () => void;
	/** Where the question sits; left out, beside what the user just acted on. */
	anchor?: ActionAnchor | null | undefined;
	/** Marks the lit thing in the destructive colour: what the answer will remove. */
	destructive?: boolean;
}) {
	const overlay = useExitGhost();
	const card = useRef<HTMLDivElement>(null);
	// Taken once, as the question opens: later presses are on the question itself.
	const [anchor] = useState(() => (given === undefined ? currentActionAnchor() : given));
	const [placed, setPlaced] = useState<Placed | null>(null);
	useGrowFromAction(anchor === null ? card : NO_CARD);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onCancel]);
	useLayoutEffect(() => {
		if (anchor && card.current) {
			setPlaced(placeCard(anchor, card.current));
		}
	}, [anchor]);

	const anchored = anchor !== null;
	const lit = anchor ? litBoxes(anchor) : [];
	return createPortal(
		<div
			ref={overlay}
			className={cn("fixed inset-0 z-50", !anchored && "flex items-center justify-center")}
		>
			<div
				aria-hidden="true"
				onMouseDown={onCancel}
				className={anchored ? "absolute inset-0" : DIALOG_BACKDROP}
				style={lit.length > 0 ? { clipPath: spotlightClip(lit) } : undefined}
			/>
			{placed &&
				lit.map((box) => (
					<div
						key={`${box.left},${box.top}`}
						aria-hidden="true"
						className={cn(
							"pointer-events-none fixed animate-in rounded-lg ring-2 fade-in-0 duration-200 motion-reduce:animate-none",
							destructive ? "ring-destructive/70" : "ring-primary/70",
						)}
						style={{
							left: box.left - SPOTLIGHT_PAD,
							top: box.top - SPOTLIGHT_PAD,
							width: box.width + SPOTLIGHT_PAD * 2,
							height: box.height + SPOTLIGHT_PAD * 2,
						}}
					/>
				))}
			{/* The question sits in a well; its answers sit on the frame below it. */}
			<div
				ref={card}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				data-exit
				style={anchored ? anchoredCardStyle(placed) : undefined}
				className={cn(DIALOG_FRAME, "p-1", cardLook(anchored, placed))}
			>
				<div className={`${WELL} space-y-1.5 p-4`}>
					<div className="break-words font-medium text-sm">{title}</div>
					{children && <div className="text-pretty text-muted-foreground text-sm">{children}</div>}
				</div>
				<div className="px-2 pt-2 pb-1">{footer}</div>
			</div>
		</div>,
		document.body,
	);
}

/**
 * Yes/no question, opened beside the button, row or menu it was asked from (see
 * `action-anchor.ts`). Escape or a click outside cancels.
 */
export function ConfirmDialog({
	title,
	children,
	confirmLabel,
	destructive = false,
	busy = false,
	extra,
	onCancel,
	onConfirm,
}: {
	title: string;
	children?: ReactNode;
	confirmLabel: string;
	destructive?: boolean;
	busy?: boolean;
	onCancel: () => void;
	onConfirm: () => void;
	/** A further choice, between Cancel and the confirm button. */
	extra?: ReactNode;
}) {
	// Taken once, as the question opens: later presses are on the question itself.
	const [anchor] = useState(() => currentActionAnchor());
	return (
		<Dialog
			title={title}
			onCancel={onCancel}
			anchor={anchor}
			destructive={destructive}
			footer={
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
					{extra}
					<Button
						variant={destructive ? "destructive" : "default"}
						onClick={() => {
							if (destructive) {
								showLeaving(anchor);
							}
							onConfirm();
						}}
						disabled={busy}
						autoFocus
					>
						{confirmLabel}
					</Button>
				</div>
			}
		>
			{children}
		</Dialog>
	);
}
