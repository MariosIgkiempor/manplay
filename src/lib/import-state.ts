import { useMemo } from "react";
import type {
	ImportGroup,
	ImportRequest,
	ImportScan,
	ImportTrack,
	SourceRef,
	Track,
} from "#/lib/api.ts";

export const srcKey = (s: SourceRef) => `${s.path}\u0000${s.entry ?? ""}`;
export const trackKey = (t: ImportTrack) => srcKey(t.src);
export const pairKey = (artist: string, album: string) =>
	`${artist.trim().toLowerCase()}\u0000${album.trim().toLowerCase()}`;

/** Stable across rescans, so edits survive the cached list being replaced by a fresh scan. */
export const groupKey = (g: ImportGroup) =>
	`${g.kind}|${g.origin}|${g.tracks[0] ? trackKey(g.tracks[0]) : ""}`;

export interface Edit {
	artist: string;
	album: string;
	/** The user typed in it, so a rescan must not overwrite it with a new guess. */
	touched: boolean;
}

export type Placement = "existing" | "new album" | "new artist";

export function useLibraryIndex(tracks: Track[] | undefined) {
	return useMemo(() => {
		const byArtist = new Map<string, Set<string>>();
		const pairs = new Set<string>();
		for (const t of tracks ?? []) {
			byArtist.set(t.artist, (byArtist.get(t.artist) ?? new Set()).add(t.album));
			pairs.add(pairKey(t.artist, t.album));
		}
		return {
			artists: [...byArtist.keys()].sort((a, b) => a.localeCompare(b)),
			albumsByArtist: byArtist,
			existing: pairs,
		};
	}, [tracks]);
}

/** Keeps the user's edits; every other group gets the scan's guess. */
export function mergeEdits(
	prev: Record<string, Edit>,
	groups: ImportGroup[],
): Record<string, Edit> {
	return Object.fromEntries(
		groups.map((g) => {
			const key = groupKey(g);
			const kept = prev[key];
			return [key, kept?.touched ? kept : { artist: g.artist, album: g.album, touched: false }];
		}),
	);
}

export const editOf = (edits: Record<string, Edit>, g: ImportGroup): Edit =>
	edits[groupKey(g)] ?? { artist: g.artist, album: g.album, touched: false };

/** One request per group holding a chosen new track, with that group's artist and album. */
export function buildRequests(
	scan: ImportScan | null,
	edits: Record<string, Edit>,
	chosen: ReadonlySet<string>,
): ImportRequest[] {
	return (scan?.groups ?? []).flatMap((g) => {
		const edit = editOf(edits, g);
		const tracks = g.tracks.filter((t) => t.status === "new" && chosen.has(trackKey(t)));
		if (tracks.length === 0) {
			return [];
		}
		return [
			{
				artist: edit.artist.trim() || "Unknown",
				album: edit.album.trim() || "Unknown",
				tracks: tracks.map((t) => t.src),
				images: g.images,
			},
		];
	});
}

/** Keys of a group's tracks that can still be imported. */
export const newKeys = (g: ImportGroup): string[] =>
	g.tracks.filter((t) => t.status === "new").map(trackKey);

/** Keys of every track of a group, importable or not (all can be moved to the Trash). */
export const allKeys = (g: ImportGroup): string[] => g.tracks.map(trackKey);

const parentOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

/**
 * What moving the picked tracks to the Trash removes: a whole release's folder or zip when every
 * track of it is picked (a folder only when it is not the Downloads folder itself), otherwise the
 * picked files one by one. Tracks inside a zip can only go with the whole zip; those are counted
 * in `kept`.
 */
export function trashTargets(
	scan: ImportScan | null,
	keys: ReadonlySet<string>,
	root: string | null,
): { paths: string[]; kept: number } {
	const paths = new Set<string>();
	let kept = 0;
	for (const g of scan?.groups ?? []) {
		const picked = g.tracks.filter((t) => keys.has(trackKey(t)));
		if (picked.length > 0) {
			const out = releaseTrash(g, picked, root);
			kept += out.kept;
			for (const p of out.paths) {
				paths.add(p);
			}
		}
	}
	return { paths: [...paths], kept };
}

/** What trashing `picked` of one release removes. */
function releaseTrash(
	g: ImportGroup,
	picked: readonly ImportTrack[],
	root: string | null,
): { paths: string[]; kept: number } {
	const whole = picked.length === g.tracks.length;
	if (g.fromZip) {
		const zip = g.tracks[0]?.src.path;
		return whole && zip ? { paths: [zip], kept: 0 } : { paths: [], kept: picked.length };
	}
	const dirs = new Set(g.tracks.map((t) => parentOf(t.src.path)));
	const [dir] = dirs;
	if (whole && g.kind === "album" && dirs.size === 1 && dir && dir !== root) {
		return { paths: [dir], kept: 0 };
	}
	const files = picked.map((t) => t.src.path);
	return { paths: whole ? [...files, ...g.images.map((i) => i.path)] : files, kept: 0 };
}

/** Marks imported tracks as in the library and drops groups with nothing new left. */
export function applyAdded(scan: ImportScan, added: Set<string>): ImportScan {
	let count = 0;
	const groups = scan.groups.flatMap((g) => {
		const tracks = g.tracks.map((t) => {
			if (added.has(trackKey(t))) {
				count += 1;
				return { ...t, status: "inLibrary" as const };
			}
			return t;
		});
		return tracks.some((t) => t.status === "new") ? [{ ...g, tracks }] : [];
	});
	return { ...scan, groups, alreadyInLibrary: scan.alreadyInLibrary + count };
}

export function placementOf(edit: Edit, artists: string[], existing: Set<string>): Placement {
	if (existing.has(pairKey(edit.artist, edit.album))) {
		return "existing";
	}
	return artists.includes(edit.artist.trim()) ? "new album" : "new artist";
}

export function countNew(scan: ImportScan | null): number {
	return (scan?.groups ?? []).reduce(
		(n, g) => n + g.tracks.filter((t) => t.status === "new").length,
		0,
	);
}

/** A stand-in library track so the player can play a file that is not imported yet. */
export function previewTrack(path: string, t: ImportTrack, edit: Edit): Track {
	return {
		id: -1,
		path,
		artist: t.artist || edit.artist,
		album: edit.album,
		title: t.title,
		size: t.size,
		tags: [],
		syncedCount: 0,
		fields: {},
		durationMs: null,
		bitrate: null,
		sampleRate: null,
		bpm: null,
		key: null,
		analyzed: false,
		edited: { bpm: false, key: false, grid: false },
		fileState: "here",
	};
}
