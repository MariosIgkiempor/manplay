import type { FsEntry } from "#/lib/api.ts";
import { joinPath } from "#/lib/fs-path.ts";

export interface TreeRow {
	entry: FsEntry;
	path: string;
	/** Folder this row is listed in. */
	parent: string;
	depth: number;
}

/**
 * Flattens folder listings into the rows a tree view shows: `base`'s entries, with the contents
 * of every expanded folder directly below it. A folder whose listing has not loaded yet shows
 * no children (yet).
 */
export function flattenTree(
	base: string,
	listings: ReadonlyMap<string, readonly FsEntry[]>,
	expanded: ReadonlySet<string>,
	sort?: FileSort,
): TreeRow[] {
	const rows: TreeRow[] = [];
	const walk = (dir: string, depth: number) => {
		const entries = listings.get(dir) ?? [];
		for (const entry of sort ? sortEntries(entries, sort) : entries) {
			const path = joinPath(dir, entry.name);
			rows.push({ entry, path, parent: dir, depth });
			if (entry.isDir && expanded.has(path)) {
				walk(path, depth + 1);
			}
		}
	};
	walk(base, 0);
	return rows;
}

export type FileSortKey = "name" | "size" | "modified";

export interface FileSort {
	key: FileSortKey;
	desc: boolean;
}

export const DEFAULT_FILE_SORT: FileSort = { key: "name", desc: false };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Folders first, then by `sort`. Names compare the way Finder does: case-insensitive, with
 * numbers by value ("Track 2" before "Track 10"). Ties fall back to the name.
 */
export function sortEntries(entries: readonly FsEntry[], sort: FileSort): FsEntry[] {
	const dir = sort.desc ? -1 : 1;
	const by = (a: FsEntry, b: FsEntry): number => {
		if (sort.key === "size" && a.size !== b.size) {
			return a.size - b.size;
		}
		if (sort.key === "modified" && a.modified !== b.modified) {
			return (a.modified ?? 0) - (b.modified ?? 0);
		}
		return collator.compare(a.name, b.name);
	};
	return [...entries].sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : dir * by(a, b)));
}

/** The name contains `query`, ignoring case and accents. */
export function nameMatches(name: string, query: string): boolean {
	const fold = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
	return query.trim() === "" || fold(name).includes(fold(query.trim()));
}

/**
 * Rows whose name matches `query`, plus the open folders they sit in so the tree still reads.
 * An empty query keeps everything.
 */
export function filterRows(rows: readonly TreeRow[], query: string): TreeRow[] {
	if (query.trim() === "") {
		return [...rows];
	}
	const parentOf = new Map(rows.map((r) => [r.path, r.parent]));
	const keep = new Set<string>();
	for (const r of rows) {
		if (!nameMatches(r.entry.name, query)) {
			continue;
		}
		keep.add(r.path);
		for (let p = r.parent; parentOf.has(p) && !keep.has(p); p = parentOf.get(p) ?? "") {
			keep.add(p);
		}
	}
	return rows.filter((r) => keep.has(r.path));
}

/** Drops `paths` and everything under them (after they were moved, renamed or deleted). */
export function forgetPaths(expanded: ReadonlySet<string>, paths: readonly string[]): Set<string> {
	const gone = (p: string) =>
		paths.some((g) => p === g || p.startsWith(`${g}/`) || p.startsWith(`${g}\\`));
	return new Set([...expanded].filter((p) => !gone(p)));
}

/** The row `delta` steps from `from` (the first row when nothing is current); stays in range. */
export function stepFrom(
	visible: readonly string[],
	from: string | null | undefined,
	delta: 1 | -1,
): string | null {
	if (visible.length === 0) {
		return null;
	}
	const i = from == null ? -1 : visible.indexOf(from);
	if (i === -1) {
		return visible[delta === 1 ? 0 : visible.length - 1] ?? null;
	}
	return visible[Math.min(visible.length - 1, Math.max(0, i + delta))] ?? null;
}

/** The next (or previous) flagged row after `from`, wrapping around; `null` if none are flagged. */
export function nextFlagged(
	visible: readonly string[],
	flagged: ReadonlySet<string>,
	from: string | null | undefined,
	delta: 1 | -1,
): string | null {
	const start = from == null ? -1 : visible.indexOf(from);
	for (let step = 1; step <= visible.length; step += 1) {
		const base = start === -1 && delta === -1 ? visible.length : start;
		const p = visible[(((base + delta * step) % visible.length) + visible.length) % visible.length];
		if (p !== undefined && flagged.has(p)) {
			return p;
		}
	}
	return null;
}
