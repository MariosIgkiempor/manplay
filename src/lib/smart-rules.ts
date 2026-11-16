import type { AddedRule, SmartRules } from "#/lib/api.ts";
import { tagLeaf } from "#/lib/tag-tree.ts";

export const EMPTY_RULES: SmartRules = {
	allTags: [],
	anyTags: [],
	noneTags: [],
	added: null,
	bpmMin: null,
	bpmMax: null,
};

export function hasRules(r: SmartRules): boolean {
	return (
		r.allTags.length + r.anyTags.length + r.noneTags.length > 0 ||
		r.added !== null ||
		r.bpmMin !== null ||
		r.bpmMax !== null
	);
}

export function sameRules(a: SmartRules, b: SmartRules): boolean {
	const key = (r: SmartRules) =>
		JSON.stringify([
			r.allTags,
			r.anyTags,
			r.noneTags,
			r.added && Object.entries(r.added).sort(),
			r.bpmMin,
			r.bpmMax,
		]);
	return key(a) === key(b);
}

/**
 * A tag entry the backend could not name: the tag is local to another device or was deleted. It
 * comes as `?<uid>` and goes back unchanged when the rules are saved, so the uid is not lost.
 */
export function isUnknownTag(name: string): boolean {
	return name.startsWith("?");
}

/** The last level of a rule's tag, or a stand-in for one this device does not have. */
export function ruleTagLabel(name: string): string {
	return isUnknownTag(name) ? "Unknown tag" : tagLeaf(name);
}

/** A name from the rules: the ALL tags' last levels joined with "+", then the ANY ones. */
export function autoName(r: SmartRules): string {
	const all = r.allTags.map(ruleTagLabel);
	const any = r.anyTags.map(ruleTagLabel);
	const parts = [...all, ...(any.length > 0 ? [any.join(" or ")] : [])];
	return parts.length > 0 ? parts.join(" + ") : "New smart playlist";
}

export type AddedKind = "any" | AddedRule["kind"];

export function addedKind(rule: AddedRule | null): AddedKind {
	return rule?.kind ?? "any";
}

/** Unix seconds of the start of today, in local time. */
function today(now: Date): number {
	return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
}

/** Switches the date rule's kind, keeping a date when going between "after" and "before". */
export function withAddedKind(
	rule: AddedRule | null,
	kind: AddedKind,
	now: Date = new Date(),
): AddedRule | null {
	if (kind === "any") {
		return null;
	}
	if (kind === "within") {
		return rule?.kind === "within" ? rule : { kind, amount: 30, unit: "days" };
	}
	const date = rule && rule.kind !== "within" ? rule.date : today(now) - 30 * 86_400;
	return { kind, date };
}

/** `YYYY-MM-DD` for a date input, in local time. */
export function dateInput(unix: number): string {
	const d = new Date(unix * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a date input's value; null while it is incomplete. */
export function fromDateInput(value: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!m) {
		return null;
	}
	return Math.floor(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() / 1000);
}

/** "a", "a and b", "a, b and c" (or "or"). */
export function listWords(words: readonly string[], conj: "and" | "or"): string {
	if (words.length <= 1) {
		return words[0] ?? "";
	}
	return `${words.slice(0, -1).join(", ")} ${conj} ${words[words.length - 1]}`;
}

function bpmWords(min: number | null, max: number | null): string | null {
	if (min !== null && max !== null) {
		return min === max ? `at ${min} BPM` : `at ${min}–${max} BPM`;
	}
	if (min !== null) {
		return `at ${min} BPM or faster`;
	}
	return max === null ? null : `at ${max} BPM or slower`;
}

function addedWords(rule: AddedRule | null, formatDate: (unix: number) => string): string | null {
	if (rule === null) {
		return null;
	}
	if (rule.kind === "within") {
		const unit = rule.amount === 1 ? rule.unit.slice(0, -1) : rule.unit;
		return rule.amount === 1
			? `added in the last ${unit}`
			: `added in the last ${rule.amount} ${unit}`;
	}
	return rule.kind === "after"
		? `added on or after ${formatDate(rule.date)}`
		: `added before ${formatDate(rule.date)}`;
}

const shortDate = (unix: number) =>
	new Date(unix * 1000).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});

