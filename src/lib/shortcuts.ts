import { z } from "zod";

/**
 * One key combination, written the same way everywhere: the modifiers held (`mod` is ⌘ on a Mac
 * and Ctrl on Windows, either is accepted on both) then the physical key as the browser names it
 * (`KeyK`, `Digit1`, `ArrowLeft`), e.g. `mod+shift+KeyK`. Keys are read by place on the keyboard,
 * so a binding stays put whatever the key prints.
 */
export type Chord = string & { readonly __brand: "Chord" };

/** What a key press says about itself; the fields of a DOM `KeyboardEvent` that matter here. */
export interface KeyPress {
	code: string;
	shiftKey: boolean;
	altKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
}

const MODIFIERS = ["mod", "alt", "shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

/** Keys pressed on their own say nothing: they are only held for another key. */
const MODIFIER_CODES = new Set([
	"MetaLeft",
	"MetaRight",
	"ControlLeft",
	"ControlRight",
	"AltLeft",
	"AltRight",
	"ShiftLeft",
	"ShiftRight",
	"CapsLock",
	"Fn",
	"FnLock",
]);

/** Keys a binding can use: letters, digits, punctuation, arrows and the named keys. */
const CODE =
	/^(Key[A-Z]|Digit\d|Numpad\w+|F\d{1,2}|Arrow(Left|Right|Up|Down)|Space|Enter|Escape|Backspace|Delete|Tab|Home|End|PageUp|PageDown|Comma|Period|Slash|Backslash|BracketLeft|BracketRight|Semicolon|Quote|Backquote|Equal|Minus|IntlBackslash)$/;

function makeChord(modifiers: ReadonlySet<Modifier>, code: string): Chord {
	return [...MODIFIERS.filter((m) => modifiers.has(m)), code].join("+") as Chord;
}

/** The chord a key press makes, or null for a modifier on its own or a key that cannot be bound. */
export function chordOf(e: KeyPress, { ignoreAlt = false } = {}): Chord | null {
	if (MODIFIER_CODES.has(e.code) || !CODE.test(e.code)) {
		return null;
	}
	const held = new Set<Modifier>();
	if (e.metaKey || e.ctrlKey) {
		held.add("mod");
	}
	if (e.altKey && !ignoreAlt) {
		held.add("alt");
	}
	if (e.shiftKey) {
		held.add("shift");
	}
	return makeChord(held, e.code);
}

/** A chord read back from storage, or null when it is not one. */
export function parseChord(text: string): Chord | null {
	const parts = text.split("+");
	const code = parts.pop() ?? "";
	const modifiers = new Set<Modifier>();
	for (const part of parts) {
		const modifier = MODIFIERS.find((m) => m === part);
		if (!modifier || modifiers.has(modifier)) {
			return null;
		}
		modifiers.add(modifier);
	}
	if (!CODE.test(code)) {
		return null;
	}
	const chord = makeChord(modifiers, code);
	// One spelling per chord, so two bindings of the same keys compare equal.
	return chord === text ? chord : null;
}

const KEY_NAMES: Record<string, string> = {
	Space: "Space",
	Enter: "↵",
	Escape: "Esc",
	Backspace: "⌫",
	Delete: "Del",
	Tab: "Tab",
	ArrowLeft: "←",
	ArrowRight: "→",
	ArrowUp: "↑",
	ArrowDown: "↓",
	Comma: ",",
	Period: ".",
	Slash: "/",
	Backslash: "\\",
	BracketLeft: "[",
	BracketRight: "]",
	Semicolon: ";",
	Quote: "'",
	Backquote: "`",
	Equal: "=",
	Minus: "-",
	IntlBackslash: "§",
	PageUp: "Page Up",
	PageDown: "Page Down",
};

/** A key's name on a US keyboard: `KeyK` → `K`, `Digit1` → `1`, `Comma` → `,`. */
function keyName(code: string): string {
	return KEY_NAMES[code] ?? code.replace(/^(Key|Digit)/, "").replace(/^Numpad/, "Num ");
}

/** Modifier keys held, as booleans; what a recorder shows while keys are down. */
export interface Held {
	mod: boolean;
	alt: boolean;
	shift: boolean;
}

/** The held modifiers as keycaps, in the platform's order: `⌥ ⇧ ⌘` on a Mac, `Ctrl Shift Alt`. */
export function modifierCaps(held: Held, mac: boolean): string[] {
	const caps = mac
		? [held.alt && "⌥", held.shift && "⇧", held.mod && "⌘"]
		: [held.mod && "Ctrl", held.shift && "Shift", held.alt && "Alt"];
	return caps.filter((cap): cap is string => cap !== false);
}

/** A chord as keycaps: `["⇧", "⌘", "K"]` on a Mac, `["Ctrl", "Shift", "K"]` on Windows. */
export function chordParts(chord: Chord, mac: boolean): string[] {
	const parts = chord.split("+");
	const key = keyName(parts.pop() ?? "");
	const held = new Set(parts);
	return [
		...modifierCaps({ mod: held.has("mod"), alt: held.has("alt"), shift: held.has("shift") }, mac),
		key,
	];
}

/** How a chord reads: `⇧⌘K` on a Mac, `Ctrl+Shift+K` on Windows. */
export function chordLabel(chord: Chord, mac: boolean): string {
	return chordParts(chord, mac).join(mac ? "" : "+");
}

/**
 * Where a shortcut works: `app` on every page; `deck` while the waveform above the player is
 * shown; `files` while the file browser has focus. App and deck keys listen at once, so they share
 * one set of keys; the file browser keeps its keys while focused, sharing them only with the app
 * keys that work even there (`anywhere`).
 */
export type ShortcutScope = "app" | "deck" | "files";

const PADS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const PAD_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
type Pad = (typeof PADS)[number];

/** Every action a key can be bound to. */
export type ShortcutId =
	| "undo"
	| "redo"
	| "save"
	| "play"
	| "palette"
	| "pageSearch"
	| "sidebar"
	| "prevSong"
	| "nextSong"
	| "beatBack"
	| "beatOn"
	| "barBack"
	| "barOn"
	| "zoomIn"
	| "zoomOut"
	| "zoomReset"
	| "zoom"
	| "downbeat"
	| "nudgeEarlier"
	| "nudgeLater"
	| "barEarlier"
	| "barLater"
	| "bpmUp"
	| "bpmDown"
	| "tap"
	| "roundBpm"
	| "metronome"
	| "start"
	| "snap"
	| "help"
	| `pad${Pad}`
	| `clearPad${Pad}`
	| FileShortcutId;

/** The file browser's actions. */
export type FileShortcutId =
	| "fileNext"
	| "filePrev"
	| "fileOpenFolder"
	| "fileCloseFolder"
	| "fileOpen"
	| "fileGoInto"
	| "fileUp"
	| "fileFirst"
	| "fileLast"
	| "fileFilter"
	| "fileMatchNext"
	| "fileMatchPrev"
	| "filePlay"
	| "fileNewFolder"
	| "fileRename"
	| "fileCut"
	| "fileCopy"
	| "filePaste"
	| "fileDelete"
	| "fileSelectAll"
	| "fileClear"
	| "fileNextIssue"
	| "filePrevIssue"
	| "fileIssue"
	| "fileFix"
	| "fileTags"
	| "fileHelp";

export interface ShortcutDef {
	id: ShortcutId;
	label: string;
	group: string;
	scope: ShortcutScope;
	defaults: readonly Chord[];
	/** Held with ⌥ the action takes a finer step, so ⌥ is not part of its keys. */
	fineWithAlt?: true;
	/** Works even while typing in a field or with a list focused, like ⌘K. */
	anywhere?: true;
}

const c = (text: string): Chord => {
	const chord = parseChord(text);
	if (chord === null) {
		throw new Error(`Not a chord: ${text}`);
	}
	return chord;
};

const define = (
	id: ShortcutId,
	group: string,
	scope: ShortcutScope,
	label: string,
	defaults: readonly string[],
	extra: Pick<ShortcutDef, "fineWithAlt" | "anywhere"> = {},
): ShortcutDef => ({ id, group, scope, label, defaults: defaults.map(c), ...extra });

const FINE = { fineWithAlt: true } as const;
const ANYWHERE = { anywhere: true } as const;

/** Every bindable shortcut with its keys out of the box, in the order Settings lists them. */
export const SHORTCUTS: readonly ShortcutDef[] = [
	define("play", "Anywhere", "app", "Play / pause", ["Space"]),
	define("palette", "Anywhere", "app", "Search everything", ["mod+KeyK"], ANYWHERE),
	define("pageSearch", "Anywhere", "app", "Search this page", ["mod+KeyF"], ANYWHERE),
	define("sidebar", "Anywhere", "app", "Fold the sidebar", ["mod+Backslash"], ANYWHERE),
	define("undo", "Anywhere", "app", "Undo", ["mod+KeyZ"], ANYWHERE),
	define("redo", "Anywhere", "app", "Redo", ["mod+shift+KeyZ", "mod+KeyY"], ANYWHERE),
	define("save", "Anywhere", "app", "Save edits now", ["mod+KeyS"], ANYWHERE),
	define("prevSong", "Anywhere", "app", "Previous song in the side panel", ["BracketLeft"]),
	define("nextSong", "Anywhere", "app", "Next song in the side panel", ["BracketRight"]),

	define("beatBack", "Move", "deck", "Back one beat", ["Comma"]),
	define("beatOn", "Move", "deck", "On one beat", ["Period"]),
	define("barBack", "Move", "deck", "Back one bar", ["shift+Comma"]),
	define("barOn", "Move", "deck", "On one bar", ["shift+Period"]),
	define("zoomIn", "Move", "deck", "Zoom the waveform in", ["Equal", "shift+Equal"]),
	define("zoomOut", "Move", "deck", "Zoom the waveform out", ["Minus", "shift+Minus"]),
	define("zoomReset", "Move", "deck", "Reset the zoom", ["Digit0"]),
	define("zoom", "Move", "deck", "Cycle the zoom presets", ["KeyZ"]),

	define("downbeat", "Beat grid", "deck", "Make the playhead beat 1", ["KeyD"]),
	define("nudgeEarlier", "Beat grid", "deck", "Move the grid 10 ms earlier", ["ArrowLeft"], FINE),
	define("nudgeLater", "Beat grid", "deck", "Move the grid 10 ms later", ["ArrowRight"], FINE),
	define("barEarlier", "Beat grid", "deck", "Beat 1 a beat earlier", ["shift+ArrowLeft"]),
	define("barLater", "Beat grid", "deck", "Beat 1 a beat later", ["shift+ArrowRight"]),
	define("bpmUp", "Beat grid", "deck", "Tempo up 0.1 BPM", ["ArrowUp"], FINE),
	define("bpmDown", "Beat grid", "deck", "Tempo down 0.1 BPM", ["ArrowDown"], FINE),
	define("tap", "Beat grid", "deck", "Tap the tempo", ["KeyT"]),
	define("roundBpm", "Beat grid", "deck", "Round the tempo to a whole BPM", ["KeyR"]),
	define("metronome", "Beat grid", "deck", "Metronome on the beats", ["KeyK"]),

	define("start", "Cues", "deck", "Start the song at the playhead", ["KeyC"]),
	define("snap", "Cues", "deck", "Snap new cues to the beat", ["KeyS"]),
	...PADS.map((n) =>
		define(`pad${n}`, "Cues", "deck", `Set or jump to hot cue ${PAD_LETTERS[n - 1]}`, [
			`Digit${n}`,
		]),
	),
	...PADS.map((n) =>
		define(`clearPad${n}`, "Cues", "deck", `Clear hot cue ${PAD_LETTERS[n - 1]}`, [
			`shift+Digit${n}`,
		]),
	),
	define("help", "Cues", "deck", "Show the grid editor's shortcuts", ["shift+Slash"]),

	define("fileNext", "Move around", "files", "Next item", ["ArrowDown", "KeyJ"]),
	define("filePrev", "Move around", "files", "Previous item", ["ArrowUp", "KeyK"]),
	define("fileOpenFolder", "Move around", "files", "Open folder", ["ArrowRight"]),
	define("fileCloseFolder", "Move around", "files", "Close folder", [
		"ArrowLeft",
		"KeyH",
		"shift+KeyH",
	]),
	define("fileGoInto", "Move around", "files", "Open folder, or go into it", ["KeyL"]),
	define("fileOpen", "Move around", "files", "Go into folder, or play song", ["Enter", "KeyO"]),
	define("fileUp", "Move around", "files", "Up one folder", ["Backspace", "Minus"]),
	define("fileFirst", "Move around", "files", "First item (press twice)", ["KeyG"]),
	define("fileLast", "Move around", "files", "Last item", ["shift+KeyG"]),
	define("fileFilter", "Move around", "files", "Filter this folder", ["Slash"]),
	define("fileMatchNext", "Move around", "files", "Next match", ["KeyN"]),
	define("fileMatchPrev", "Move around", "files", "Previous match", ["shift+KeyN"]),
	define("fileClear", "Move around", "files", "Clear the selection, then the filter", ["Escape"]),
	define("filePlay", "Move around", "files", "Play or pause the selected song", ["Space"]),

	define("fileNewFolder", "Organize", "files", "New folder", ["mod+KeyN", "KeyA"]),
	define("fileRename", "Organize", "files", "Rename", ["F2", "KeyR"]),
	define("fileCut", "Organize", "files", "Cut", ["mod+KeyX", "KeyX"]),
	define("fileCopy", "Organize", "files", "Copy", ["mod+KeyC", "KeyY"]),
	define("filePaste", "Organize", "files", "Paste", ["mod+KeyV", "KeyP"]),
	define("fileDelete", "Organize", "files", "Move to the bin", ["mod+Backspace", "Delete", "KeyD"]),
	define("fileSelectAll", "Organize", "files", "Select all", ["mod+KeyA"]),

	define("fileNextIssue", "Fix and tag", "files", "Next issue", ["BracketRight"]),
	define("filePrevIssue", "Fix and tag", "files", "Previous issue", ["BracketLeft"]),
	define("fileIssue", "Fix and tag", "files", "Show the issue", ["KeyI"]),
	define("fileFix", "Fix and tag", "files", "Fix the issue", ["KeyF"]),
	define("fileTags", "Fix and tag", "files", "Jump to the metadata panel", ["shift+KeyL"]),
	define("fileHelp", "Fix and tag", "files", "Show the file browser's shortcuts", ["shift+Slash"]),
];

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));

