import { useRouterState } from "@tanstack/react-router";
import { useLayoutEffect } from "react";
import { currentRow, PAGE_ROW_ATTRIBUTE } from "#/components/sidebar-row.ts";
import { CARD } from "#/lib/page-layout.ts";

/**
 * Pages scroll past each other in the order the sidebar lists them: going to a page lower in the
 * sidebar scrolls the old page up and out as the new one comes up from below, and going higher
 * does the reverse. The pages listed between the two pass by on the way, each as a placeholder
 * card with its sidebar icon and name. This holds however the page changes (a sidebar click, ⌘K,
 * back and forward). A page with no row in the sidebar only cross-fades.
 *
 * The old page leaves as a view transition snapshot (`defaultViewTransition` in `router.tsx`, its
 * keyframes in `styles.css`); the placeholders and the new page are live elements, moved with the
 * same timing. WebKit does not draw the snapshot of the new state, so the new page is never a
 * snapshot. The page's card and the Files page's second pane move whole, one card after the other
 * with the canvas's gap between them, cut off at the canvas's edge; the sidebar and player keep
 * running.
 */
export type PageDirection = "up" | "down";

/** Marks what moves as the page changes: the page's card and the Files page's second pane. */
export const PAGE_MOTION_ATTRIBUTE = "data-page-motion";
/** Where the direction waits on the root element for the transition's styles. */
const DIRECTION_ATTRIBUTE = "data-page-move";
/** How many cards the old page travels, for its keyframes in `styles.css`. */
const STEPS_PROPERTY = "--page-steps";
/** How long it travels, for its keyframes in `styles.css`. */
const DURATION_PROPERTY = "--page-scroll-ms";
/** Mirrors the bit `Node.compareDocumentPosition` sets when the other node comes later. */
const FOLLOWING = 4;

/** The page's direction from one sidebar row to another: down when the new row is lower. */
export function directionBetween(
	from: Pick<Node, "compareDocumentPosition"> | null,
	to: Node | null,
): PageDirection | null {
	if (from === null || to === null || from === to) {
		return null;
	}
	return from.compareDocumentPosition(to) & FOLLOWING ? "down" : "up";
}

/** Milliseconds a page change takes. */
export type ScrollMs = number;

const BASE_SCROLL_MS: ScrollMs = 420;
const SCROLL_MS_PER_PASSED_PAGE: ScrollMs = 40;
const LONGEST_SCROLL_MS: ScrollMs = 720;
/** More pages than this between the two would only blur; every other one is left out instead. */
export const MOST_PASSED_PAGES = 10;

/** A longer trip takes a little longer, but never so long that the app feels slow. */
export function scrollMsFor(passedPages: number): ScrollMs {
	return Math.min(LONGEST_SCROLL_MS, BASE_SCROLL_MS + passedPages * SCROLL_MS_PER_PASSED_PAGE);
}

/**
 * Which of `count` pages in between to show, as indexes in sidebar order: all of them when there
 * are few, otherwise `most` of them spread evenly, keeping the first and the last.
 */
export function passedPagesToShow(count: number, most: number = MOST_PASSED_PAGES): number[] {
	if (count <= most) {
		return Array.from({ length: count }, (_, i) => i);
	}
	if (most <= 1) {
		return most === 1 ? [0] : [];
	}
	return Array.from({ length: most }, (_, i) => Math.round((i * (count - 1)) / (most - 1)));
}

/** A card's height and the canvas's gap, `n` times over, as a CSS length. */
const cards = (n: number) => `calc(${n} * (100% + 0.5rem))`;
const SCROLL_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

/** The sidebar rows that open a page, top to bottom; rows inside folded groups are not drawn. */
function pageRows(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>(`[${PAGE_ROW_ATTRIBUTE}]`)];
}

/** Where `row` (a current row, which may wrap its link) sits in `rows`, or -1. */
const indexIn = (rows: readonly HTMLElement[], row: Element) =>
	rows.findIndex((r) => r === row || row.contains(r));

/** The rows strictly between two sidebar rows, in the order the page passes them. */
function rowsBetween(from: Element, to: Element): HTMLElement[] {
	const rows = pageRows();
	const start = indexIn(rows, from);
	const end = indexIn(rows, to);
	if (start === -1 || end === -1) {
		return [];
	}
	return start < end ? rows.slice(start + 1, end) : rows.slice(end + 1, start).reverse();
}

