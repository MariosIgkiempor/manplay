import { useRef } from "react";
import { nameMatches, type TreeRow } from "#/lib/tree.ts";

/** Row whose name contains `q`, searching from `from` (itself included when `delta` is 0), wrapping. */
export function findByName(
	rows: readonly TreeRow[],
	q: string,
	from: string | null,
	delta: 0 | 1 | -1,
): string | undefined {
	const n = rows.length;
	if (q.trim() === "" || n === 0) {
		return undefined;
	}
	const start = from === null ? -1 : rows.findIndex((r) => r.path === from);
	for (let step = delta === 0 ? 0 : 1; step <= n; step += 1) {
		const i = (((start + (delta === -1 ? -step : step)) % n) + n) % n;
		const r = rows[i];
		if (r && nameMatches(r.entry.name, q)) {
			return r.path;
		}
	}
	return undefined;
}

/** `l`: open a closed folder; on an open one, step into its first child. */
export function expandOrEnter(
	row: TreeRow | undefined,
	rows: readonly TreeRow[],
	expanded: ReadonlySet<string>,
	setOpen: (dir: string, open: boolean) => void,
	jumpTo: (path: string) => void,
) {
	if (!row?.entry.isDir) {
		return;
	}
	if (!expanded.has(row.path)) {
		setOpen(row.path, true);
		return;
	}
	const next = rows[rows.indexOf(row) + 1];
	if (next?.parent === row.path) {
		jumpTo(next.path);
	}
}

/** `n`/`N` through the rows matching the pane's filter, and the `gg` double-tap. */
export function useVimNav({
	rows,
	current,
	jumpTo,
	query,
}: {
	rows: readonly TreeRow[];
	/** Row the keyboard is on. */
	current: string | null;
	jumpTo: (path: string | null | undefined) => void;
	/** Text in the filter box. */
	query: string;
}) {
	const gPending = useRef(false);
	return {
		stepSearch: (delta: 1 | -1) => jumpTo(findByName(rows, query, current, delta)),
		/** Call with `false` on any other key so only two quick `g`s count. */
		g: (top: () => void) => {
			if (gPending.current) {
				gPending.current = false;
				top();
				return;
			}
			gPending.current = true;
			setTimeout(() => {
				gPending.current = false;
			}, 800);
		},
		resetG: () => {
			gPending.current = false;
		},
	};
}
