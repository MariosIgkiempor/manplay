import type { UndoEntry } from "#/context/undo-context.ts";
import { fsMove, fsRename, fsTrash } from "#/lib/api.ts";
import { joinPath, parentPath } from "#/lib/fs-path.ts";

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Entry that moves `paths` (now inside `dest`) back to the folders they came from. */
export function undoMove(paths: string[], dest: string): UndoEntry {
	const moved = paths.filter((p) => parentPath(p) !== dest);
	return {
		label: moved.length === 1 ? `Move “${baseName(moved[0] ?? "")}”` : `Move ${moved.length} items`,
		run: async () => {
			const byParent = new Map<string, string[]>();
			for (const p of moved) {
				const parent = parentPath(p);
				byParent.set(parent, [...(byParent.get(parent) ?? []), joinPath(dest, baseName(p))]);
			}
			for (const [parent, now] of byParent) {
				await fsMove(now, parent);
			}
		},
	};
}

/** Entry that puts the new copies in the Trash. */
export function undoCopy(created: string[]): UndoEntry {
	return {
		label:
			created.length === 1
				? `Copy “${baseName(created[0] ?? "")}”`
				: `Copy of ${created.length} items`,
		run: () => fsTrash(created),
	};
}

export function undoRename(from: string, to: string): UndoEntry {
	return {
		label: `Rename “${baseName(from)}”`,
		run: async () => {
			await fsRename(to, baseName(from));
		},
	};
}

export function undoMakeDir(created: string): UndoEntry {
	return { label: `New folder “${baseName(created)}”`, run: () => fsTrash([created]) };
}
