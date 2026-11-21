import type { LookupCandidate, ReleaseId, SongLookup } from "#/lib/api.ts";
import { TAG_GROUPS, type TagField } from "#/lib/tag-fields.ts";
import type { FileChanges } from "#/lib/tag-preview.ts";

/** A song that has at least one match. */
export type MatchedSong = SongLookup & { outcome: { kind: "matched" } };

export const isMatched = (song: SongLookup): song is MatchedSong => song.outcome.kind === "matched";

/** Which matches a lookup's suggestions are taken from. */
export interface Using {
	/** A match chosen by hand, as an index into a song's candidates, by path. */
	chosen: ReadonlyMap<string, number>;
	/** Also use matches that are not sure. */
	includeUnsure: boolean;
}

export const USING_SURE_MATCHES: Using = { chosen: new Map(), includeUnsure: false };

/** The match in play for `song`: the one chosen by hand, else its best. */
export function chosenCandidate(song: MatchedSong, using: Using): LookupCandidate | undefined {
	return song.outcome.candidates[using.chosen.get(song.path) ?? 0];
}

/**
 * The songs whose match is used, each with that match: sure matches, a match chosen by hand
 * (choosing it says it is right), and unsure ones only when asked for.
 */
function usedMatches(
	songs: readonly SongLookup[],
	using: Using,
): { song: MatchedSong; candidate: LookupCandidate }[] {
	return songs.flatMap((song) => {
		if (!isMatched(song)) {
			return [];
		}
		const candidate = chosenCandidate(song, using);
		const used =
			candidate && (candidate.likely || using.includeUnsure || using.chosen.has(song.path));
		return candidate && used ? [{ song, candidate }] : [];
	});
}

/** One song's part of a suggestion. */
export interface SongChange {
	path: string;
	/** What the song holds now; null when the tag is empty. */
	from: string | null;
	to: string;
}

/** One tag a lookup would change, across the songs it found a value for. */
export interface Suggestion {
	field: string;
	changes: SongChange[];
	/** The new value when every one of those songs gets the same; null when each gets its own. */
	value: string | null;
	/** It only fills empty tags: no song has a value it would replace. */
	fills: boolean;
}

const FIELDS: readonly TagField[] = TAG_GROUPS.flatMap((group) => group.fields);
const FIELD_ORDER = FIELDS.map((field) => field.id);

/** The suggestions of the matches in use, one per tag, in the tag editor's order. */
export function suggestions(songs: readonly SongLookup[], using: Using): Suggestion[] {
	const byField = new Map<string, SongChange[]>();
	for (const { song, candidate } of usedMatches(songs, using)) {
		for (const change of candidate.changes) {
			if (change.to !== null) {
				const changes = byField.get(change.field) ?? [];
				changes.push({ path: song.path, from: change.from, to: change.to });
				byField.set(change.field, changes);
			}
		}
	}
	return [...byField]
		.map(([field, changes]) => suggestionOf(field, changes))
		.sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field));
}

function suggestionOf(field: string, changes: SongChange[]): Suggestion {
	const first = changes[0]?.to ?? null;
	return {
		field,
		changes,
		value: changes.every((c) => c.to === first) ? first : null,
		fills: changes.every((c) => c.from === null),
	};
}

/** What marks one song's tag, or its cover, as already taken from a lookup. */
export const takenKey = (field: string, path: string): string => `${field}\u0000${path}`;

/** The field name the cover goes by among the taken keys; not a tag field. */
export const COVER = "cover";

/** The suggestions still to take: without the songs' tags that were written already. */
export function remainingSuggestions(
	all: readonly Suggestion[],
	taken: ReadonlySet<string>,
): Suggestion[] {
	return all.flatMap((suggestion) => {
		const changes = suggestion.changes.filter(
			(c) => !taken.has(takenKey(suggestion.field, c.path)),
		);
		return changes.length > 0 ? [suggestionOf(suggestion.field, changes)] : [];
	});
}

/** The covers still to take: without the songs that were given theirs already. */
export function remainingCovers(
	all: readonly CoverSuggestion[],
	taken: ReadonlySet<string>,
): CoverSuggestion[] {
	return all.flatMap((cover) => {
		const paths = cover.paths.filter((path) => !taken.has(takenKey(COVER, path)));
		return paths.length > 0 ? [{ ...cover, paths }] : [];
	});
}

