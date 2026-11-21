/** What an edit is, so a burst of the same edit (taps, arrow presses) undoes as one step. */
export interface EditStep {
	group: string;
	/** `performance.now()` when the edit was made. */
	at: number;
}

/** A value with the edits before it (to undo) and the edits undone (to redo). */
export interface EditHistory<T> {
	past: readonly T[];
	present: T;
	future: readonly T[];
	/** The edit that made `present`, while a burst of the same edit can still join it. */
	last: EditStep | null;
}

/** Edits of one group this close together are one step. */
export const BURST_MS = 2000;
/** Older steps are dropped beyond this many. */
const LIMIT = 200;

export function startHistory<T>(present: T): EditHistory<T> {
	return { past: [], present, future: [], last: null };
}

/** `next` as an edit; nothing changes when it equals what is there. */
export function record<T>(
	history: EditHistory<T>,
	next: T,
	equal: (a: T, b: T) => boolean,
	step: EditStep | null = null,
): EditHistory<T> {
	if (equal(next, history.present)) {
		return history;
	}
	const joins =
		step !== null &&
		history.last !== null &&
		history.last.group === step.group &&
		step.at - history.last.at < BURST_MS;
	return {
		past: joins ? history.past : [...history.past, history.present].slice(-LIMIT),
		present: next,
		future: [],
		last: step,
	};
}

/** Swaps what is there without making an undo step, for the same value described another way. */
export function replacePresent<T>(history: EditHistory<T>, present: T): EditHistory<T> {
	return { ...history, present };
}

export const canUndo = (history: EditHistory<unknown>) => history.past.length > 0;
export const canRedo = (history: EditHistory<unknown>) => history.future.length > 0;

export function undo<T>(history: EditHistory<T>): EditHistory<T> {
	const previous = history.past.at(-1);
	if (previous === undefined) {
		return history;
	}
	return {
		past: history.past.slice(0, -1),
		present: previous,
		future: [history.present, ...history.future],
		last: null,
	};
}

export function redo<T>(history: EditHistory<T>): EditHistory<T> {
	const [next, ...rest] = history.future;
	if (next === undefined) {
		return history;
	}
	return {
		past: [...history.past, history.present],
		present: next,
		future: rest,
		last: null,
	};
}
