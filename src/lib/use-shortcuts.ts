import { useEffect, useRef, useSyncExternalStore } from "react";
import { keyTakenElsewhere } from "#/lib/keyboard.ts";
import { isMac } from "#/lib/platform.ts";
import {
	actionFor,
	type Bindings,
	chordLabel,
	type Overrides,
	parseOverrides,
	resolveBindings,
	type ShortcutId,
	type ShortcutScope,
} from "#/lib/shortcuts.ts";

/** Kept on this computer only: keys suit the keyboard in front of you, not the library. */
const KEY = "manplay.shortcuts";

function load(): Overrides {
	try {
		return parseOverrides(localStorage.getItem(KEY));
	} catch {
		return {};
	}
}

let overrides = load();
let bindings = resolveBindings(overrides);
const listeners = new Set<() => void>();
/** While Settings records a key, no shortcut runs. */
let recording = false;

export function setRecording(on: boolean) {
	recording = on;
}

export function getOverrides(): Overrides {
	return overrides;
}

export function setOverrides(next: Overrides) {
	overrides = next;
	bindings = resolveBindings(next);
	try {
		if (Object.keys(next).length === 0) {
			localStorage.removeItem(KEY);
		} else {
			localStorage.setItem(KEY, JSON.stringify(next));
		}
	} catch {
		// Not remembered; the keys still apply until the app closes.
	}
	for (const listener of listeners) {
		listener();
	}
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
const defaults = resolveBindings({});

/** Every action's keys now. */
export function useBindings(): Bindings {
	return useSyncExternalStore(
		subscribe,
		() => bindings,
		() => defaults,
	);
}

/** Which action of `scope` a key press means, with the current keys, or null. */
export function shortcutFor(
	e: KeyboardEvent,
	scope: ShortcutScope,
): { id: ShortcutId; alt: boolean } | null {
	return recording ? null : actionFor(bindings, e, scope);
}

/** Whether a key press is `id`'s shortcut. */
export function isShortcut(
	e: KeyboardEvent,
	id: ShortcutId,
	scope: ShortcutScope = "app",
): boolean {
	return shortcutFor(e, scope)?.id === id;
}

/** An action's first key as this platform writes it (`⌘K`, `Ctrl+K`), or null when unbound. */
export function useShortcutLabel(id: ShortcutId): string | null {
	const first = useBindings().get(id)?.[0];
	const mac = useMacLabels();
	return first === undefined ? null : chordLabel(first, mac);
}

const neverChanges = () => () => undefined;

/**
 * Whether to write keys the Mac way. Markup made ahead of time uses Mac wording, so this starts
 * there and switches to this platform's once the page is live (as `useKeyLabel` does).
 */
export function useMacLabels(): boolean {
	return useSyncExternalStore(
		neverChanges,
		() => isMac,
		() => true,
	);
}

/** " (K)" for a key, "" without one: to end a sentence in a tooltip. */
export const keyHint = (label: string | null): string => (label === null ? "" : ` (${label})`);

/** `text` with the action's key in brackets after it, for a tooltip: "Tap the tempo (T)". */
export function useShortcutHint(id: ShortcutId, text: string): string {
	return `${text}${keyHint(useShortcutLabel(id))}`;
}

/**
 * Runs `run` when `id`'s key is pressed anywhere, unless the key is taken there (typing, a dialog,
 * a focused list); `anywhere` also fires while typing, for ⌘ shortcuts like the search palette.
 */
export function useShortcut(id: ShortcutId, run: () => void, { anywhere = false } = {}) {
	const latest = useRef(run);
	latest.current = run;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!isShortcut(e, id) || e.defaultPrevented) {
				return;
			}
			if (!anywhere && keyTakenElsewhere(e)) {
				return;
			}
			e.preventDefault();
			latest.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [id, anywhere]);
}
