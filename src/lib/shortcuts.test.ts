import { describe, expect, it } from "vitest";
import {
	actionFor,
	assign,
	type Chord,
	chordLabel,
	chordOf,
	conflictsWith,
	isCustom,
	type KeyPress,
	parseChord,
	parseOverrides,
	reservedFor,
	resetOne,
	resolveBindings,
	SHORTCUTS,
	unbind,
} from "#/lib/shortcuts.ts";

const press = (code: string, more: Partial<KeyPress> = {}): KeyPress => ({
	code,
	shiftKey: false,
	altKey: false,
	metaKey: false,
	ctrlKey: false,
	...more,
});

const chord = (text: string): Chord => {
	const parsed = parseChord(text);
	if (parsed === null) {
		throw new Error(text);
	}
	return parsed;
};

const defaults = resolveBindings({});

describe("chordOf", () => {
	it.each([
		{ code: "KeyK", more: {}, chord: "KeyK" },
		{ code: "KeyK", more: { metaKey: true }, chord: "mod+KeyK" },
		{ code: "KeyK", more: { ctrlKey: true }, chord: "mod+KeyK" },
		{ code: "KeyK", more: { shiftKey: true, metaKey: true }, chord: "mod+shift+KeyK" },
		{ code: "ArrowLeft", more: { altKey: true }, chord: "alt+ArrowLeft" },
		{ code: "Digit1", more: { shiftKey: true }, chord: "shift+Digit1" },
		{ code: "Space", more: {}, chord: "Space" },
	])("reads $code with $more as $chord", ({ code, more, chord: expected }) => {
		expect(chordOf(press(code, more))).toBe(expected);
	});

	it.each([
		"ShiftLeft",
		"MetaRight",
		"ControlLeft",
		"AltLeft",
		"CapsLock",
		"MediaPlayPause",
		"",
	])("ignores %s", (code) => {
		expect(chordOf(press(code))).toBeNull();
	});

	it("leaves ⌥ out when asked", () => {
		expect(chordOf(press("ArrowLeft", { altKey: true }), { ignoreAlt: true })).toBe("ArrowLeft");
	});
});

describe("parseChord", () => {
	it.each([
		"KeyK",
		"mod+KeyK",
		"mod+alt+shift+KeyK",
		"shift+Digit1",
		"Space",
		"F12",
		"BracketLeft",
	])("accepts %s", (text) => {
		expect(parseChord(text)).toBe(text);
	});

	it.each([
		["an empty string", ""],
		["an unknown key", "KeyKK"],
		["an unknown modifier", "ctrl+KeyK"],
		["a modifier twice", "shift+shift+KeyK"],
		["modifiers out of order", "shift+mod+KeyK"],
		["a modifier alone", "mod+"],
		["a printed character", "k"],
	])("refuses %s", (_, text) => {
		expect(parseChord(text)).toBeNull();
	});
});

describe("chordLabel", () => {
	it.each([
		{ chord: "mod+shift+KeyK", mac: "⇧⌘K", windows: "Ctrl+Shift+K" },
		{ chord: "alt+ArrowLeft", mac: "⌥←", windows: "Alt+←" },
		{ chord: "shift+Comma", mac: "⇧,", windows: "Shift+," },
		{ chord: "Digit1", mac: "1", windows: "1" },
		{ chord: "Space", mac: "Space", windows: "Space" },
		{ chord: "mod+Backslash", mac: "⌘\\", windows: "Ctrl+\\" },
	])("writes $chord", ({ chord: text, mac, windows }) => {
		expect(chordLabel(chord(text), true)).toBe(mac);
		expect(chordLabel(chord(text), false)).toBe(windows);
	});
});

describe("defaults", () => {
	it("never give one key to two actions that can hear it", () => {
		const clashes = SHORTCUTS.flatMap((s) =>
			s.defaults.flatMap((k) =>
				conflictsWith(defaults, s.id, k).map((other) => `${s.id}/${other}: ${k}`),
			),
		);
		expect(clashes).toEqual([]);
	});

	it("do not use keys the system keeps", () => {
		const taken = SHORTCUTS.flatMap((s) => s.defaults.filter((k) => reservedFor(k, s.id) !== null));
		expect(taken).toEqual([]);
	});
});

