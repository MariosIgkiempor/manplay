import { describe, expect, it } from "vitest";
import {
	canRun,
	menuOrigin,
	type TextFieldCommand,
	type TextFieldState,
} from "./text-field-menu.ts";

const field = (changes: Partial<TextFieldState> = {}): TextFieldState => ({
	length: 5,
	selection: "ell",
	locked: false,
	concealed: false,
	...changes,
});

describe("canRun", () => {
	const cases: [
		what: string,
		command: TextFieldCommand,
		state: TextFieldState,
		allowed: boolean,
	][] = [
		["cut a selection", "cut", field(), true],
		["cut with nothing selected", "cut", field({ selection: "" }), false],
		["cut from a read-only field", "cut", field({ locked: true }), false],
		["cut from a password", "cut", field({ concealed: true }), false],
		["copy a selection", "copy", field(), true],
		["copy from a read-only field", "copy", field({ locked: true }), true],
		["copy with nothing selected", "copy", field({ selection: "" }), false],
		["copy from a password", "copy", field({ concealed: true }), false],
		["paste into a field", "paste", field({ selection: "", length: 0 }), true],
		["paste into a password", "paste", field({ concealed: true }), true],
		["paste into a read-only field", "paste", field({ locked: true }), false],
		["select all of some text", "selectAll", field(), true],
		["select all of nothing", "selectAll", field({ length: 0, selection: "" }), false],
	];
	it.each(cases)("%s", (_what, command, state, allowed) => {
		expect(canRun(command, state)).toBe(allowed);
	});
});

describe("menuOrigin", () => {
	const menu = { width: 160, height: 120 };
	const viewport = { width: 1000, height: 600 };
	it.each([
		["opens at the pointer", { x: 300, y: 200 }, { left: 300, top: 200 }],
		["stays inside the right edge", { x: 990, y: 200 }, { left: 832, top: 200 }],
		["stays inside the bottom edge", { x: 300, y: 590 }, { left: 300, top: 472 }],
		["stays inside the top left corner", { x: 0, y: 0 }, { left: 8, top: 8 }],
	])("%s", (_what, point, origin) => {
		expect(menuOrigin(point, menu, viewport)).toEqual(origin);
	});
});
