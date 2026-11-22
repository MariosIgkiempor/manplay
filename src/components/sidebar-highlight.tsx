import { useRouterState } from "@tanstack/react-router";
import { type RefObject, useEffect, useState } from "react";
import { currentRow } from "#/components/sidebar-row.ts";

/** Where the highlight sits in the sidebar, in pixels from its top left corner. */
interface Box {
	top: number;
	left: number;
	width: number;
	height: number;
}

/** How long after a page change the highlight glides; later moves (scrolling) follow at once. */
const GLIDE_MS = 450;

/** The current row's box in `aside`, cut to the part of its scrolling list that is in view. */
function measure(aside: HTMLElement): Box | null {
	const row = currentRow(aside);
	if (!row) {
		return null;
	}
	const frame = aside.getBoundingClientRect();
	const r = row.getBoundingClientRect();
	let top = r.top - frame.top;
	let bottom = r.bottom - frame.top;
	const list = row.closest("[data-sidebar-scroll]");
	if (list) {
		const view = list.getBoundingClientRect();
		top = Math.max(top, view.top - frame.top);
		bottom = Math.min(bottom, view.bottom - frame.top);
	}
	if (bottom <= top) {
		return null;
	}
	return { top, left: r.left - frame.left, width: r.width, height: bottom - top };
}

/**
 * The open page's highlight: one chip behind the sidebar's rows that glides to the new row when
 * the page changes, instead of each row lighting up on its own. It follows scrolling, groups
 * folding and the sidebar being resized without a glide.
 */
export function SidebarHighlight({ aside }: { aside: RefObject<HTMLElement | null> }) {
	const href = useRouterState({ select: (s) => s.location.href });
	const [box, setBox] = useState<Box | null>(null);
	const [glideUntil, setGlideUntil] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: glides again each time the page changes
	useEffect(() => {
		setGlideUntil(performance.now() + GLIDE_MS);
	}, [href]);

	useEffect(() => {
		const el = aside.current;
		if (!el) {
			return;
		}
		let frame = 0;
		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => setBox(measure(el)));
		};
		update();
		const resized = new ResizeObserver(update);
		resized.observe(el);
		const changed = new MutationObserver(update);
		changed.observe(el, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["class"],
		});
		el.addEventListener("scroll", update, true);
		return () => {
			cancelAnimationFrame(frame);
			resized.disconnect();
			changed.disconnect();
			el.removeEventListener("scroll", update, true);
		};
	}, [aside]);

	if (!box) {
		return null;
	}
	const gliding = performance.now() < glideUntil;
	return (
		<div
			aria-hidden="true"
			className="-z-10 pointer-events-none absolute top-0 left-0 rounded-md bg-foreground/[0.07] shadow-[inset_0_0_0_1px_oklch(1_0_0/5%)] motion-reduce:transition-none"
			style={{
				width: box.width,
				height: box.height,
				translate: `${box.left}px ${box.top}px`,
				transition: gliding
					? "translate 240ms cubic-bezier(0.3, 0, 0.2, 1), height 240ms cubic-bezier(0.3, 0, 0.2, 1), width 240ms cubic-bezier(0.3, 0, 0.2, 1)"
					: "none",
			}}
		/>
	);
}
