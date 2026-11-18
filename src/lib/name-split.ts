import { joinNames, splitNames } from "#/lib/names.ts";

/**
 * Joiners people type between artists: commas, `&`, `+`, `feat.` and friends, a spaced `x`,
 * `vs`, `and`. A slash only counts with spaces around it, so `AC/DC` stays whole.
 */
const CREDIT_JOINER =
	/\s*,\s*|\s+&\s+|\s*&\s*|\s*\+\s*|\s+(?:feat\.?|ft\.?|featuring|vs\.?|x|and|with)\s+|\s+\/\s+/i;

export interface NameSplit {
	/** The credit as written, e.g. `Simon & Garfunkel`. Also what a dismissal is keyed on. */
	name: string;
	/** What it would become, e.g. `Simon`, `Garfunkel`. */
	parts: string[];
}

export function dismissalKey(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * One entry per `;`-separated name in `value` that looks like several artists in one, unless
 * its name was dismissed (an artist whose real name holds a joiner).
 */
export function suggestSplits(value: string, dismissed: ReadonlySet<string>): NameSplit[] {
	return splitNames(value).flatMap((name) => {
		if (dismissed.has(dismissalKey(name))) {
			return [];
		}
		const parts = name
			.split(CREDIT_JOINER)
			.map((part) => part.trim())
			.filter((part) => part !== "");
		return parts.length > 1 ? [{ name, parts }] : [];
	});
}

/** `value` with `split.name` replaced by its parts, other names untouched. */
export function applySplit(value: string, split: NameSplit): string {
	return joinNames(
		splitNames(value).flatMap((name) => (name === split.name ? split.parts : [name])),
	);
}
