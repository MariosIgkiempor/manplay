import { useCallback, useMemo, useState } from "react";
import type { Track } from "#/lib/api.ts";
import { applyClick, EMPTY_SELECTION, type Selection } from "#/lib/selection.ts";

export interface ClickModifiers {
	shiftKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
}

export interface TrackSelection {
	/** Selected ids that are still present in the list. */
	selected: ReadonlySet<number>;
	click: (id: number, mods: ClickModifiers) => void;
	toggle: (id: number) => void;
	selectAll: () => void;
	clear: () => void;
}

/** Finder-style multi-select over `tracks` (order matters for shift ranges). */
export function useTrackSelection(tracks: readonly Track[]): TrackSelection {
	const [state, setState] = useState<Selection>(EMPTY_SELECTION);
	const ids = useMemo(() => tracks.map((t) => t.id), [tracks]);

	const selected = useMemo(() => {
		const present = new Set(ids);
		return new Set([...state.selected].filter((id) => present.has(id)));
	}, [ids, state.selected]);

	const click = useCallback(
		(id: number, mods: ClickModifiers) =>
			setState((prev) =>
				applyClick(prev, ids, id, { shift: mods.shiftKey, toggle: mods.metaKey || mods.ctrlKey }),
			),
		[ids],
	);
	const toggle = useCallback(
		(id: number) => setState((prev) => applyClick(prev, ids, id, { shift: false, toggle: true })),
		[ids],
	);
	const selectAll = useCallback(() => setState({ selected: new Set(ids), anchor: null }), [ids]);
	const clear = useCallback(() => setState(EMPTY_SELECTION), []);

	return { selected, click, toggle, selectAll, clear };
}
