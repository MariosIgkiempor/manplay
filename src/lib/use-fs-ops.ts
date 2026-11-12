import { confirmTrash } from "#/lib/api.ts";
import { useFsCopy, useFsMakeDir, useFsMove, useFsRename, useFsTrash } from "#/lib/queries.ts";

/** Cut/copied items waiting to be pasted; shared by both panes. */
export interface FsClipboard {
	mode: "cut" | "copy";
	paths: string[];
}

interface Deps {
	clipboard: FsClipboard | null;
	setClipboard: (c: FsClipboard | null) => void;
	setError: (message: string | null) => void;
	/** Expands or collapses a folder in the tree. */
	setOpen: (dir: string, open: boolean) => void;
	/** Forgets tree state for paths that moved or were deleted. */
	forget: (paths: string[]) => void;
	clearSelection: () => void;
}

/** The file operations of a pane: each reports failures through `setError` and refreshes lists. */
export function useFsOps({
	clipboard,
	setClipboard,
	setError,
	setOpen,
	forget,
	clearSelection,
}: Deps) {
	const makeDir = useFsMakeDir();
	const rename = useFsRename();
	const move = useFsMove();
	const copy = useFsCopy();
	const trash = useFsTrash();
	const busy =
		makeDir.isPending || rename.isPending || move.isPending || copy.isPending || trash.isPending;
	const fail = (e: unknown) => setError(String(e));

	const runMove = (paths: string[], dest: string) => {
		setError(null);
		move.mutate(
			{ paths, dest },
			{
				onError: fail,
				onSuccess: () => {
					forget(paths);
					setOpen(dest, true);
					clearSelection();
				},
			},
		);
	};

	const paste = (dest: string) => {
		if (clipboard === null) {
			return;
		}
		setError(null);
		setOpen(dest, true);
		if (clipboard.mode === "copy") {
			copy.mutate({ paths: clipboard.paths, dest }, { onError: fail });
			return;
		}
		move.mutate(
			{ paths: clipboard.paths, dest },
			{
				onError: fail,
				onSuccess: () => {
					forget(clipboard.paths);
					setClipboard(null);
				},
			},
		);
	};

	const remove = async (paths: string[]) => {
		const names = paths.map((p) => p.split(/[\\/]/).pop() ?? p);
		if (paths.length === 0 || !(await confirmTrash(names))) {
			return;
		}
		setError(null);
		trash.mutate(paths, {
			onError: fail,
			onSuccess: () => {
				forget(paths);
				clearSelection();
			},
		});
	};

	return { makeDir, rename, busy, fail, runMove, paste, remove };
}
