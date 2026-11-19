import { joinPath } from "#/lib/fs-path.ts";

/** One folder in the picker's tree. */
export interface PickRow {
	path: string;
	name: string;
	depth: number;
	/** Its subfolders are listed (expanded) under it. */
	open: boolean;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/**
 * The folders in `dir` (and in any folder expanded under it) as visible rows, depth first.
 * `listed` holds each listed folder's subfolder names; a filter keeps only names containing it.
 */
export function pickRows(
	dir: string,
	listed: ReadonlyMap<string, readonly string[]>,
	expanded: ReadonlySet<string>,
	filter: string,
): PickRow[] {
	const needle = filter.trim().toLowerCase();
	const out: PickRow[] = [];
	const walk = (at: string, depth: number) => {
		for (const name of [...(listed.get(at) ?? [])].sort(byName)) {
			const path = joinPath(at, name);
			const open = expanded.has(path);
			if (needle === "" || name.toLowerCase().includes(needle)) {
				out.push({ path, name, depth, open });
			}
			if (open) {
				walk(path, depth + 1);
			}
		}
	};
	walk(dir, 0);
	return out;
}
