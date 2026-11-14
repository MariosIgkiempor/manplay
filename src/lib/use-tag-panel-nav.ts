import { type KeyboardEvent, useCallback, useRef } from "react";

const FIELDS = "input:not([type=file]), select";

/** Key table for the panel itself: `j`/`k`/`i` move between fields, `h`/Esc return to the list. */
function panelKeys(
	panel: HTMLElement | null,
	last: { current: HTMLElement | null },
	focusFiles: () => void,
): Record<string, () => void> {
	const list = [...(panel?.querySelectorAll<HTMLElement>(FIELDS) ?? [])].filter(
		(el) => el.offsetParent !== null,
	);
	const at = last.current ? list.indexOf(last.current) : -1;
	const go = (i: number) => {
		const el = list[Math.min(list.length - 1, Math.max(0, i))];
		if (el) {
			last.current = el;
			el.scrollIntoView({ block: "nearest" });
			el.focus();
		}
	};
	return {
		h: focusFiles,
		Escape: focusFiles,
		j: () => go(at + 1),
		k: () => go(at === -1 ? 0 : at - 1),
		i: () => go(Math.max(at, 0)),
		Enter: () => go(Math.max(at, 0)),
	};
}

function isField(el: EventTarget | null): el is HTMLElement {
	return el instanceof HTMLInputElement || el instanceof HTMLSelectElement;
}

/**
 * Vim-style hand-off between the file list and the tag panel. `L` in the list focuses the panel;
 * there `j`/`k` pick a field, `i`/Enter edit it, Esc leaves the field, and `h`/Esc go back to the list.
 */
export function useTagPanelNav({
	root,
	hasTarget,
	activePane,
	open,
}: {
	root: React.RefObject<HTMLElement | null>;
	hasTarget: boolean;
	activePane: number;
	open: () => void;
}) {
	const panel = useRef<HTMLElement>(null);
	/** Field last focused, so `j`/`k` continue from there. */
	const last = useRef<HTMLElement | null>(null);

	const focusTags = useCallback(() => {
		if (hasTarget) {
			open();
			requestAnimationFrame(() => panel.current?.focus());
		}
	}, [hasTarget, open]);

	const focusFiles = () =>
		root.current?.querySelectorAll<HTMLElement>("[data-file-pane]")[activePane]?.focus();

	const onKeyDown = (ev: KeyboardEvent) => {
		const t = ev.target;
		if (isField(t)) {
			if (ev.key === "Escape" && !ev.defaultPrevented) {
				last.current = t;
				panel.current?.focus();
			}
			return;
		}
		if (t !== panel.current || ev.metaKey || ev.ctrlKey || ev.altKey) {
			return;
		}
		const keys = panelKeys(panel.current, last, focusFiles);
		const run = keys[ev.key];
		if (run) {
			ev.preventDefault();
			run();
		}
	};

	return { panel, focusTags, onKeyDown };
}