/** Which group a tag is in: songs must have all, at least one, or none of the group's tags. */
export type TagRole = "all" | "any" | "none";

export const ROLE_FIELD = { all: "allTags", any: "anyTags", none: "noneTags" } as const;

/** The group a tag is in, ignoring case; null when it is in none. */
export function roleOf(r: SmartRules, tag: string): TagRole | null {
	const t = tag.toLowerCase();
	const roles: TagRole[] = ["all", "any", "none"];
	return roles.find((role) => r[ROLE_FIELD[role]].some((x) => x.toLowerCase() === t)) ?? null;
}

/** Puts a tag in one group, taking it out of the others (a tag cannot be both in and out). */
export function placeTag(r: SmartRules, tag: string, role: TagRole): SmartRules {
	const t = tag.toLowerCase();
	const drop = (names: readonly string[]) => names.filter((x) => x.toLowerCase() !== t);
	const next = {
		...r,
		allTags: drop(r.allTags),
		anyTags: drop(r.anyTags),
		noneTags: drop(r.noneTags),
	};
	next[ROLE_FIELD[role]] = [...next[ROLE_FIELD[role]], tag];
	return next;
}

export function removeTag(r: SmartRules, tag: string): SmartRules {
	const drop = (names: readonly string[]) => names.filter((x) => x !== tag);
	return { ...r, allTags: drop(r.allTags), anyTags: drop(r.anyTags), noneTags: drop(r.noneTags) };
}

/** A filter on something other than tags. */
export type FilterKind = "added" | "bpm";

/**
 * Filters on data that only this device has. The rules are shared, but each device counts them
 * over its own data, so the same playlist can list different songs elsewhere. "Added" is when
 * the song reached this device; tags and tempo are shared.
 */
export const DEVICE_ONLY_FILTERS: Record<FilterKind, boolean> = { added: true, bpm: false };

/** A piece of the rule sentence: plain words, a tag in its group's colours, or a filter. */
export type Part =
	| { text: string }
	| { tag: string; role: TagRole }
	| { filter: FilterKind; text: string };

function tagParts(names: readonly string[], role: TagRole, conj: "and" | "or"): Part[] {
	return names.flatMap((tag, i) => {
		const sep = i === 0 ? [] : [{ text: i === names.length - 1 ? ` ${conj} ` : ", " }];
		return [...sep, { tag, role }];
	});
}

/** The rules read back as one sentence, in pieces so tags can be drawn as chips. */
export function describeParts(
	r: SmartRules,
	formatDate: (unix: number) => string = shortDate,
): Part[] {
	const segments: Part[][] = [];
	if (r.allTags.length > 0 || r.anyTags.length > 0) {
		const seg: Part[] = [{ text: "tagged " }, ...tagParts(r.allTags, "all", "and")];
		if (r.anyTags.length > 0) {
			seg.push({ text: r.allTags.length > 0 ? " and at least one of " : "" });
			seg.push(...tagParts(r.anyTags, "any", "or"));
		}
		segments.push(seg);
	}
	if (r.noneTags.length > 0) {
		segments.push([{ text: "not tagged " }, ...tagParts(r.noneTags, "none", "or")]);
	}
	const added = addedWords(r.added, formatDate);
	if (added) {
		segments.push([{ filter: "added", text: added }]);
	}
	const bpm = bpmWords(r.bpmMin, r.bpmMax);
	if (bpm) {
		segments.push([{ filter: "bpm", text: bpm }]);
	}
	if (segments.length === 0) {
		return [{ text: "Every song in the library" }];
	}
	return [
		{ text: "Songs " },
		...segments.flatMap((seg, i) => (i === 0 ? seg : [{ text: ", " }, ...seg])),
	].filter((p) => !("text" in p) || "filter" in p || p.text !== "");
}

/** The rules as one plain sentence, for the list of smart playlists. */
export function describeRules(
	r: SmartRules,
	formatDate: (unix: number) => string = shortDate,
): string {
	return describeParts(r, formatDate)
		.map((p) => ("tag" in p ? ruleTagLabel(p.tag) : p.text))
		.join("");
}
