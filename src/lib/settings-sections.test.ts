import { describe, expect, it } from "vitest";
import { parseSettingsSection } from "#/lib/settings-sections.ts";

describe("parseSettingsSection", () => {
	it.each([
		["library", "library"],
		["lookup", "lookup"],
		["appearance", "appearance"],
		["shortcuts", "shortcuts"],
		["about", "about"],
	] as const)("accepts %s", (value, expected) => {
		expect(parseSettingsSection(value)).toBe(expected);
	});

	it.each([
		["an unknown tab", "keyboard"],
		["another case", "Shortcuts"],
		["an empty string", ""],
		["a number", 1],
		["nothing", undefined],
		["null", null],
		["an array", ["library"]],
	])("refuses %s", (_, value) => {
		expect(parseSettingsSection(value)).toBeNull();
	});
});
