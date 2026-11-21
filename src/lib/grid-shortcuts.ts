/** Everything the grid editor does from the keyboard. */
export type GridAction =
	| "play"
	| "start"
	| "downbeat"
	| "tap"
	| "roundBpm"
	| "metronome"
	| "undo"
	| "redo"
	| "memory"
	| "snap"
	| "zoom"
	| "zoomIn"
	| "zoomOut"
	| "zoomReset"
	| "help"
	| "save"
	| "prevSong"
	| "nextSong"
	| "nudgeEarlier"
	| "nudgeLater"
	| "barEarlier"
	| "barLater"
	| "bpmUp"
	| "bpmDown"
	| "beatBack"
	| "beatOn"
	| "barBack"
	| "barOn"
	| `pad${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`
	| `clearPad${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;

export interface KeyPress {
	key: string;
	code: string;
	shiftKey: boolean;
	altKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
}

/** Keys whose meaning does not depend on ⇧ (or that are typed with it, like `<` and `?`). */
const KEYS: Record<string, GridAction> = {
	ArrowUp: "bpmUp",
	ArrowDown: "bpmDown",
	" ": "play",
	",": "beatBack",
	".": "beatOn",
	"<": "barBack",
	">": "barOn",
	"[": "prevSong",
	"]": "nextSong",
	"?": "help",
	"=": "zoomIn",
	"+": "zoomIn",
	"-": "zoomOut",
	_: "zoomOut",
};

/** Letters and arrows, without ⇧. */
const PLAIN: Record<string, GridAction> = {
	// By position, like the hot cue pads 1–8 beside it.
	Digit0: "zoomReset",
	ArrowLeft: "nudgeEarlier",
	ArrowRight: "nudgeLater",
	c: "start",
	d: "downbeat",
	t: "tap",
	r: "roundBpm",
	k: "metronome",
	m: "memory",
	s: "snap",
	z: "zoom",
};

/** The same with ⇧. */
const SHIFTED: Record<string, GridAction> = {
	ArrowLeft: "barEarlier",
	ArrowRight: "barLater",
};

type Pad = `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;

/** ⌘ (Ctrl) shortcuts: save, undo, and redo as ⇧⌘Z or, as on Windows, Ctrl+Y. */
function commandAction(e: KeyPress): GridAction | null {
	const key = e.key.toLowerCase();
	if (key === "z") {
		return e.shiftKey ? "redo" : "undo";
	}
	if (key === "y" && !e.shiftKey && e.ctrlKey) {
		return "redo";
	}
	return !e.shiftKey && key === "s" ? "save" : null;
}

/** The action a key press means, or `null`. ⌥ is left to the action (finer steps). */
export function gridAction(e: KeyPress): GridAction | null {
	if (e.metaKey || e.ctrlKey) {
		return commandAction(e);
	}
	const pad = /^Digit([1-8])$/.exec(e.code)?.[1] as Pad | undefined;
	if (pad) {
		return e.shiftKey ? `clearPad${pad}` : `pad${pad}`;
	}
	const table = e.shiftKey ? SHIFTED : PLAIN;
	const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
	return table[e.code] ?? KEYS[e.key] ?? table[key] ?? null;
}

/** The cheat sheet, in groups. */
export const GRID_SHORTCUTS: readonly { group: string; items: readonly [string, string][] }[] = [
	{
		group: "Play",
		items: [
			["Space", "Play / pause"],
			[", .", "Back / on one beat"],
			["⇧, ⇧.", "Back / on one bar"],
			["+ −", "Zoom the waveform in / out (or pinch it)"],
			["0", "Reset the zoom"],
			["Z", "Cycle the zoom presets"],
		],
	},
	{
		group: "Beat grid",
		items: [
			["D", "Make the playhead beat 1"],
			["← →", "Move the grid 10 ms (⌥ 1 ms)"],
			["⇧← ⇧→", "Beat 1 a beat earlier / later"],
			["↑ ↓", "Tempo ±0.1 BPM (⌥ 0.01)"],
			["T", "Tap the tempo"],
			["R", "Round the tempo to a whole BPM"],
			["K", "Metronome on the beats"],
		],
	},
	{
		group: "Cues",
		items: [
			["C", "Start the song at the playhead"],
			["1–8", "Set or jump to hot cue A–H"],
			["⇧1–8", "Clear hot cue A–H"],
			["M", "Memory cue at the playhead"],
			["S", "Snap new cues to the beat"],
		],
	},
	{
		group: "Editor",
		items: [
			["[ ]", "Previous / next song"],
			["⌘Z ⇧⌘Z", "Undo / redo"],
			["⌘S", "Save now"],
			["?", "Show these shortcuts"],
		],
	},
];
