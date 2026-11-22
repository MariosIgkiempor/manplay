/** What the app's own right-click menu for a text field offers, in place of the system's. */

export type TextFieldCommand = "cut" | "copy" | "paste" | "selectAll";

export const TEXT_FIELD_COMMANDS: readonly {
	command: TextFieldCommand;
	label: string;
	shortcut: string;
}[] = [
	{ command: "cut", label: "Cut", shortcut: "⌘X" },
	{ command: "copy", label: "Copy", shortcut: "⌘C" },
	{ command: "paste", label: "Paste", shortcut: "⌘V" },
	{ command: "selectAll", label: "Select all", shortcut: "⌘A" },
];

/** A text field as the menu sees it. */
export interface TextFieldState {
	/** How many characters it holds. */
	length: number;
	/** The selected text; empty when nothing is selected or the field cannot say. */
	selection: string;
	/** It cannot be typed in (read-only or disabled). */
	locked: boolean;
	/** Its text is hidden (a password, an API key) and must not reach the clipboard. */
	concealed: boolean;
}

/** Whether a command can do anything in a field right now. */
export function canRun(command: TextFieldCommand, field: TextFieldState): boolean {
	const copyable = field.selection !== "" && !field.concealed;
	const allowed: Record<TextFieldCommand, boolean> = {
		cut: copyable && !field.locked,
		copy: copyable,
		paste: !field.locked,
		selectAll: field.length > 0,
	};
	return allowed[command];
}

/** Where to put a menu opened at a point so that all of it stays inside the window. */
export function menuOrigin(
	point: { x: number; y: number },
	menu: { width: number; height: number },
	viewport: { width: number; height: number },
	margin = 8,
): { left: number; top: number } {
	const fit = (at: number, size: number, room: number) =>
		Math.max(margin, Math.min(at, room - size - margin));
	return {
		left: fit(point.x, menu.width, viewport.width),
		top: fit(point.y, menu.height, viewport.height),
	};
}