export function shortcutDef(id: ShortcutId): ShortcutDef {
	const def = BY_ID.get(id);
	if (!def) {
		throw new Error(`Unknown shortcut: ${id}`);
	}
	return def;
}

const isShortcutId = (value: string): value is ShortcutId => BY_ID.has(value as ShortcutId);

/** The keys chosen on this computer, by action; an action left out keeps its defaults. */
export type Overrides = Readonly<Partial<Record<ShortcutId, readonly Chord[]>>>;

/** The keys every action has now: its own choice, else its defaults. */
export type Bindings = ReadonlyMap<ShortcutId, readonly Chord[]>;

export function resolveBindings(overrides: Overrides): Bindings {
	return new Map(SHORTCUTS.map((s) => [s.id, overrides[s.id] ?? s.defaults]));
}

const storedSchema = z.record(z.string(), z.array(z.string()));

/**
 * Overrides read back from storage. Anything unreadable is dropped rather than failing: an
 * action or key this version does not know (from a newer or older one) loses only its own entry.
 */
export function parseOverrides(json: string | null): Overrides {
	if (json === null) {
		return {};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return {};
	}
	const parsed = storedSchema.safeParse(raw);
	if (!parsed.success) {
		return {};
	}
	const out: Partial<Record<ShortcutId, readonly Chord[]>> = {};
	for (const [id, chords] of Object.entries(parsed.data)) {
		if (!isShortcutId(id)) {
			continue;
		}
		const valid = chords.map(parseChord);
		if (valid.every((chord): chord is Chord => chord !== null)) {
			out[id] = [...new Set(valid)];
		}
	}
	return out;
}

