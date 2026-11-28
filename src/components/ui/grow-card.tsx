import {
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	type CardPlace,
	GROW_CELL_ATTRIBUTE,
	GROW_FROM_ATTRIBUTE,
	GROW_HERO_ATTRIBUTE,
	GROW_LAYER_ATTRIBUTE,
	GROW_LIFTED_ATTRIBUTE,
	GROW_OPENER_ATTRIBUTE,
	PLAIN_REACH,
	placeInLayer,
	placeInWindow,
	type Reach,
	type ScreenBox,
	windowCentre,
} from "#/lib/grow-card.ts";
import {
	boxOf,
	type CardOrigin,
	type CardParts,
	growOrShrink,
	land,
	type Running,
	stopMotion,
} from "#/lib/grow-motion.ts";
import { reducedMotion } from "#/lib/motion.ts";
import { FLOATING_FRAME, WELL } from "#/lib/page-layout.ts";
import { cn } from "#/lib/utils.ts";

/**
 * Keeps the press that closes a card from also pressing what it landed on (another tile, a tab),
 * as a press outside an open menu only closes the menu.
 */
function swallowClick() {
	const swallow = (e: MouseEvent) => {
		e.stopPropagation();
		e.preventDefault();
	};
	document.addEventListener("click", swallow, { capture: true, once: true });
	// The click, if one comes, follows the release at once.
	const release = () => setTimeout(() => document.removeEventListener("click", swallow, true), 0);
	document.addEventListener("pointerup", release, { capture: true, once: true });
}

/** A press on the page outside the card closes it; a press in a menu or the player does not. */
function useDismiss(card: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => {
		if (!open) {
			return;
		}
		const key = (e: KeyboardEvent) => {
			const typing =
				e.target instanceof HTMLElement &&
				(["INPUT", "TEXTAREA"].includes(e.target.tagName) || e.target.isContentEditable);
			// Escape first closes whatever floats above the card: a menu, a picker, a question.
			const popupOpen = document.querySelector("[role=menu], [role=dialog], [data-side]");
			if (e.key === "Escape" && !e.defaultPrevented && !typing && !popupOpen) {
				close.current();
			}
		};
		const press = (e: PointerEvent) => {
			const target = e.target;
			if (!(target instanceof Element) || card.current?.contains(target)) {
				return;
			}
			// Menus, pickers and hints are drawn on the body, outside the page.
			if (target.closest("main")) {
				swallowClick();
				close.current();
			}
		};
		document.addEventListener("keydown", key);
		document.addEventListener("pointerdown", press);
		return () => {
			document.removeEventListener("keydown", key);
			document.removeEventListener("pointerdown", press);
		};
	}, [card, open]);
}

/** A card may still be taking its size this long after it opens, as its content loads. */
const SETTLING_MS = 1500;

/** What a card found on the page when it opened: where it lives and what it grows out of. */
interface Source {
	/** The scrolling area it is laid out in; null when it floats over the window. */
	layer: HTMLElement | null;
	/** The tile or row it belongs to, which shows its picture is out while the card is. */
	cell: Element | null;
	origin: CardOrigin;
}

function findSource(element: Element | null, box: ScreenBox | null): Source {
	const live = element?.isConnected ? element : null;
	const cell = live?.closest(`[${GROW_CELL_ATTRIBUTE}]`) ?? live;
	const inCell = cell?.querySelector(`[${GROW_FROM_ATTRIBUTE}]`) ?? null;
	// A link to something else in the cell (an album's artist) leaves the cell's picture where it is.
	const takes = live?.hasAttribute(GROW_OPENER_ATTRIBUTE) || (inCell && live?.contains(inCell));
	const picture = takes ? inCell : null;
	return {
		layer: live?.closest<HTMLElement>(`[${GROW_LAYER_ATTRIBUTE}]`) ?? null,
		cell: picture ? cell : null,
		origin: {
			picture,
			element: live,
			box: box ?? windowCentre({ width: window.innerWidth, height: window.innerHeight }),
		},
	};
}

/** How far the card's picture is from the card's corner: the origin's picture grows in place. */
function pictureReach(source: Source, card: HTMLElement): Reach {
	const hero = source.origin.picture && card.querySelector(`[${GROW_HERO_ATTRIBUTE}]`);
	if (!hero) {
		return PLAIN_REACH;
	}
	const corner = boxOf(card);
	const at = boxOf(hero);
	return { x: at.left - corner.left, y: at.top - corner.top };
}

function place(source: Source, card: HTMLElement, width: number): CardPlace {
	const { origin, layer } = source;
	const from = origin.picture?.isConnected
		? boxOf(origin.picture)
		: origin.element?.isConnected
			? boxOf(origin.element)
			: origin.box;
	const reach = pictureReach(source, card);
	if (layer) {
		const scroll = { left: layer.scrollLeft, top: layer.scrollTop };
		return placeInLayer(from, boxOf(layer), scroll, width, reach);
	}
	const size = { width: window.innerWidth, height: window.innerHeight };
	return placeInWindow(from, size, width, card.offsetHeight, reach);
}

/** Opening, the card takes the focus and comes into view. */
function bringIn(card: HTMLElement, inLayer: boolean, still: boolean) {
	card.focus({ preventScroll: true });
	if (inLayer) {
		card.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
	}
}

/** Shut, the origin shows its picture again and takes back the focus the card had. */
function handBack(card: HTMLElement, source: Source) {
	const hadFocus = card.contains(document.activeElement);
	source.cell?.removeAttribute(GROW_LIFTED_ATTRIBUTE);
	if (hadFocus && source.origin.element instanceof HTMLElement) {
		source.origin.element.focus({ preventScroll: true });
	}
	land(source.origin.picture);
}

