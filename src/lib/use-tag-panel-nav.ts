import { useCallback, useEffect, useRef } from "react";

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

/** Escape in a field hands focus to the panel itself, remembering the field. */
function leaveField(
	ev: globalThis.KeyboardEvent,
	field: HTMLElement,
	panel: HTMLElement,
	last: { current: HTMLElement | null },
) {
	if (ev.key === "Escape" && !ev.defaultPrevented) {
		last.current = field;
		panel.focus();
	}
}

/** A key pressed with the panel itself focused (no field), when it is one of the panel's keys. */
function runPanelKey(
	ev: globalThis.KeyboardEvent,
	panel: HTMLElement,
	last: { current: HTMLElement | null },
	focusFiles: () => void,
) {
	if (ev.metaKey || ev.ctrlKey || ev.altKey) {
		return;
	}
	const run = panelKeys(panel, last, focusFiles)[ev.key];
	if (run) {
		ev.preventDefault();
		ev.stopPropagation();
		run();
	}
}

/** The app's side panel, where the tag editor shows. */
const getPanel = () => document.querySelector<HTMLElement>("[data-detail-panel]");

/**
 * Vim-style hand-off between the file list and the tag editor in the side panel. `L` in the list
 * focuses the panel; there `j`/`k` pick a field, `i`/Enter edit it, Esc leaves the field, and
 * `h`/Esc go back to the list. `enabled` is true while the panel shows the tag editor.
 */
export function useTagPanelNav({
	root,
	hasTarget,
	activePane,
	open,
	enabled,
}: {
	root: React.RefObject<HTMLElement | null>;
	hasTarget: boolean;
	activePane: number;
	open: () => void;
	enabled: boolean;
}) {
	/** Field last focused, so `j`/`k` continue from there. */
	const last = useRef<HTMLElement | null>(null);

	const focusTags = useCallback(() => {
		if (hasTarget) {
			open();
			// The panel may only just have opened: wait for it to render.
			requestAnimationFrame(() => requestAnimationFrame(() => getPanel()?.focus()));
		}
	}, [hasTarget, open]);

	useEffect(() => {
		if (!enabled) {
			return;
		}
		const focusFiles = () =>
			root.current?.querySelectorAll<HTMLElement>("[data-file-pane]")[activePane]?.focus();
		// Capture phase, so Escape here does not also close the panel.
		const onKeyDown = (ev: globalThis.KeyboardEvent) => {
			const panel = getPanel();
			const t = ev.target;
			if (!panel || !(t instanceof Node) || !panel.contains(t)) {
				return;
			}
			if (isField(t)) {
				leaveField(ev, t, panel, last);
			} else if (t === panel) {
				runPanelKey(ev, panel, last, focusFiles);
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [enabled, root, activePane]);

	return { focusTags };
}
