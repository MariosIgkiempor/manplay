import { useEffect, useMemo, useState } from "react";
import {
	cancelTagLookup,
	type LookupProgress,
	onLookupProgress,
	type SongLookup,
	type TagPaths,
} from "#/lib/api.ts";
import { useLookupApply, useServices, useTagLookup } from "#/lib/queries.ts";
import {
	type CoverSuggestion,
	coverSuggestions,
	fillsOnly,
	type LookupTally,
	type LookupWrite,
	remainingCovers,
	remainingSuggestions,
	type Suggestion,
	showsInline,
	suggestions,
	takenBy,
	tally,
	USING_SURE_MATCHES,
	type Using,
	writeOf,
} from "#/lib/tag-lookup.ts";

/**
 * Where a lookup stands: not asked for, waiting for the user to allow it, running, failed, or
 * back with results.
 */
export type LookupStage = "idle" | "consent" | "running" | "failed" | "results";

/** A lookup for the songs open in the tag editor, and what is still to take from it. */
export interface TagSuggestions {
	stage: LookupStage;
	progress: LookupProgress | null;
	/** Why the lookup failed, or why the last take did not write everything. */
	problem: string | null;
	songs: readonly SongLookup[];
	tally: LookupTally | null;
	using: Using;
	/** Suggestions that show beside their tag in the editor, by field. */
	inline: ReadonlyMap<string, Suggestion>;
	/** Suggestions with no row to show in: a value per song, or a tag the editor hides. */
	apart: readonly Suggestion[];
	covers: readonly CoverSuggestion[];
	/** A take is being written. */
	writing: boolean;
	start: () => void;
	/** Switches lookups on, which lets a waiting one run. */
	allow: () => void;
	/** Stops a running lookup, or puts the results away. */
	dismiss: () => void;
	searchAgain: () => void;
	includeUnsure: (include: boolean) => void;
	/** Uses another of a song's matches. */
	choose: (path: string, candidate: number) => void;
	take: (suggestion: Suggestion) => void;
	takeCover: (cover: CoverSuggestion) => void;
	takeAll: () => void;
	/** Takes only what fills an empty tag or a missing cover. */
	takeFills: () => void;
}

/**
 * Runs a lookup when asked and keeps track of what was taken from it. `beforeStart` runs first,
 * to save pending edits: the lookup searches with the tags in the files. `group` says the
 * editor shows several songs at once, which hides the tags only one song has.
 */
export function useTagSuggestions(
	path: TagPaths,
	group: boolean,
	beforeStart: () => Promise<unknown>,
): TagSuggestions {
	const services = useServices();
	const allowed = services.isEnabled("lookup", false);
	const [started, setStarted] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [using, setUsing] = useState<Using>(USING_SURE_MATCHES);
	const [taken, setTaken] = useState<ReadonlySet<string>>(new Set());
	const [progress, setProgress] = useState<LookupProgress | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const lookup = useTagLookup(path, attempt, started && allowed);
	const write = useLookupApply();

	useEffect(() => {
		const unlisten = onLookupProgress(setProgress);
		return () => {
			void unlisten.then((stop) => stop());
		};
	}, []);

	const songs = lookup.data;
	const left = useMemo(() => {
		const all = songs ?? [];
		return {
			suggestions: remainingSuggestions(suggestions(all, using), taken),
			covers: remainingCovers(coverSuggestions(all, using), taken),
			tally: songs ? tally(all, using) : null,
		};
	}, [songs, using, taken]);

	const run = (toWrite: LookupWrite) => {
		if (toWrite.changes.length === 0 && toWrite.covers.length === 0) {
			return;
		}
		setFailure(null);
		write.mutate(toWrite, {
			onSuccess: (report) => {
				const failed = new Set(report.failed.map((f) => f.path));
				setTaken((before) => new Set([...before, ...takenBy(toWrite, failed)]));
				const first = report.failed[0];
				setFailure(first ? `${report.failed.length} not written: ${first.error}` : null);
			},
			onError: (e) => setFailure(String(e)),
		});
	};
	const reset = () => {
		setUsing(USING_SURE_MATCHES);
		setTaken(new Set());
		setProgress(null);
		setFailure(null);
	};

	return {
		stage: stageOf(started, allowed, lookup),
		progress,
		problem: lookup.isError ? String(lookup.error) : failure,
		songs: songs ?? [],
		tally: left.tally,
		using,
		inline: new Map(left.suggestions.filter((s) => showsInline(s, group)).map((s) => [s.field, s])),
		apart: left.suggestions.filter((s) => !showsInline(s, group)),
		covers: left.covers,
		writing: write.isPending,
		start: () => {
			reset();
			void beforeStart().finally(() => setStarted(true));
		},
		allow: () => services.setEnabled("lookup", true),
		dismiss: () => {
			if (lookup.isFetching) {
				void cancelTagLookup();
			}
			setStarted(false);
		},
		searchAgain: () => {
			reset();
			setAttempt((n) => n + 1);
		},
		includeUnsure: (include) => setUsing((u) => ({ ...u, includeUnsure: include })),
		choose: (songPath, candidate) =>
			setUsing((u) => ({ ...u, chosen: new Map(u.chosen).set(songPath, candidate) })),
		take: (suggestion) => run(writeOf([suggestion], [])),
		takeCover: (cover) => run(writeOf([], [cover])),
		takeAll: () => run(writeOf(left.suggestions, left.covers)),
		takeFills: () =>
			run(
				writeOf(
					fillsOnly(left.suggestions),
					left.covers.filter((c) => !c.replaces),
				),
			),
	};
}

function stageOf(
	started: boolean,
	allowed: boolean,
	lookup: { isFetching: boolean; isError: boolean; data: unknown },
): LookupStage {
	if (!started) {
		return "idle";
	}
	if (!allowed) {
		return "consent";
	}
	if (lookup.isFetching) {
		return "running";
	}
	if (lookup.isError) {
		return "failed";
	}
	return lookup.data === undefined ? "running" : "results";
}
