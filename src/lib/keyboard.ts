/** A key press while typing (fields keep their own keys) or with a dialog open. */
export function typingKey(e: KeyboardEvent): boolean {
	const typing =
		e.target instanceof HTMLElement &&
		(["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable);
	return typing || document.querySelector("[role=dialog]") !== null;
}

/** A key press meant for something else: typing, a shortcut with ⌘ or Ctrl, or an open dialog. */
export function busyKey(e: KeyboardEvent): boolean {
	return typingKey(e) || e.metaKey || e.ctrlKey;
}

/**
 * Focused things that move with the keys themselves: the file browser, song lists, the tag panel,
 * menus, pickers and resize handles. While one has focus the app-wide keys leave it its keys.
 */
const OWNS_KEYS = [
	"[data-file-pane]",
	"[data-detail-panel]",
	"[role=listbox]",
	"[role=option]",
	"[role=tree]",
	"[role=treeitem]",
	"[role=grid]",
	"[role=menu]",
	"[role=menuitem]",
	"[role=combobox]",
	"[role=separator]",
	"[role=slider]",
].join(", ");

/**
 * Whether an app-wide shortcut should leave this key press alone: typing, a dialog, something
 * already handled it, or the focused element moves with the keys. Space and Enter also stay with
 * a focused button or link, which they press. (Which modifiers make a shortcut is the binding's
 * business, see `shortcuts.ts`.)
 */
export function keyTakenElsewhere(e: KeyboardEvent): boolean {
	if (e.defaultPrevented || typingKey(e)) {
		return true;
	}
	const target = e.target instanceof Element ? e.target : null;
	if (!target) {
		return false;
	}
	if ((e.key === " " || e.key === "Enter") && target.closest("button, a[href]") !== null) {
		return true;
	}
	return target.closest(OWNS_KEYS) !== null;
}
