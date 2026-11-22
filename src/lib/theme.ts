import { z } from "zod";

/** What the person picked in Settings: a fixed look, or whatever the OS is set to. */
const themeChoiceSchema = z.enum(["system", "light", "dark"]);
export type ThemeChoice = z.infer<typeof themeChoiceSchema>;

/** The look actually on screen once "system" is settled. */
export type ResolvedTheme = "light" | "dark";

export const THEME_CHOICES: readonly ThemeChoice[] = themeChoiceSchema.options;
export const DEFAULT_THEME_CHOICE: ThemeChoice = "system";
export const THEME_STORAGE_KEY = "manplay.theme";

/**
 * The window's colour before the stylesheet has loaded (each theme's canvas), so a launch does
 * not flash the other theme.
 */
const CANVAS_COLOUR: Record<ResolvedTheme, string> = { dark: "#0b0d10", light: "#eceef1" };

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The choice kept in storage, or the default when nothing valid is kept. */
export function parseThemeChoice(raw: unknown): ThemeChoice {
	const parsed = themeChoiceSchema.safeParse(raw);
	return parsed.success ? parsed.data : DEFAULT_THEME_CHOICE;
}

export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
	if (choice === "system") return systemPrefersDark ? "dark" : "light";
	return choice;
}

export function loadThemeChoice(): ThemeChoice {
	try {
		return parseThemeChoice(localStorage.getItem(THEME_STORAGE_KEY));
	} catch {
		return DEFAULT_THEME_CHOICE;
	}
}

export function saveThemeChoice(choice: ThemeChoice) {
	try {
		localStorage.setItem(THEME_STORAGE_KEY, choice);
	} catch {
		// Not remembered; the choice still applies until the app closes.
	}
}

export function isSystemDark(): boolean {
	return window.matchMedia(DARK_QUERY).matches;
}

/** Calls `onChange` whenever the OS switches between light and dark. */
export function watchSystemTheme(onChange: () => void): () => void {
	const query = window.matchMedia(DARK_QUERY);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

export function applyTheme(resolved: ResolvedTheme) {
	const root = document.documentElement;
	root.classList.toggle("dark", resolved === "dark");
	root.style.colorScheme = resolved;
	root.style.backgroundColor = CANVAS_COLOUR[resolved];
}

/**
 * The same as {@link loadThemeChoice} plus {@link applyTheme}, as a script for the page's head:
 * it runs before the first paint, where a React effect would run after it.
 */
export function themeBootScript(): string {
	const choices = JSON.stringify(THEME_CHOICES);
	const key = JSON.stringify(THEME_STORAGE_KEY);
	const colours = JSON.stringify(CANVAS_COLOUR);
	const fallback = JSON.stringify(DEFAULT_THEME_CHOICE);
	return `(function(){var c=${fallback};try{var s=localStorage.getItem(${key});if(${choices}.indexOf(s)>=0)c=s}catch(e){}var t=c==="system"?(matchMedia(${JSON.stringify(DARK_QUERY)}).matches?"dark":"light"):c;var r=document.documentElement;r.classList.toggle("dark",t==="dark");r.style.colorScheme=t;r.style.backgroundColor=${colours}[t]})()`;
}
