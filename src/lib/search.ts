import type { Playlist, Tag, Track } from "#/lib/api.ts";
import { splitNames } from "#/lib/names.ts";

export type PillKind = "artist" | "song" | "playlist" | "tag";

/** A picked filter shown in the search bar. `id` is the artist name, track id, playlist id or tag name. */
export interface Pill {
	kind: PillKind;
	label: string;
	id: string | number;
}

export const pillKey = (p: Pill): string => `${p.kind}:${p.id}`;

export type PlaylistMembers = ReadonlyMap<number, ReadonlySet<number>>;

function matchesPill(t: Track, p: Pill, members: PlaylistMembers): boolean {
	switch (p.kind) {
		case "artist":
			return splitNames(t.artist).includes(String(p.id));
		case "song":
			return t.id === p.id;
		case "playlist":
			return members.get(Number(p.id))?.has(t.id) ?? false;
		case "tag":
			return t.tags.some((x) => x.toLowerCase() === String(p.id).toLowerCase());
	}
}

/**
 * Tracks matching the typed text and every kind of pill: pills of one kind are alternatives
 * (two artists show both), different kinds must all hold (an artist and a tag narrow down).
 */
export function filterTracks(
	tracks: readonly Track[],
	pills: readonly Pill[],
	text: string,
	members: PlaylistMembers,
): Track[] {
	const q = text.trim().toLowerCase();
	const byKind = new Map<PillKind, Pill[]>();
	for (const p of pills) {
		byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p]);
	}
	return tracks.filter((t) => {
		if (q !== "" && !`${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)) {
			return false;
		}
		return [...byKind.values()].every((group) => group.some((p) => matchesPill(t, p, members)));
	});
}

export interface Suggestion {
	pill: Pill;
	/** Secondary text, e.g. the artist of a song or a track count. */
	hint: string;
}

export interface SuggestionGroup {
	title: string;
	items: Suggestion[];
}

const LIMIT = 5;

/**
 * Palette entries for `query`, grouped. With nothing typed only playlists and tags are offered
 * (there are too many artists and songs to list). Already-picked pills are left out.
 */
export function suggest(
	query: string,
	tracks: readonly Track[],
	playlists: readonly Playlist[],
	tags: readonly Tag[],
	picked: readonly Pill[],
): SuggestionGroup[] {
	const q = query.trim().toLowerCase();
	const taken = new Set(picked.map(pillKey));
	const has = (s: string) => q === "" || s.toLowerCase().includes(q);
	const fresh = (s: Suggestion) => !taken.has(pillKey(s.pill));

	const artists = new Map<string, number>();
	for (const t of tracks) {
		for (const name of splitNames(t.artist)) {
			artists.set(name, (artists.get(name) ?? 0) + 1);
		}
	}
	const groups: SuggestionGroup[] = [];
	if (q !== "") {
		groups.push({
			title: "Artists",
			items: [...artists]
				.filter(([name]) => name !== "" && has(name))
				.map(([name, n]) => ({
					pill: { kind: "artist", label: name, id: name } as Pill,
					hint: `${n} song${n === 1 ? "" : "s"}`,
				}))
				.filter(fresh)
				.slice(0, LIMIT),
		});
		groups.push({
			title: "Songs",
			items: tracks
				.filter((t) => has(t.title))
				.map((t) => ({
					pill: { kind: "song", label: t.title, id: t.id } as Pill,
					hint: t.artist,
				}))
				.filter(fresh)
				.slice(0, LIMIT),
		});
	}
	groups.push({
		title: "Playlists",
		items: playlists
			.filter((p) => has(p.name))
			.map((p) => ({
				pill: { kind: "playlist", label: p.name, id: p.id } as Pill,
				hint: `${p.trackCount} song${p.trackCount === 1 ? "" : "s"}`,
			}))
			.filter(fresh)
			.slice(0, LIMIT),
	});
	groups.push({
		title: "Tags",
		items: tags
			.filter((g) => has(g.name))
			.map((g) => ({
				pill: { kind: "tag", label: g.name, id: g.name } as Pill,
				hint: `${g.trackCount} song${g.trackCount === 1 ? "" : "s"}`,
			}))
			.filter(fresh)
			.slice(0, LIMIT),
	});
	return groups.filter((g) => g.items.length > 0);
}
