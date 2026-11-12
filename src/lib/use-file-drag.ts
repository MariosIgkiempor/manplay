import { type DragEvent, useState } from "react";

const DRAG_TYPE = "application/x-manplay-paths";

interface Options {
	selected: ReadonlySet<string>;
	/** Called when an unselected row starts dragging, so the drag acts on just that row. */
	selectOnly: (path: string) => void;
	onDrop: (paths: string[], dest: string) => void;
}

/** Drag-and-drop of rows onto folders: what is dragged, and which folder is the drop target. */
export function useFileDrag({ selected, selectOnly, onDrop }: Options) {
	const [dropTarget, setDropTarget] = useState<string | null>(null);

	return {
		dropTarget,
		clearDrop: () => setDropTarget(null),
		dragStart: (ev: DragEvent, path: string) => {
			if (!selected.has(path)) {
				selectOnly(path);
			}
			const dragged = selected.has(path) ? [...selected] : [path];
			ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragged));
			ev.dataTransfer.effectAllowed = "move";
		},
		allowDrop: (ev: DragEvent, key: string) => {
			if (ev.dataTransfer.types.includes(DRAG_TYPE)) {
				ev.preventDefault();
				ev.stopPropagation();
				setDropTarget(key);
			}
		},
		dropInto: (ev: DragEvent, dest: string) => {
			ev.preventDefault();
			ev.stopPropagation();
			setDropTarget(null);
			const raw = ev.dataTransfer.getData(DRAG_TYPE);
			const paths = raw === "" ? [] : (JSON.parse(raw) as string[]).filter((p) => p !== dest);
			if (paths.length > 0) {
				onDrop(paths, dest);
			}
		},
	};
}