/** Which action a key press means here, and whether ⌥ was held for a finer step. */
export function actionFor(
	bindings: Bindings,
	press: KeyPress,
	scope: ShortcutScope,
): { id: ShortcutId; alt: boolean } | null {
	const exact = chordOf(press);
	const withoutAlt = press.altKey ? chordOf(press, { ignoreAlt: true }) : null;
	for (const def of SHORTCUTS) {
		if (def.scope !== scope) {
			continue;
		}
		const keys = bindings.get(def.id) ?? [];
		if (exact !== null && keys.includes(exact)) {
			return { id: def.id, alt: press.altKey };
		}
		if (def.fineWithAlt && withoutAlt !== null && keys.includes(withoutAlt)) {
			return { id: def.id, alt: true };
		}
	}
	return null;
}

/**
 * Whether two actions can hear the same key press: app and deck keys listen together everywhere;
 * the file browser keeps its keys while focused, where only the app's `anywhere` keys also fire.
 */
function overlap(a: ShortcutDef, b: ShortcutDef): boolean {
	if (a.scope === b.scope) {
		return true;
	}
	if (a.scope === "files" || b.scope === "files") {
		const other = a.scope === "files" ? b : a;
		return other.scope === "app" && other.anywhere === true;
	}
	return true;
}

/** The other actions a chord is already bound to, where both could hear it. */
export function conflictsWith(bindings: Bindings, id: ShortcutId, chord: Chord): ShortcutId[] {
	const def = shortcutDef(id);
	return SHORTCUTS.filter(
		(s) => s.id !== id && overlap(def, s) && (bindings.get(s.id) ?? []).includes(chord),
	).map((s) => s.id);
}

