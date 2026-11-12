import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { type FsEntry, fsList } from "#/lib/api.ts";
import { flattenTree, forgetPaths, type TreeRow } from "#/lib/tree.ts";

/** A folder shown as a tree: its own entries plus the contents of every expanded subfolder. */
export function useTree(path: string) {
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	// The pane's own folder plus every expanded folder, each listed separately.
	const dirs = [path, ...expanded];
	const lists = useQueries({
		queries: dirs.map((d) => ({ queryKey: ["fs", d], queryFn: () => fsList(d), retry: false })),
	});
	const listings = new Map<string, readonly FsEntry[]>();
	for (const [i, q] of lists.entries()) {
		const dir = dirs[i];
		if (q.data !== undefined && dir !== undefined) {
			listings.set(dir, q.data);
		}
	}
	const rows = flattenTree(path, listings, expanded);

	const setOpen = (dir: string, open: boolean) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			next[open ? "add" : "delete"](dir);
			return next;
		});

	return {
		/** The pane's own folder listing. */
		listing: lists[0],
		entries: listings.get(path) ?? [],
		rows,
		rowByPath: new Map<string, TreeRow>(rows.map((r) => [r.path, r])),
		expanded,
		isLoading: (dir: string) => lists[dirs.indexOf(dir)]?.isPending === true,
		setOpen,
		/** Collapses and forgets paths (and anything under them) that were moved or deleted. */
		forget: (paths: string[]) => setExpanded((prev) => forgetPaths(prev, paths)),
	};
}
