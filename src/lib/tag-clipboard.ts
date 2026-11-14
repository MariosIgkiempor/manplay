import { TAG_GROUPS } from "#/lib/tag-fields.ts";

export type { TagClipboard } from "#/lib/api.ts";

const FOLDER_SAFE = new Set(
	TAG_GROUPS.flatMap((g) => g.fields.filter((f) => f.scope === "both").map((f) => f.id)),
);

/** Fields that make sense on a whole folder (not title, track, BPM, key, ...). */
export function folderSafe(field: string): boolean {
	return FOLDER_SAFE.has(field);
}

/** What pasting onto a folder applies: song-only fields such as title and track are left out. */
export function forTarget(values: Record<string, string>, isDir: boolean): Record<string, string> {
	if (!isDir) {
		return values;
	}
	return Object.fromEntries(Object.entries(values).filter(([id]) => folderSafe(id)));
}