/** Keys the system keeps for itself; binding one needs a second thought. */
const RESERVED: ReadonlyMap<Chord, string> = new Map(
	(
		[
			["mod+KeyQ", "Quit"],
			["mod+KeyW", "Close the window"],
			["mod+KeyH", "Hide the app"],
			["mod+KeyM", "Minimise"],
			["mod+Comma", "Settings"],
			["Tab", "Moving between controls"],
			["shift+Tab", "Moving between controls"],
		] as const
	).map(([chord, what]) => [c(chord), what]),
);

/**
 * Text editing keys: taken from fields and the rest of the app by an app or grid shortcut, which
 * listens everywhere. In the file browser they mean the same thing for files, so they are fine.
 */
const TEXT_EDITING: ReadonlyMap<Chord, string> = new Map(
	(
		[
			["mod+KeyC", "Copy"],
			["mod+KeyX", "Cut"],
			["mod+KeyV", "Paste"],
			["mod+KeyA", "Select all"],
		] as const
	).map(([chord, what]) => [c(chord), what]),
);

/** What the system already does with a chord where `id` would listen, or null when nothing. */
export function reservedFor(chord: Chord, id: ShortcutId): string | null {
	const textEditing = shortcutDef(id).scope === "files" ? null : TEXT_EDITING.get(chord);
	return RESERVED.get(chord) ?? textEditing ?? null;
}

