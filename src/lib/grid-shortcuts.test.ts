import { describe, expect, it } from "vitest";
import { type GridAction, gridAction, type KeyPress } from "#/lib/grid-shortcuts.ts";

const press = (key: string, more: Partial<KeyPress> = {}): GridAction | null =>
	gridAction({
		key,
		code: "",
		shiftKey: false,
		altKey: false,
		metaKey: false,
		ctrlKey: false,
		...more,
	});

describe("gridAction", () => {
	it("reads letters, arrows and punctuation", () => {
		expect(press("d")).toBe("downbeat");
		expect(press("D", { shiftKey: true })).toBeNull();
		expect(press("ArrowLeft")).toBe("nudgeEarlier");
		expect(press("ArrowLeft", { shiftKey: true })).toBe("barEarlier");
		expect(press("ArrowRight", { altKey: true })).toBe("nudgeLater");
		expect(press("<", { shiftKey: true })).toBe("barBack");
		expect(press("?", { shiftKey: true })).toBe("help");
		expect(press(" ")).toBe("play");
		expect(press("=")).toBe("zoomIn");
		expect(press("+", { shiftKey: true })).toBe("zoomIn");
		expect(press("-")).toBe("zoomOut");
		expect(press("0", { code: "Digit0" })).toBe("zoomReset");
	});

	it("reads number keys by position, with ⇧ clearing", () => {
		expect(press("1", { code: "Digit1" })).toBe("pad1");
		expect(press("!", { code: "Digit1", shiftKey: true })).toBe("clearPad1");
		expect(press("9", { code: "Digit9" })).toBeNull();
	});

	it.each([
		{ keys: "⌘S", key: "s", more: { metaKey: true }, action: "save" },
		{ keys: "⌘Z", key: "z", more: { metaKey: true }, action: "undo" },
		{ keys: "Ctrl+Z", key: "z", more: { ctrlKey: true }, action: "undo" },
		{ keys: "⇧⌘Z", key: "Z", more: { metaKey: true, shiftKey: true }, action: "redo" },
		{ keys: "Ctrl+Y", key: "y", more: { ctrlKey: true }, action: "redo" },
		{ keys: "⌘Y", key: "y", more: { metaKey: true }, action: null },
		{ keys: "⌘A", key: "a", more: { metaKey: true }, action: null },
		{ keys: "⇧⌘S", key: "S", more: { metaKey: true, shiftKey: true }, action: null },
	])("reads $keys as $action", ({ key, more, action }) => {
		expect(press(key, more)).toBe(action);
	});

	it.each([
		{ key: "t", action: "tap" },
		{ key: "r", action: "roundBpm" },
		{ key: "k", action: "metronome" },
	])("reads $key as $action", ({ key, action }) => {
		expect(press(key)).toBe(action);
	});
});
