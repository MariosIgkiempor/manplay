import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import {
	applyTheme,
	isSystemDark,
	loadThemeChoice,
	type ResolvedTheme,
	resolveTheme,
	saveThemeChoice,
	type ThemeChoice,
	watchSystemTheme,
} from "#/lib/theme.ts";

/*
 * One choice for the whole app, so the Settings control and the root that applies it agree
 * without a context. A per-device preference, so it lives in this webview's storage.
 */
let currentChoice: ThemeChoice | undefined;
const listeners = new Set<() => void>();

function getChoice(): ThemeChoice {
	currentChoice ??= loadThemeChoice();
	return currentChoice;
}

function subscribeChoice(onChange: () => void) {
	listeners.add(onChange);
	return () => {
		listeners.delete(onChange);
	};
}

export function setThemeChoice(choice: ThemeChoice) {
	currentChoice = choice;
	saveThemeChoice(choice);
	for (const listener of listeners) listener();
}

export function useThemeChoice(): ThemeChoice {
	return useSyncExternalStore(subscribeChoice, getChoice, () => "system" as const);
}

/** The look on screen now, for drawing that cannot follow the CSS variables by itself (canvas). */
export function useResolvedTheme(): ResolvedTheme {
	return useResolvedChoice(useThemeChoice());
}

function useResolvedChoice(choice: ThemeChoice): ResolvedTheme {
	const prefersDark = useSyncExternalStore(watchSystemTheme, isSystemDark, () => true);
	return resolveTheme(choice, prefersDark);
}

/**
 * Keeps the page and the native window (title bar, menus) on the chosen theme. Mount once, at
 * the root.
 */
export function useAppliedTheme() {
	const choice = useThemeChoice();
	const resolved = useResolvedChoice(choice);
	// A layout effect, so the new CSS variables are in place before any child's effect reads them.
	useLayoutEffect(() => applyTheme(resolved), [resolved]);
	useEffect(() => {
		if (!isTauri()) return;
		// "system" hands the window back to the OS; failing leaves only the title bar off-theme.
		getCurrentWindow()
			.setTheme(choice === "system" ? null : choice)
			.catch(() => {});
	}, [choice]);
}