/** The keys that mark everything in `write` as taken, leaving out the songs in `failed`. */
export function takenBy(write: LookupWrite, failed: ReadonlySet<string>): string[] {
	return [
		...write.changes.flatMap((file) =>
			failed.has(file.path) ? [] : file.changes.map((c) => takenKey(c.field, file.path)),
		),
		...write.covers.flatMap((cover) =>
			cover.paths.filter((path) => !failed.has(path)).map((path) => takenKey(COVER, path)),
		),
	];
}

/**
 * Whether a suggestion can show beside its tag in the editor: it must be one value, and the
 * editor must show that tag (a folder or a group of songs hides the tags only one song has).
 */
export function showsInline(suggestion: Suggestion, group: boolean): boolean {
	const field = FIELDS.find((f) => f.id === suggestion.field);
	return suggestion.value !== null && field !== undefined && (!group || field.scope === "both");
}

/** Only the part of each suggestion that fills an empty tag. */
export function fillsOnly(all: readonly Suggestion[]): Suggestion[] {
	return all.flatMap((suggestion) => {
		const changes = suggestion.changes.filter((c) => c.from === null);
		return changes.length > 0 ? [{ ...suggestion, changes, fills: true }] : [];
	});
}

/** A cover a lookup found, and the songs it would go on. */
export interface CoverSuggestion {
	release: ReleaseId;
	paths: string[];
	/** Those songs have a cover, which this one would take the place of. */
	replaces: boolean;
}

/**
 * The covers of the matches in use, one per release, with songs that have a cover apart from
 * songs that do not, so the ones that only fill a gap can be taken on their own.
 */
export function coverSuggestions(songs: readonly SongLookup[], using: Using): CoverSuggestion[] {
	const found: CoverSuggestion[] = [];
	for (const { song, candidate } of usedMatches(songs, using)) {
		const release = candidate.cover;
		if (release === null) {
			continue;
		}
		const same = found.find((c) => c.release === release && c.replaces === song.hasCover);
		if (same) {
			same.paths.push(song.path);
		} else {
			found.push({ release, paths: [song.path], replaces: song.hasCover });
		}
	}
	return found;
}

/** What a lookup came back with, in numbers. */
export interface LookupTally {
	songs: number;
	/** Songs whose match is in use. */
	used: number;
	/** Songs whose best match is not sure and is left out. */
	leftOut: number;
	/** Songs without a match, each with the reason. */
	unmatched: { path: string; reason: string }[];
}

export function tally(songs: readonly SongLookup[], using: Using): LookupTally {
	const used = usedMatches(songs, using).length;
	const matched = songs.filter(isMatched).length;
	return {
		songs: songs.length,
		used,
		leftOut: matched - used,
		unmatched: songs.flatMap((song) => {
			const reason = reasonWithoutMatch(song);
			return reason === null ? [] : [{ path: song.path, reason }];
		}),
	};
}

/** One cover to fetch, and the songs it goes on. */
export interface CoverWrite {
	release: ReleaseId;
	paths: string[];
}

/** Everything taking suggestions writes: each song's tags, and the covers. */
export interface LookupWrite {
	changes: FileChanges[];
	covers: CoverWrite[];
}

/** What taking these suggestions and covers writes, song by song. */
export function writeOf(
	taken: readonly Suggestion[],
	covers: readonly CoverSuggestion[],
): LookupWrite {
	const byPath = new Map<string, FileChanges>();
	for (const suggestion of taken) {
		for (const change of suggestion.changes) {
			const file = byPath.get(change.path) ?? { path: change.path, changes: [] };
			file.changes.push({ field: suggestion.field, from: change.from, to: change.to });
			byPath.set(change.path, file);
		}
	}
	return {
		changes: [...byPath.values()],
		covers: covers.map(({ release, paths }) => ({ release, paths })),
	};
}

/** Why a song has no match to show, in words; null for a song that has one. */
export function reasonWithoutMatch(song: SongLookup): string | null {
	switch (song.outcome.kind) {
		case "matched":
			return null;
		case "noMatch":
			return "No song like this was found online";
		case "notEnoughTags":
			return "Needs a title and an artist to search with";
		case "failed":
			return song.outcome.message;
	}
}
