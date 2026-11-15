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
