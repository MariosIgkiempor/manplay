/**
 * Ranking for the ⌘K command palette: which pages, actions, playlists, tags, artists, albums and
 * songs match what was typed, best first, a few of each.
 */

/** One thing the palette can find. `detail` is the quieter second line, also searched. */
export interface PaletteItem<T> {
	id: string;
	label: string;
	detail: string;
	value: T;
}

/** How well `query` (trimmed, lower-cased) matches an item; 0 is no match. */
export function matchScore(
	item: Pick<PaletteItem<unknown>, "label" | "detail">,
	query: string,
): number {
	if (query === "") {
		return 1;
	}
	const label = item.label.toLowerCase();
	if (label === query) {
		return 5;
	}
	if (label.startsWith(query)) {
		return 4;
	}
	if (label.split(/[\s/()\-–]+/).some((word) => word.startsWith(query))) {
		return 3;
	}
	if (label.includes(query)) {
		return 2;
	}
	return item.detail.toLowerCase().includes(query) ? 1 : 0;
}

/** The items matching `query`, best first (then by name), at most `limit` of them. */
export function rankMatches<T>(
	items: readonly PaletteItem<T>[],
	query: string,
	limit: number,
): PaletteItem<T>[] {
	const q = query.trim().toLowerCase();
	return items
		.map((item) => ({ item, score: matchScore(item, q) }))
		.filter((m) => m.score > 0)
		.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
		.slice(0, limit)
		.map((m) => m.item);
}
