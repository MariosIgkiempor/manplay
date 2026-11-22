import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clipboardReadText } from "#/lib/api.ts";
import { menuItem, popup } from "#/lib/menu-styles.ts";
import { keyLabel } from "#/lib/platform.ts";
import {
	canRun,
	menuOrigin,
	TEXT_FIELD_COMMANDS,
	type TextFieldCommand,
	type TextFieldState,
} from "#/lib/text-field-menu.ts";
import { cn } from "#/lib/utils.ts";

type TextField = HTMLInputElement | HTMLTextAreaElement;

interface OpenMenu {
	field: TextField;
	point: { x: number; y: number };
}

function textFieldOf(target: EventTarget | null): TextField | null {
	return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
		? target
		: null;
}

function stateOf(field: TextField): TextFieldState {
	// Some kinds of input (number, email) do not say what is selected.
	const start = field.selectionStart ?? 0;
	const end = field.selectionEnd ?? 0;
	return {
		length: field.value.length,
		selection: field.value.slice(start, end),
		locked: field.readOnly || field.disabled,
		concealed: field instanceof HTMLInputElement && field.type === "password",
	};
}

/**
 * Types `text` over the selection the way the keyboard would, so the field's own undo and its
 * change handlers see it. `execCommand` is the only way a page can do that.
 */
function typeOver(field: TextField, text: string) {
	field.focus();
	document.execCommand(text === "" ? "delete" : "insertText", false, text);
}

async function paste(field: TextField) {
	const text = await clipboardReadText();
	// A one-line field takes one line, as it does when pasted into from the keyboard.
	typeOver(field, field instanceof HTMLInputElement ? text.replace(/[\r\n]+/g, " ") : text);
}

const RUN: Record<TextFieldCommand, (field: TextField) => Promise<void>> = {
	copy: (field) => navigator.clipboard.writeText(stateOf(field).selection),
	cut: async (field) => {
		await navigator.clipboard.writeText(stateOf(field).selection);
		typeOver(field, "");
	},
	paste,
	selectAll: (field) => {
		field.focus();
		field.select();
		return Promise.resolve();
	},
};

/**
 * The app's right-click menu everywhere it has no menu of its own: Cut, Copy, Paste and Select
 * all in a text field, and nothing anywhere else, in place of the webview's menu (Reload,
 * Inspect, Look Up). Mounted once, in the shell.
 */
export function TextFieldMenu() {
	const [open, setOpen] = useState<OpenMenu | null>(null);

	useEffect(() => {
		const onContextMenu = (e: MouseEvent) => {
			// One of the app's own menus has already claimed the click by the time it gets here.
			if (e.defaultPrevented) {
				return;
			}
			e.preventDefault();
			const field = textFieldOf(e.target);
			setOpen(field && { field, point: { x: e.clientX, y: e.clientY } });
		};
		document.addEventListener("contextmenu", onContextMenu);
		return () => document.removeEventListener("contextmenu", onContextMenu);
	}, []);

	return open && <Popup open={open} onClose={() => setOpen(null)} />;
}

function Popup({ open, onClose }: { open: OpenMenu; onClose: () => void }) {
	const menu = useRef<HTMLDivElement>(null);
	const [origin, setOrigin] = useState<{ left: number; top: number } | null>(null);
	const [active, setActive] = useState(-1);
	const state = stateOf(open.field);
	const usable = TEXT_FIELD_COMMANDS.map(({ command }) => canRun(command, state));

	useLayoutEffect(() => {
		const own = menu.current;
		if (own) {
			setOrigin(
				menuOrigin(
					open.point,
					{ width: own.offsetWidth, height: own.offsetHeight },
					{ width: window.innerWidth, height: window.innerHeight },
				),
			);
		}
	}, [open.point]);

	const choose = (index: number) => {
		const entry = TEXT_FIELD_COMMANDS[index];
		onClose();
		if (entry && usable[index]) {
			void RUN[entry.command](open.field);
		}
	};
	const keys = useRef({ active, choose, usable, onClose });
	keys.current = { active, choose, usable, onClose };
	useEffect(() => {
		// Focus stays in the field so its selection survives; the menu takes the keys from here.
		const step = (by: number) => {
			const { active: from, usable: can } = keys.current;
			for (let moved = 1; moved <= can.length; moved += 1) {
				const next = (from + by * moved + can.length * moved) % can.length;
				if (can[next]) {
					setActive(next);
					return;
				}
			}
		};
		const keyActions = new Map<string, () => void>([
			["Escape", () => keys.current.onClose()],
			["ArrowDown", () => step(1)],
			["ArrowUp", () => step(-1)],
			["Enter", () => keys.current.choose(keys.current.active)],
		]);
		const onKey = (e: KeyboardEvent) => {
			const action = keyActions.get(e.key);
			if (action) {
				e.preventDefault();
				e.stopPropagation();
				action();
			} else {
				keys.current.onClose();
			}
		};
		const close = () => keys.current.onClose();
		const onPointerDown = (e: PointerEvent) => {
			if (!(e.target instanceof Node && menu.current?.contains(e.target))) {
				close();
			}
		};
		window.addEventListener("keydown", onKey, true);
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("scroll", close, true);
		window.addEventListener("blur", close);
		window.addEventListener("resize", close);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("scroll", close, true);
			window.removeEventListener("blur", close);
			window.removeEventListener("resize", close);
		};
	}, []);

	return createPortal(
		<div
			ref={menu}
			role="menu"
			aria-label="Text"
			style={{ left: origin?.left ?? 0, top: origin?.top ?? 0 }}
			className={cn(popup, "fixed z-[80] min-w-40", !origin && "invisible")}
			// A press on the menu must not take focus, or the field would lose its selection.
			onMouseDown={(e) => e.preventDefault()}
		>
			{TEXT_FIELD_COMMANDS.map(({ command, label, shortcut }, index) => (
				<button
					key={command}
					type="button"
					role="menuitem"
					tabIndex={-1}
					disabled={!usable[index]}
					data-highlighted={index === active ? "" : undefined}
					className={cn(menuItem, "w-full text-left disabled:opacity-50")}
					onPointerEnter={() => setActive(usable[index] ? index : -1)}
					onPointerLeave={() => setActive(-1)}
					onClick={() => choose(index)}
				>
					{label}
					<span className="ml-auto pl-4 text-muted-foreground text-xs">{keyLabel(shortcut)}</span>
				</button>
			))}
		</div>,
		document.body,
	);
}
