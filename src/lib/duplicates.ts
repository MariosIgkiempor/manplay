import type { DuplicateGroup } from "#/lib/api.ts";
import { baseName } from "#/lib/fs-path.ts";

export type DuplicateCopy = DuplicateGroup["tracks"][number];
export type CueApp = DuplicateCopy["embeddedCues"][number];
/** Absolute path of one stored copy; copies of one song can share a track id, never a path. */
export type CopyPath = string;
/** A duplicate group's audio fingerprint, which names the group. */
export type GroupKey = DuplicateGroup["audioFp"];

/** Files beyond the first of each group: what is stored more than once. */
export function extraCopies(groups: readonly DuplicateGroup[]): number {
	return groups.reduce((n, g) => n + g.tracks.length - 1, 0);
}

/** Where in a file name the copy marker sits, so it can be shown marked. */
export interface CopyMarker {
	/** Index of the marker's first character in the file name. */
	start: number;
	/** The marker as written, e.g. ` (1)` or ` - Copy`. */
	text: string;
}

/**
 * Endings that file managers and browsers add to a copy's name: `name (1)` (browsers, Windows),
 * `name - Copy`, `name - Copy (2)` (Windows), `name copy 2` (older macOS Finder), `name_copy`,
 * `name [1]`. The number is one or two digits so a year such as `(2019)` is not taken for one.
 */
const COPY_ENDINGS: readonly RegExp[] = [
	/\s-\s?copy(?:\s?\(\d{1,2}\))?$/i,
	/\scopy\s\d{1,2}$/i,
	/_copy(?:_?\d{1,2})?$/i,
	/\s?\(\d{1,2}\)$/,
	/\s?\[\d{1,2}\]$/,
];

/**
 * Endings that only mean "copy" beside a sibling with the bare name: `name copy` (Finder), and a
 * number tacked on: `name 2`, `name-1`, `name_1`, `name.1`. Alone, `Carbon Copy` or `Track 2`
 * is as likely to be the real title.
 */
const SIBLING_SUFFIX = /^(?:[\s_.-]\d{1,2}|\scopy)$/i;

function splitName(fileName: string): { stem: string; ext: string } {
	const dot = fileName.lastIndexOf(".");
	return dot <= 0
		? { stem: fileName, ext: "" }
		: { stem: fileName.slice(0, dot), ext: fileName.slice(dot) };
}

/**
 * The copy marker at the end of `fileName`'s stem, or null. `siblingNames` are the other copies'
 * file names: a bare number (`name 2`) or `copy` only counts as a marker when a sibling is called `name`,
 * since a lone `Track 2` is as likely to be a real title.
 */
export function copyMarker(
	fileName: string,
	siblingNames: readonly string[] = [],
): CopyMarker | null {
	const { stem } = splitName(fileName);
	for (const ending of COPY_ENDINGS) {
		const match = ending.exec(stem);
		// A name that is nothing but the marker (`(1).mp3`) has nothing to be a copy of.
		if (match && match.index > 0) {
			return { start: match.index, text: match[0] };
		}
	}
	const lower = stem.toLowerCase();
	for (const sibling of siblingNames) {
		const siblingStem = splitName(sibling).stem.toLowerCase();
		if (siblingStem !== "" && lower.startsWith(siblingStem)) {
			const rest = stem.slice(siblingStem.length);
			if (SIBLING_SUFFIX.test(rest)) {
				return { start: siblingStem.length, text: rest };
			}
		}
	}
	return null;
}

/** Why a copy was chosen as the one to keep, in words shown beside it. */
export type KeepReason =
	/** The other copies' names carry a copy marker; this one's does not. */
	| "unmarked"
	/** The other copies have file issues (wrong folder, not MP3, old tags); this one has none. */
	| "tidy"
	/** The user chose it. */
	| "picked";

/**
 * What happens to one group: keep one copy and send the rest to the Trash, leave every copy
 * (the user said so), or wait for the user because no copy stands out.
 */
export type GroupDecision =
	| { kind: "keep"; path: CopyPath; reason: KeepReason }
	| { kind: "keepAll" }
	| { kind: "undecided"; why: UndecidedReason };

/** Why no copy was picked on the user's behalf. */
export type UndecidedReason =
	/** Neither names nor file issues single one copy out. */
	| "unclear"
	/** The copy with the plain name has file issues, and a copy marked as one has none. */
	| "signsDisagree"
	/** A copy that would go holds DJ-app cue points in its tags that the kept copy lacks. */
	| "cuesWouldGo";

/** What the user set for a group, overriding the suggestion. */
export type GroupChoice = { kind: "keep"; path: CopyPath } | { kind: "keepAll" };

