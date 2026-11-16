import type { DuplicateGroup } from "#/lib/api.ts";

/** Files beyond the first of each group: what is stored more than once. */
export function extraCopies(groups: readonly DuplicateGroup[]): number {
	return groups.reduce((n, g) => n + g.tracks.length - 1, 0);
}
