import { useSyncExternalStore } from "react";
import { TRASH } from "#/lib/platform.ts";

/**
 * A yes/no question asked from anywhere (a menu, a keyboard shortcut): {@link askConfirm} shows
 * the app's own dialog and resolves to the answer. The dialog is `ConfirmHost`, mounted once in
 * the shell. An action that starts from a button uses `ConfirmButton` instead and needs no dialog.
 */
export interface ConfirmQuestion {
	title: string;
	/** What happens on yes, a line each. */
	lines?: readonly string[];
	confirmLabel: string;
	destructive?: boolean;
}

interface Pending {
	question: ConfirmQuestion;
	resolve: (confirmed: boolean) => void;
}

let pending: Pending | null = null;
const listeners = new Set<() => void>();

function setPending(next: Pending | null) {
	pending = next;
	for (const listener of listeners) {
		listener();
	}
}

/** Asks the question. Resolves to true only when the user confirms. */
export function askConfirm(question: ConfirmQuestion): Promise<boolean> {
	return new Promise((resolve) => {
		// One question shows at a time; a second one takes the first one's place, unanswered.
		pending?.resolve(false);
		setPending({ question, resolve });
	});
}

/** Closes the open question with the user's answer. */
export function answerConfirm(confirmed: boolean): void {
	const answered = pending;
	setPending(null);
	answered?.resolve(confirmed);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The question being asked, or null while there is none. */
export function usePendingConfirm(): ConfirmQuestion | null {
	return useSyncExternalStore(
		subscribe,
		() => pending?.question ?? null,
		() => null,
	);
}

/** Asks before files or folders go to the Trash (the Recycle Bin on Windows). */
export function confirmTrash(names: readonly string[]): Promise<boolean> {
	const what = names.length === 1 ? `“${names[0]}”` : `${names.length} items`;
	return askConfirm({
		title: `Move ${what} to the ${TRASH}?`,
		confirmLabel: `Move to ${TRASH}`,
		destructive: true,
	});
}

/** Asks before kept songs' files go to the Trash so the songs stream instead. */
export function confirmStreamOnly(count: number): Promise<boolean> {
	const what = count === 1 ? "this song" : `${count.toLocaleString()} songs`;
	return askConfirm({
		title: `Stream ${what} only?`,
		lines: [
			`${count === 1 ? "Its file goes" : "Their files go"} to the ${TRASH}.`,
			"The songs stay in the library and play from the shared library's destination.",
			"A song the destination does not have yet is left kept.",
		],
		confirmLabel: "Stream only",
		destructive: true,
	});
}

/** Asks before library issues are fixed; `lines` say what will change. */
export function confirmFix(lines: readonly string[]): Promise<boolean> {
	return askConfirm({ title: "Fix library issues?", lines, confirmLabel: "Fix" });
}
