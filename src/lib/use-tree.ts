import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { type FsEntry, fsDirSizes, fsList } from "#/lib/api.ts";
import { type FileSort, flattenTree, forgetPaths, type TreeRow } from "#/lib/tree.ts";

/** Where a tree's folders come from; the library folder unless told otherwise. */
export interface TreeSource {
	/** Keeps this source's listings apart in the query cache. */
	key: string;
	list: (dir: string) => Promise<FsEntry[]>;
	/** Total size of each subfolder of `dir`, by name; asked for apart from the listing. */
	sizes: (dir: string) => Promise<Record<string, number>>;
}

/** The library folder on this computer. */
export const LOCAL_TREE: TreeSource = { key: "fs", list: fsList, sizes: fsDirSizes };

/** A folder shown as a tree: its own entries plus the contents of every expanded subfolder. */
export function useTree(path: string, sort?: FileSort, source: TreeSource = LOCAL_TREE) {
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	// The pane's own folder plus every expanded folder, each listed separately.
	const dirs = [path, ...expanded];
	const lists = useQueries({
		queries: dirs.map((d) => ({
			queryKey: [source.key, d],
			queryFn: () => source.list(d),
			retry: false,
		})),
	});
	// Folder sizes take longer than names, so rows show first and fill in as these arrive.
	const sized = useQueries({
		queries: dirs.map((d, i) => ({
			queryKey: [source.key, "sizes", d],
			queryFn: () => source.sizes(d),
			enabled: lists[i]?.data?.some((e) => e.isDir) === true,
			retry: false,
			staleTime: 60_000,
			refetchOnWindowFocus: false,
		})),
	});
	const listings = new Map<string, readonly FsEntry[]>();
	for (const [i, q] of lists.entries()) {
		const dir = dirs[i];
		if (q.data !== undefined && dir !== undefined) {
			const sizes = sized[i]?.data;
			listings.set(
				dir,
				sizes ? q.data.map((e) => (e.isDir ? { ...e, size: sizes[e.name] ?? 0 } : e)) : q.data,
			);
		}
	}
	const rows = flattenTree(path, listings, expanded, sort);

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