/** The copy the names or file issues single out, before the cue-point check. */
function pickByNameAndIssues(
	copies: readonly DuplicateCopy[],
	issueCount: (path: CopyPath) => number,
): GroupDecision {
	const names = copies.map((c) => baseName(c.path));
	const unmarked = copies.filter(
		(c, i) =>
			copyMarker(
				baseName(c.path),
				names.filter((_, j) => j !== i),
			) === null,
	);
	const [onlyUnmarked] = unmarked;
	if (onlyUnmarked && unmarked.length === 1 && copies.length > 1) {
		const markedTidier =
			issueCount(onlyUnmarked.path) > 0 &&
			copies.some((c) => c !== onlyUnmarked && issueCount(c.path) === 0);
		return markedTidier
			? { kind: "undecided", why: "signsDisagree" }
			: { kind: "keep", path: onlyUnmarked.path, reason: "unmarked" };
	}
	const candidates = unmarked.length > 0 ? unmarked : copies;
	const tidy = candidates.filter((c) => issueCount(c.path) === 0);
	const [onlyTidy] = tidy;
	if (onlyTidy && tidy.length === 1 && candidates.length > 1) {
		return { kind: "keep", path: onlyTidy.path, reason: "tidy" };
	}
	return { kind: "undecided", why: "unclear" };
}

/** DJ apps with cue points in some copy of the group but not in `keep`. */
export function cuesLostWith(copies: readonly DuplicateCopy[], keep: DuplicateCopy): CueApp[] {
	const lost = copies
		.filter((c) => c.path !== keep.path)
		.flatMap((c) => c.embeddedCues)
		.filter((app) => !keep.embeddedCues.includes(app));
	return [...new Set(lost)];
}

/**
 * The copy to keep when one clearly should be: the only copy whose name has no copy marker, or
 * failing that the only one with no file issues. Anything less clear is left to the user, since
 * guessing wrong here throws away the file they meant to keep: the two signs pointing at
 * different copies, or cue points that only a copy about to go holds.
 */
export function suggestKeeper(
	copies: readonly DuplicateCopy[],
	issueCount: (path: CopyPath) => number,
): GroupDecision {
	const pick = pickByNameAndIssues(copies, issueCount);
	if (pick.kind !== "keep") {
		return pick;
	}
	const keep = copies.find((c) => c.path === pick.path);
	return keep && cuesLostWith(copies, keep).length > 0
		? { kind: "undecided", why: "cuesWouldGo" }
		: pick;
}

/** The decision for each group: the user's choice where there is one, else the suggestion. */
export function decideGroups(
	groups: readonly DuplicateGroup[],
	choices: ReadonlyMap<GroupKey, GroupChoice>,
	issueCount: (path: CopyPath) => number,
): Map<GroupKey, GroupDecision> {
	const out = new Map<GroupKey, GroupDecision>();
	for (const group of groups) {
		const choice = choices.get(group.audioFp);
		const stillThere =
			choice?.kind === "keep" ? group.tracks.some((t) => t.path === choice.path) : true;
		out.set(
			group.audioFp,
			choice && stillThere
				? choice.kind === "keep"
					? { kind: "keep", path: choice.path, reason: "picked" }
					: choice
				: suggestKeeper(group.tracks, issueCount),
		);
	}
	return out;
}

/** What "move the extra copies to the Trash" would do across every group. */
export interface TrashPlan {
	/** Groups with a copy kept, in list order, and the copies leaving each. */
	groups: readonly {
		group: DuplicateGroup;
		keep: DuplicateCopy;
		trash: readonly DuplicateCopy[];
	}[];
	paths: readonly CopyPath[];
	bytes: number;
	/** Groups still waiting for the user to pick a copy. */
	undecided: number;
	/** Groups the user chose to leave as they are. */
	keptAll: number;
}

export function trashPlan(
	groups: readonly DuplicateGroup[],
	decisions: ReadonlyMap<GroupKey, GroupDecision>,
): TrashPlan {
	const planned: TrashPlan["groups"][number][] = [];
	let undecided = 0;
	let keptAll = 0;
	for (const group of groups) {
		const decision = decisions.get(group.audioFp);
		if (decision === undefined) {
			undecided += 1;
			continue;
		}
		if (decision.kind === "undecided") {
			undecided += 1;
			continue;
		}
		if (decision.kind === "keepAll") {
			keptAll += 1;
			continue;
		}
		const keep = group.tracks.find((t) => t.path === decision.path);
		if (keep) {
			// By path: a copy listed twice must never count as both kept and thrown away.
			planned.push({ group, keep, trash: group.tracks.filter((t) => t.path !== keep.path) });
		}
	}
	const leaving = planned.flatMap((g) => g.trash);
	return {
		groups: planned,
		paths: leaving.map((t) => t.path),
		bytes: leaving.reduce((n, t) => n + t.size, 0),
		undecided,
		keptAll,
	};
}
