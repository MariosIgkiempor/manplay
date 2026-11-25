import { useRouter } from "@tanstack/react-router";
import { type RefObject, useEffect } from "react";

/** The in-app link a plain primary press lands on inside `root`, if it opens on the press. */
function pressedLink(e: PointerEvent, root: HTMLElement): HTMLAnchorElement | null {
	if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
		return null;
	}
	const target = e.target instanceof Element ? e.target : null;
	const link = target?.closest<HTMLAnchorElement>("a[href^='/']") ?? null;
	const control = target?.closest("button, input, [role=button]");
	if (!link || !root.contains(link) || (control && link.contains(control))) {
		return null;
	}
	return link;
}

/**
 * Links under `root` open on the press, not the release, as native sidebars do: a click only
 * fires once the button comes back up, which made every page change start a beat late. The click
 * that follows is then swallowed so it does not navigate again. Only a plain primary press on a
 * link counts; a press on a control inside a row, a modified click (new window, select) and the
 * keyboard keep the usual behaviour.
 */
export function usePressNavigation(root: RefObject<HTMLElement | null>) {
	const router = useRouter();
	useEffect(() => {
		const el = root.current;
		if (!el) {
			return;
		}
		let pressed: HTMLAnchorElement | null = null;
		const onPointerDown = (e: PointerEvent) => {
			pressed = pressedLink(e, el);
			if (pressed) {
				void router.navigate({ href: pressed.getAttribute("href") ?? "/" });
			}
		};
		const onClick = (e: MouseEvent) => {
			const target = e.target instanceof Element ? e.target : null;
			if (pressed && target && pressed.contains(target)) {
				e.preventDefault();
			}
			pressed = null;
		};
		el.addEventListener("pointerdown", onPointerDown);
		el.addEventListener("click", onClick, true);
		return () => {
			el.removeEventListener("pointerdown", onPointerDown);
			el.removeEventListener("click", onClick, true);
		};
	}, [root, router]);
}