/**
 * Binds `chord` to `id` in place of `replacing` (or as an extra key when null), taking it from
 * any action that had it, so one key never means two things.
 */
export function assign(
	overrides: Overrides,
	id: ShortcutId,
	chord: Chord,
	replacing: Chord | null,
): Overrides {
	const bindings = resolveBindings(overrides);
	const next: Partial<Record<ShortcutId, readonly Chord[]>> = { ...overrides };
	for (const other of conflictsWith(bindings, id, chord)) {
		next[other] = (bindings.get(other) ?? []).filter((k) => k !== chord);
	}
	const own = bindings.get(id) ?? [];
	const kept = replacing === null ? own : own.map((k) => (k === replacing ? chord : k));
	next[id] = [...new Set(replacing === null ? [...kept, chord] : kept)];
	return next;
}

/** Takes one key off an action. */
export function unbind(overrides: Overrides, id: ShortcutId, chord: Chord): Overrides {
	const own = resolveBindings(overrides).get(id) ?? [];
	return { ...overrides, [id]: own.filter((k) => k !== chord) };
}

/** Puts one action back to its keys out of the box. */
export function resetOne(overrides: Overrides, id: ShortcutId): Overrides {
	const { [id]: _dropped, ...rest } = overrides;
	return rest;
}

/** Whether an action's keys differ from its defaults. */
export function isCustom(bindings: Bindings, id: ShortcutId): boolean {
	const now = bindings.get(id) ?? [];
	const defaults = shortcutDef(id).defaults;
	return now.length !== defaults.length || now.some((k, i) => k !== defaults[i]);
}
