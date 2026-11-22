import { describe, expect, it } from "vitest";
import {
	parseThemeChoice,
	type ResolvedTheme,
	resolveTheme,
	type ThemeChoice,
} from "#/lib/theme.ts";

describe("parseThemeChoice", () => {
	it.each<{ raw: unknown; expected: ThemeChoice }>([
		{ raw: "system", expected: "system" },
		{ raw: "light", expected: "light" },
		{ raw: "dark", expected: "dark" },
		{ raw: null, expected: "system" },
		{ raw: "Dark", expected: "system" },
		{ raw: "auto", expected: "system" },
		{ raw: 1, expected: "system" },
	])("$raw", ({ raw, expected }) => {
		expect(parseThemeChoice(raw)).toBe(expected);
	});
});

describe("resolveTheme", () => {
	it.each<{ choice: ThemeChoice; systemPrefersDark: boolean; expected: ResolvedTheme }>([
		{ choice: "system", systemPrefersDark: true, expected: "dark" },
		{ choice: "system", systemPrefersDark: false, expected: "light" },
		{ choice: "light", systemPrefersDark: true, expected: "light" },
		{ choice: "dark", systemPrefersDark: false, expected: "dark" },
	])("$choice with system dark=$systemPrefersDark", ({ choice, systemPrefersDark, expected }) => {
		expect(resolveTheme(choice, systemPrefersDark)).toBe(expected);
	});
});