describe("actionFor", () => {
	it.each([
		{ code: "Space", more: {}, scope: "app", id: "play", alt: false },
		{ code: "KeyK", more: { metaKey: true }, scope: "app", id: "palette", alt: false },
		{ code: "KeyK", more: {}, scope: "deck", id: "metronome", alt: false },
		{ code: "Comma", more: { shiftKey: true }, scope: "deck", id: "barBack", alt: false },
		{ code: "Equal", more: { shiftKey: true }, scope: "deck", id: "zoomIn", alt: false },
		{ code: "Digit3", more: {}, scope: "deck", id: "pad3", alt: false },
		{ code: "Digit3", more: { shiftKey: true }, scope: "deck", id: "clearPad3", alt: false },
		{ code: "ArrowLeft", more: {}, scope: "deck", id: "nudgeEarlier", alt: false },
		{ code: "ArrowLeft", more: { altKey: true }, scope: "deck", id: "nudgeEarlier", alt: true },
		{ code: "ArrowUp", more: { altKey: true }, scope: "deck", id: "bpmUp", alt: true },
		{ code: "ArrowLeft", more: { shiftKey: true }, scope: "deck", id: "barEarlier", alt: false },
		{ code: "KeyZ", more: { metaKey: true }, scope: "app", id: "undo", alt: false },
		{ code: "KeyZ", more: { ctrlKey: true }, scope: "app", id: "undo", alt: false },
		{ code: "KeyZ", more: { metaKey: true, shiftKey: true }, scope: "app", id: "redo", alt: false },
		{ code: "KeyY", more: { ctrlKey: true }, scope: "app", id: "redo", alt: false },
		{ code: "KeyS", more: { metaKey: true }, scope: "app", id: "save", alt: false },
		{ code: "KeyJ", more: {}, scope: "files", id: "fileNext", alt: false },
		{ code: "KeyL", more: { shiftKey: true }, scope: "files", id: "fileTags", alt: false },
		{ code: "Backspace", more: { metaKey: true }, scope: "files", id: "fileDelete", alt: false },
		{ code: "Escape", more: {}, scope: "files", id: "fileClear", alt: false },
	] as const)("reads $code $more in $scope as $id", ({ code, more, scope, id, alt }) => {
		expect(actionFor(defaults, press(code, more), scope)).toEqual({ id, alt });
	});

	it.each([
		{ why: "a deck key in the app scope", code: "KeyK", more: {}, scope: "app" },
		{ why: "⌘ with a deck letter", code: "KeyK", more: { metaKey: true }, scope: "deck" },
		{ why: "⌥ where it is not a finer step", code: "KeyD", more: { altKey: true }, scope: "deck" },
		{ why: "a pad past H", code: "Digit9", more: {}, scope: "deck" },
	] as const)("finds nothing for $why", ({ code, more, scope }) => {
		expect(actionFor(defaults, press(code, more), scope)).toBeNull();
	});

	it("follows a key chosen in place of the default", () => {
		const moved = resolveBindings({ metronome: [chord("KeyM")] });
		expect(actionFor(moved, press("KeyM"), "deck")?.id).toBe("metronome");
		expect(actionFor(moved, press("KeyK"), "deck")).toBeNull();
	});
});

describe("editing keys", () => {
	it("names the action a key is taken by", () => {
		expect(conflictsWith(defaults, "tap", chord("KeyK"))).toEqual(["metronome"]);
		expect(conflictsWith(defaults, "metronome", chord("KeyK"))).toEqual([]);
	});

	it("takes the key from the action that had it", () => {
		const next = resolveBindings(assign({}, "tap", chord("KeyK"), chord("KeyT")));
		expect(next.get("tap")).toEqual(["KeyK"]);
		expect(next.get("metronome")).toEqual([]);
	});

	it("adds a second key when replacing nothing", () => {
		const next = resolveBindings(assign({}, "tap", chord("KeyY"), null));
		expect(next.get("tap")).toEqual(["KeyT", "KeyY"]);
	});

	it("removes one key, and resets to the defaults", () => {
		const removed = unbind({}, "zoomIn", chord("shift+Equal"));
		expect(resolveBindings(removed).get("zoomIn")).toEqual(["Equal"]);
		expect(isCustom(resolveBindings(removed), "zoomIn")).toBe(true);
		const reset = resetOne(removed, "zoomIn");
		expect(isCustom(resolveBindings(reset), "zoomIn")).toBe(false);
	});

	it.each([
		{ text: "mod+KeyC", id: "tap", what: "Copy" },
		{ text: "mod+KeyC", id: "palette", what: "Copy" },
		{ text: "mod+KeyC", id: "fileCut", what: null },
		{ text: "mod+KeyQ", id: "fileCut", what: "Quit" },
		{ text: "Tab", id: "play", what: "Moving between controls" },
		{ text: "mod+KeyZ", id: "tap", what: null },
	] as const)("warns that $text for $id is $what", ({ text, id, what }) => {
		expect(reservedFor(chord(text), id)).toBe(what);
	});

	it.each([
		{ why: "file and grid keys, never heard together", id: "metronome", key: "KeyJ", others: [] },
		{ why: "file keys and Space for play", id: "filePlay", key: "Space", others: [] },
		{
			why: "file keys and keys that work anywhere",
			id: "fileNext",
			key: "mod+KeyK",
			others: ["palette"],
		},
		{ why: "app and grid keys", id: "play", key: "KeyK", others: ["metronome"] },
		{ why: "two file keys", id: "fileCut", key: "KeyY", others: ["fileCopy"] },
	] as const)("finds clashes between $why", ({ id, key, others }) => {
		expect(conflictsWith(defaults, id, chord(key))).toEqual(others);
	});
});

describe("parseOverrides", () => {
	it("reads keys saved on this computer", () => {
		expect(parseOverrides('{"tap":["KeyY"],"metronome":[]}')).toEqual({
			tap: ["KeyY"],
			metronome: [],
		});
	});

	it.each([
		["nothing saved", null],
		["broken JSON", "{"],
		["a list", '["KeyY"]'],
		["a number", "3"],
		["keys that are not lists", '{"tap":"KeyY"}'],
	])("reads %s as no changes", (_, json) => {
		expect(parseOverrides(json)).toEqual({});
	});

	it.each([
		["an action this version lacks", '{"tap":["KeyY"],"teleport":["KeyQ"]}'],
		["an action with an unreadable key", '{"tap":["KeyY"],"snap":["nope"]}'],
	])("keeps the rest when it meets %s", (_, json) => {
		expect(parseOverrides(json)).toEqual({ tap: ["KeyY"] });
	});

	it("drops a key listed twice", () => {
		expect(parseOverrides('{"tap":["KeyY","KeyY"]}')).toEqual({ tap: ["KeyY"] });
	});
});