/** A placeholder for a page passed on the way: its card, with the sidebar row's icon and name. */
function placeholderFor(row: HTMLElement, card: HTMLElement): HTMLElement {
	const ghost = document.createElement("div");
	ghost.setAttribute("aria-hidden", "true");
	ghost.className = `${CARD} pointer-events-none absolute overflow-hidden`;
	ghost.style.left = `${card.offsetLeft}px`;
	ghost.style.top = `${card.offsetTop}px`;
	ghost.style.width = `${card.offsetWidth}px`;
	ghost.style.height = `${card.offsetHeight}px`;
	const heading = document.createElement("div");
	heading.className =
		"flex items-center gap-2.5 px-6 pt-6 font-semibold text-muted-foreground text-xl tracking-tight [&_svg]:size-5";
	const icon = row.querySelector("[role=img], svg");
	if (icon) {
		heading.append(icon.cloneNode(true));
	}
	const name = document.createElement("span");
	name.className = "truncate";
	name.textContent = row.getAttribute(PAGE_ROW_ATTRIBUTE);
	heading.append(name);
	ghost.append(heading);
	return ghost;
}

/** The pages to pass going from one row to the other, spread out when there are many. */
function passedRows(from: Element | null, to: Element | null): HTMLElement[] {
	if (from === null || to === null) {
		return [];
	}
	const between = rowsBetween(from, to);
	return passedPagesToShow(between.length).flatMap((i) => between[i] ?? []);
}

/** Leaves the direction, and how far and long the old page travels, for its keyframes. */
function markDirection(direction: PageDirection | null, steps: number, duration: ScrollMs) {
	const root = document.documentElement;
	if (direction === null) {
		root.removeAttribute(DIRECTION_ATTRIBUTE);
		return;
	}
	root.setAttribute(DIRECTION_ATTRIBUTE, direction);
	root.style.setProperty(STEPS_PROPERTY, String(steps));
	root.style.setProperty(DURATION_PROPERTY, `${duration}ms`);
}

/**
 * Sends a placeholder over the page's card for each passed page, on the canvas that clips the
 * card. `sign` is 1 when the strip moves up; each removes itself once it has gone by.
 */
function sendPlaceholders(
	passed: readonly HTMLElement[],
	card: HTMLElement | undefined,
	sign: number,
	timing: KeyframeAnimationOptions,
): HTMLElement[] {
	const canvas = card?.parentElement;
	if (!(card && canvas)) {
		return [];
	}
	const steps = passed.length + 1;
	return passed.map((passedRow, i) => {
		const ghost = placeholderFor(passedRow, card);
		canvas.append(ghost);
		const place = sign * (i + 1);
		const travel = [
			{ translate: `0 ${cards(place)}` },
			{ translate: `0 ${cards(place - sign * steps)}` },
		];
		const remove = () => ghost.remove();
		ghost.animate(travel, timing).finished.then(remove, remove);
		return ghost;
	});
}

/** The open page's sidebar row as the last page change left it. */
let previousRow: Element | null = null;

/**
 * Moves the page each time the path changes. It runs while the router is still inside the view
 * transition's update: the old page's snapshot is taken, the sidebar has marked the new page's row,
 * and the transition has not yet started its animations, so the styles see the direction in time.
 */
export function usePageDirection() {
	// The rendered page's path. The location changes as soon as a navigation starts, before the
	// transition has taken its snapshot of the old page; the matches change only once the new page
	// is committed, inside the transition's update.
	const path = useRouterState({ select: (s) => s.matches.at(-1)?.pathname });
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs again each time the page changes
	useLayoutEffect(() => {
		const row = currentRow(document);
		const from = previousRow?.isConnected ? previousRow : null;
		const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const direction = still ? null : directionBetween(from, row);
		previousRow = row;
		const passed = direction === null ? [] : passedRows(from, row);
		const steps = passed.length + 1;
		const duration = scrollMsFor(passed.length);
		markDirection(direction, steps, duration);
		// Down: the strip moves up, so what comes later starts lower.
		const sign = direction === "down" ? 1 : -1;
		const timing = { duration, easing: SCROLL_EASING };
		const moving = [...document.querySelectorAll<HTMLElement>(`[${PAGE_MOTION_ATTRIBUTE}]`)];
		const arrivals = moving.map((el) => {
			// Unnamed for the new state, so the transition leaves the live page alone.
			el.style.viewTransitionName = "none";
			if (direction === null) {
				return null;
			}
			return el.animate([{ translate: `0 ${cards(sign * steps)}` }, { translate: "0 0" }], timing);
		});
		const card = moving.find((el) => el.getAttribute(PAGE_MOTION_ATTRIBUTE) === "page");
		const ghosts = sendPlaceholders(passed, card, sign, timing);
		// Named again once the transition is over, so the next page change can snapshot it.
		const rename = window.setTimeout(() => {
			for (const el of moving) {
				el.style.removeProperty("view-transition-name");
			}
		}, duration + 100);
		return () => {
			window.clearTimeout(rename);
			for (const arrival of arrivals) {
				arrival?.finish();
			}
			for (const ghost of ghosts) {
				ghost.remove();
			}
			for (const el of moving) {
				el.style.removeProperty("view-transition-name");
			}
		};
	}, [path]);
}
