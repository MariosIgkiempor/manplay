import { useCallback, useEffect, useState } from "react";

/** Items shown at first, and added each time the end of the list comes near. */
export const PAGE_SIZE = 200;

/** The first `limit` items, and whether more are left: one page of a progressively shown list. */
export function firstPage<T>(items: readonly T[], limit: number): { shown: T[]; more: boolean } {
	return { shown: items.slice(0, limit), more: items.length > limit };
}

/**
 * Shows a long list a page at a time: the first page at once, the next as the end comes into
 * view (see `LoadMore`). Starts over when `keyOf` gives a different sequence, e.g. a new search
 * or sort, but not when the same items arrive in a new array.
 */
export function useProgressive<T>(
	items: readonly T[],
	keyOf: (item: T) => string | number,
	pageSize = PAGE_SIZE,
) {
	const [limit, setLimit] = useState(pageSize);
	const identity = items.map(keyOf).join("\u0000");
	// biome-ignore lint/correctness/useExhaustiveDependencies: start over only when the sequence changes
	useEffect(() => {
		setLimit(pageSize);
	}, [identity, pageSize]);
	const { shown, more } = firstPage(items, limit);
	const loadMore = useCallback(() => setLimit((n) => n + pageSize), [pageSize]);
	/** Draws whole pages until item `index` is among them. */
	const showUpTo = useCallback(
		(index: number) => setLimit((n) => Math.max(n, (Math.floor(index / pageSize) + 1) * pageSize)),
		[pageSize],
	);
	return { shown, more, loadMore, showUpTo };
}
