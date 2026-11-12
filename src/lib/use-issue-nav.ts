import { type Dispatch, type RefObject, type SetStateAction, useState } from "react";
import type { IssueIndex } from "#/lib/audit.ts";
import type { Selection } from "#/lib/selection.ts";
import { nextFlagged, stepFrom } from "#/lib/tree.ts";

interface Options {
	visible: readonly string[];
	health: IssueIndex;
	/** Where shift-click ranges start; the keyboard's position when nothing single is selected. */
	anchor: string | null;
	selected: ReadonlySet<string>;
	setSel: Dispatch<SetStateAction<Selection<string>>>;
	onFix: (scopes: string[]) => unknown;
	/** Focused again when a card closes, so the arrow keys keep working. */
	paneRef: RefObject<HTMLElement | null>;
}

/** Keyboard navigation between rows and their issue cards: arrows, `[`/`]`, `i`, `f`. */
export function useIssueNav({
	visible,
	health,
	anchor,
	selected,
	setSel,
	onFix,
	paneRef,
}: Options) {
	/** Row whose issue card is open. */
	const [issueOpen, setIssueOpen] = useState<string | null>(null);
	const only = selected.size === 1 ? [...selected][0] : undefined;
	const current = only ?? anchor;
	const flagged = new Set([...health.byPath.keys(), ...health.folders.keys()]);

	const selectRow = (p: string | null) => {
		setSel(p === null ? (prev) => prev : { selected: new Set([p]), anchor: p });
		requestAnimationFrame(() =>
			document
				.querySelector(`[data-row-path="${CSS.escape(p ?? "")}"]`)
				?.scrollIntoView({ block: "nearest" }),
		);
	};

	return {
		issueOpen,
		toggleIssue: (path: string, open: boolean) => {
			setIssueOpen(open ? path : null);
			paneRef.current?.focus();
		},
		/** Handlers for the pane's key table. */
		keys: {
			next: () => selectRow(stepFrom(visible, current, 1)),
			prev: () => selectRow(stepFrom(visible, current, -1)),
			nextIssue: () => selectRow(nextFlagged(visible, flagged, current, 1)),
			prevIssue: () => selectRow(nextFlagged(visible, flagged, current, -1)),
			issues: () => {
				setIssueOpen(only !== undefined && flagged.has(only) ? only : null);
			},
			fix: () => onFix([...selected]),
		},
	};
}
