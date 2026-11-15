/** Pitch class (C = 0) of each note name the backend uses, sharps and flats alike. */
const PITCH: Record<string, number> = {
	C: 0,
	"C#": 1,
	Db: 1,
	D: 2,
	"D#": 3,
	Eb: 3,
	E: 4,
	F: 5,
	"F#": 6,
	Gb: 6,
	G: 7,
	"G#": 8,
	Ab: 8,
	A: 9,
	"A#": 10,
	Bb: 10,
	B: 11,
};

const NAME_LONG: Record<string, string> = { "#": "♯", b: "♭" };

function parse(key: string): { pc: number; minor: boolean; note: string } | null {
	const minor = key.endsWith("m");
	const note = minor ? key.slice(0, -1) : key;
	const pc = PITCH[note];
	return pc === undefined ? null : { pc, minor, note };
}

/**
 * Camelot wheel code for a key in rekordbox spelling: "Am" → "8A", "C" → "8B". Keys a fifth
 * apart are neighbours on the wheel, which is what harmonic mixing goes by.
 */
export function camelot(key: string): string | null {
	const k = parse(key);
	if (!k) {
		return null;
	}
	// The relative major of a minor key is three semitones up and shares its number.
	const majorPc = k.minor ? (k.pc + 3) % 12 : k.pc;
	// 8B is C; each step round the wheel is a fifth (7 semitones) up.
	const n = ((majorPc * 7) % 12) + 8;
	return `${((n - 1) % 12) + 1}${k.minor ? "A" : "B"}`;
}

/** "A♭ minor" style name for a key in rekordbox spelling. */
export function keyName(key: string): string | null {
	const k = parse(key);
	if (!k) {
		return null;
	}
	const note = k.note[0] + (NAME_LONG[k.note.slice(1)] ?? "");
	return `${note} ${k.minor ? "minor" : "major"}`;
}

/** "128" for whole tempos, "126.4" otherwise. */
export function formatBpm(bpm: number): string {
	const tenths = Math.round(bpm * 10) / 10;
	return Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
}

const MAJOR = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];
const NATURAL: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Camelot ("8A") or Open Key ("1m") code to rekordbox spelling. */
function fromWheel(n: number, letter: string): string | null {
	if (n < 1 || n > 12) {
		return null;
	}
	// 8B is C; each step round the wheel is a fifth up. Open Key 1d is C.
	const camelotMajor = ((n - 8) * 7 + 84) % 12;
	const openMajor = ((n - 1) * 7) % 12;
	const major = letter === "a" || letter === "b" ? camelotMajor : openMajor;
	const minor = letter === "a" || letter === "m";
	return (minor ? MINOR[(major + 9) % 12] : MAJOR[major]) ?? null;
}

const MAJOR_WORDS = new Set(["", "maj", "major", "dur"]);
const MINOR_WORDS = new Set(["m", "min", "minor", "moll"]);

/** "A minor", "F♯", "Bbm" to rekordbox spelling. */
function fromNoteName(t: string): string | null {
	const note = /^([a-g])(#|♯|♭|b)?(.*)$/.exec(t);
	const base = note?.[1] === undefined ? undefined : NATURAL[note[1]];
	if (!note || base === undefined) {
		return null;
	}
	const sharp = note[2] === "#" || note[2] === "♯";
	const pc = (base + (sharp ? 1 : note[2] ? 11 : 0)) % 12;
	const rest = note[3] ?? "";
	if (MAJOR_WORDS.has(rest)) {
		return MAJOR[pc] ?? null;
	}
	return MINOR_WORDS.has(rest) ? (MINOR[pc] ?? null) : null;
}

/**
 * A typed key in rekordbox spelling, the way the backend stores it: Camelot ("8A"), Open Key
 * ("1m") or a note name ("A minor", "F♯", "Bbm"). Null when it is not a key. Mirrors
 * `normalize_key` in `src-tauri/src/analysis.rs`.
 */
export function normalizeKey(text: string): string | null {
	const t = text.replace(/\s+/g, "").toLowerCase();
	const wheel = /^(\d{1,2})([abdm])$/.exec(t);
	return wheel ? fromWheel(Number(wheel[1]), wheel[2] ?? "") : fromNoteName(t);
}
