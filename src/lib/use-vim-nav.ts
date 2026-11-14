import { type RefObject, useRef, useState } from "react";
import type { TreeRow } from "#/lib/tree.ts";

/** Row whose name contains `q`, searching from `from` (itself included when `delta` is 0), wrapping. */
export function findByName(
	rows: readonly TreeRow[],
	q: string,
	from: string | null,
	delta: 0 | 1 | -1,
): string | undefined {
	const needle = q.toLowerCase();
	const n = rows.length;
	if (needle === "" || n === 0) {
		return undefined;
	}
	const start = from === null ? -1 : rows.findIndex((r) => r.path === from);
	for (let step = delta === 0 ? 0 : 1; step <= n; step += 1) {
		const i = (((start + (delta === -1 ? -step : step)) % n) + n) % n;
		if (rows[i]?.entry.name.toLowerCase().includes(needle)) {
			return rows[i]?.path;
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

/** `/` search over the rows shown, `n`/`N` to repeat it, and the `gg` double-tap. */
export function useVimNav({
	rows,
	current,
	jumpTo,
	paneRef,
}: {
	rows: readonly TreeRow[];
	/** Row the keyboard is on. */
	current: string | null;
	jumpTo: (path: string | null | undefined) => void;
	paneRef: RefObject<HTMLElement | null>;
}) {
	/** Text of the open search box; `null` when it is closed. */
	const [searching, setSearching] = useState<string | null>(null);
	const origin = useRef<string | null>(null);
	const last = useRef("");
	const gPending = useRef(false);

	const close = () => {
		setSearching(null);
		requestAnimationFrame(() => paneRef.current?.focus());
	};

	return {
		searching,
		closeSearchBox: () => setSearching(null),
		openSearch: () => {
			origin.current = current;
			setSearching("");
		},
		/** Typing in the box: jump to the first match at or after where the search began. */
		typeSearch: (text: string) => {
			setSearching(text);
			jumpTo(findByName(rows, text, origin.current, 0));
		},
		/** Enter keeps the search for `n`/`N`; Esc drops it. */
		endSearch: (keep: boolean) => {
			if (keep) {
				last.current = searching ?? "";
			}
			close();
		},
		stepSearch: (delta: 1 | -1) => jumpTo(findByName(rows, last.current, current, delta)),
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
