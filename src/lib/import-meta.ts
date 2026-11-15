import type { ImportGroup, ImportTrack } from "#/lib/api.ts";
import { camelot, normalizeKey } from "#/lib/musical-key.ts";

const LOSSLESS = new Set(["FLAC", "WAV", "AIFF", "AIF", "ALAC"]);

/** "MP3", "FLAC", … from the file name. */
export function formatOf(file: string): string {
	const ext = file.split(".").pop() ?? "";
	return ext.toUpperCase();
}

/** Below this an MP3 or AAC sounds thin on a club system. */
const LOW_KBPS = 256;

export interface Quality {
	label: string;
	/** Lossy and under 256 kbps: worth a second look before playing out. */
	low: boolean;
}

/** "MP3 320", "FLAC 44.1 kHz", or just the format when nothing else is known. */
export function qualityOf(t: ImportTrack): Quality {
	const format = formatOf(t.file);
	if (LOSSLESS.has(format)) {
		const khz = t.sampleRate ? ` ${(t.sampleRate / 1000).toLocaleString()} kHz` : "";
		return { label: `${format}${khz}`, low: false };
	}
	if (t.bitrate) {
		return { label: `${format} ${t.bitrate}`, low: t.bitrate < LOW_KBPS };
	}
	return { label: format, low: false };
}

/** A tagged key as Camelot ("8A"), or as written when it cannot be read. */
export function keyLabel(raw: string | null | undefined): string | null {
	if (!raw) {
		return null;
	}
	const key = normalizeKey(raw);
	return (key && camelot(key)) ?? raw;
}

/** A tagged BPM rounded for display, or null when there is none. */
export function bpmLabel(raw: string | null | undefined): string | null {
	const n = Number((raw ?? "").replace(",", "."));
	return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : null;
}

/** The value most tracks share, or null when none is tagged. */
function common(values: readonly (string | null | undefined)[]): string | null {
	const counts = new Map<string, number>();
	for (const v of values) {
		if (v) {
			counts.set(v, (counts.get(v) ?? 0) + 1);
		}
	}
	let best: string | null = null;
	let most = 0;
	for (const [v, n] of counts) {
		if (n > most) {
			best = v;
			most = n;
		}
	}
	return best;
}

export interface GroupFacts {
	year: string | null;
	genre: string | null;
	label: string | null;
	/** Total length of the tracks, when any is known. */
	seconds: number | null;
	/** One quality for all tracks, or "Mixed". */
	quality: Quality | null;
	/** Some track has its own cover picture. */
	embeddedArt: boolean;
}

/** What a group's tracks have in common, for its header. */
export function groupFacts(g: ImportGroup): GroupFacts {
	const ms = g.tracks.reduce((n, t) => n + (t.durationMs ?? 0), 0);
	const qualities = g.tracks.map(qualityOf);
	const labels = new Set(qualities.map((q) => q.label));
	let quality: Quality | null = null;
	if (labels.size === 1) {
		quality = qualities[0] ?? null;
	} else if (labels.size > 1) {
		quality = { label: "Mixed quality", low: qualities.some((q) => q.low) };
	}
	return {
		year: common(g.tracks.map((t) => t.year)),
		genre: common(g.tracks.map((t) => t.genre)),
		label: common(g.tracks.map((t) => t.label)),
		seconds: ms > 0 ? ms / 1000 : null,
		quality,
		embeddedArt: g.tracks.some((t) => t.hasArt),
	};
}