/**
 * A card that grows out of the thing that opened it (a tile, a row, a button) and lies over
 * whatever is around it, moving none of it. Grown from something on the page it is part of the
 * page and scrolls with it; grown from anywhere else (the player, the sidebar) it floats over the
 * window. A picture marked `GROW_FROM_ATTRIBUTE` in the origin flies to the one marked
 * `GROW_HERO_ATTRIBUTE` in the card. Escape or a press elsewhere on the page closes it; `onClosed`
 * runs once it has shrunk back, which is when to stop rendering it.
 */
export function GrowCard({
	open,
	originElement,
	originBox,
	onClose,
	onClosed,
	label,
	width = 640,
	bar,
	className,
	children,
}: {
	open: boolean;
	/** The thing pressed, which the card grows out of. */
	originElement: Element | null;
	/** Where that was, for when it has left the page; without either the card grows mid-window. */
	originBox: ScreenBox | null;
	onClose: () => void;
	onClosed: () => void;
	/** What the card holds, for a screen reader. */
	label: string;
	/** Its width in pixels where there is the room. */
	width?: number;
	/** A line of controls above the content, which stays while the content scrolls. */
	bar?: ReactNode;
	/** Pads the scrolling content. */
	className?: string;
	children: ReactNode;
}) {
	const [source] = useState(() => findSource(originElement, originBox));
	const [placed, setPlaced] = useState<CardPlace | null>(null);
	const card = useRef<HTMLElement>(null);
	const shell = useRef<HTMLDivElement>(null);
	const body = useRef<HTMLDivElement>(null);
	const running = useRef<Running | null>(null);
	const wasOpen = useRef(false);
	const closed = useRef(onClosed);
	closed.current = onClosed;

	useDismiss(card, open, onClose);

	// Finds its place; again whenever the room it has, or its own height, changes.
	useLayoutEffect(() => {
		const el = card.current;
		if (!el) {
			return;
		}
		source.cell?.setAttribute(GROW_LIFTED_ATTRIBUTE, "");
		const measure = () =>
			setPlaced((was) => {
				const next = place(source, el, width);
				const same = was?.left === next.left && was.top === next.top && was.width === next.width;
				return same ? was : next;
			});
		measure();
		// Measured on the next frame, so a change of size is not answered within its own layout pass.
		let frame = 0;
		const born = performance.now();
		const watch = new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				measure();
				// Content that arrives just after the card opens (a song's tags) makes it taller.
				if (source.layer && performance.now() - born < SETTLING_MS) {
					el.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
				}
			});
		});
		watch.observe(el);
		if (source.layer) {
			watch.observe(source.layer);
		}
		window.addEventListener("resize", measure);
		return () => {
			cancelAnimationFrame(frame);
			watch.disconnect();
			window.removeEventListener("resize", measure);
			source.cell?.removeAttribute(GROW_LIFTED_ATTRIBUTE);
		};
	}, [source, width]);

	const isPlaced = placed !== null;
	useLayoutEffect(() => {
		const parts = partsOf(card.current, shell.current, body.current);
		if (!(isPlaced && parts) || wasOpen.current === open) {
			return;
		}
		wasOpen.current = open;
		const finish = () => {
			running.current = null;
			handBack(parts.card, source);
			closed.current();
		};
		running.current = change(parts, source, open, running.current, finish);
	}, [open, isPlaced, source]);

	// Leaving the page mid-way lets go of what was moving.
	useEffect(() => () => stopMotion(running.current, null), []);

	return createPortal(
		<section
			ref={card}
			aria-label={label}
			tabIndex={-1}
			data-grow-card
			className={cn(
				// Above a page's sticky header (z-30), which a card grown from the first row reaches into.
				"z-40 scroll-mt-28 scroll-mb-8 outline-none",
				source.layer ? "absolute pb-8" : "fixed",
			)}
			style={
				placed
					? { left: placed.left, top: placed.top, width: placed.width }
					: { left: 0, top: 0, width, visibility: "hidden" }
			}
		>
			<div className="relative">
				<div
					ref={shell}
					aria-hidden="true"
					className={cn("absolute inset-0 origin-top-left will-change-transform", FLOATING_FRAME)}
				/>
				<div ref={body} className="relative p-1">
					{bar}
					<div className={cn(WELL, "overflow-hidden")}>
						<div
							className={cn(
								"max-h-[min(44rem,calc(100dvh-15rem))] overflow-y-auto overscroll-contain",
								className,
							)}
						>
							{children}
						</div>
					</div>
				</div>
			</div>
		</section>,
		source.layer ?? document.body,
	);
}

function partsOf(
	card: HTMLElement | null,
	shell: HTMLElement | null,
	body: HTMLElement | null,
): CardParts | null {
	return card && shell && body ? { card, shell, body } : null;
}

/** Opens or shuts the card; with reduced motion, at once. Returns what is now moving. */
function change(
	parts: CardParts,
	source: Source,
	open: boolean,
	was: Running | null,
	closed: () => void,
): Running | null {
	const still = reducedMotion();
	if (open) {
		bringIn(parts.card, source.layer !== null, still);
	}
	if (!still) {
		const hero = parts.card.querySelector<HTMLElement>(`[${GROW_HERO_ATTRIBUTE}]`);
		return growOrShrink(parts, source.origin, hero, open, was, open ? () => undefined : closed);
	}
	if (!open) {
		closed();
	}
	return null;
}
