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
): TreeRow[] {
	const rows: TreeRow[] = [];
	const walk = (dir: string, depth: number) => {
		for (const entry of listings.get(dir) ?? []) {
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
