import { createContext, useContext } from "react";

/** One undoable operation: what it was called, and how to reverse it. */
export interface UndoEntry {
	label: string;
	run: () => Promise<void>;
}

export interface UndoApi {
	record: (entry: UndoEntry) => void;
	undo: () => Promise<void>;
	canUndo: boolean;
	/** Name of the operation Undo would reverse. */
	label: string | null;
}

export const UndoContext = createContext<UndoApi | null>(null);

export function useUndo(): UndoApi {
	const api = useContext(UndoContext);
	if (api === null) {
		throw new Error("useUndo must be used inside UndoProvider");
	}
	return api;
}
