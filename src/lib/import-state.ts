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

/** One request per group (limited to `only` when given) that still has a selected new track. */
export function buildRequests(
	scan: ImportScan | null,
	edits: Record<string, Edit>,
	unchecked: Set<string>,
	only: string | null,
): ImportRequest[] {
	return (scan?.groups ?? []).flatMap((g) => {
		const edit = editOf(edits, g);
		const chosen = g.tracks.filter((t) => t.status === "new" && !unchecked.has(trackKey(t)));
		if (chosen.length === 0 || (only !== null && only !== groupKey(g))) {
			return [];
		}
		return [
			{
				artist: edit.artist.trim() || "Unknown",
				album: edit.album.trim() || "Unknown",
				tracks: chosen.map((t) => t.src),
				images: g.images,
			},
		];
	});
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

export function withToggled(set: Set<string>, key: string): Set<string> {
	const next = new Set(set);
	if (!next.delete(key)) {
		next.add(key);
	}
	return next;
}

export function withAll(set: Set<string>, g: ImportGroup, on: boolean): Set<string> {
	const next = new Set(set);
	for (const t of g.tracks) {
		if (on) {
			next.delete(trackKey(t));
		} else {
			next.add(trackKey(t));
		}
	}
	return next;
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
		durationMs: null,
		bitrate: null,
		sampleRate: null,
	};
}
