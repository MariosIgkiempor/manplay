import { parentPath } from "#/lib/fs-path.ts";

/** What a file pane is showing: the library folder, or one destination. */
export type PaneSource = { kind: "library" } | { kind: "remote"; id: number };

export const LIBRARY: PaneSource = { kind: "library" };

export const sameSource = (a: PaneSource, b: PaneSource) =>
	a.kind === b.kind && (a.kind === "library" || (b.kind === "remote" && a.id === b.id));

/** One dragged row. Library paths are absolute; destination paths look like `/folder/file`. */
export interface DragItem {
	path: string;
	name: string;
	isDir: boolean;
}

/** What is being dragged and where it came from. */
export interface DragSession {
	source: PaneSource;
	items: readonly DragItem[];
}

/** A folder something can be dropped into. */
export interface DropDest {
	pane: 0 | 1;
	source: PaneSource;
	path: string;
}

/** Dropping inside one source moves; dropping between the library and a destination copies. */
export type DropOp = "move" | "copy";

/**
 * What dropping `session` onto `dest` would do, or `null` when it cannot be done: dropping a
 * folder into itself, dropping where it already is, or between two different destinations.
 */
export function dropOp(session: DragSession, dest: DropDest): DropOp | null {
	if (!sameSource(session.source, dest.source)) {
		return session.source.kind === "library" || dest.source.kind === "library" ? "copy" : null;
	}
	const intoItself = session.items.some(
		(i) => dest.path === i.path || (i.isDir && dest.path.startsWith(`${i.path}/`)),
	);
	const alreadyThere = session.items.every((i) => parentPath(i.path) === dest.path);
	return intoItself || alreadyThere ? null : "move";
}
