export interface Selection {
	selected: ReadonlySet<number>;
	/** Where shift-click ranges start from. */
	anchor: number | null;
}

export interface Modifiers {
	shift: boolean;
	/** Cmd on macOS, Ctrl elsewhere. */
	toggle: boolean;
}

export const EMPTY_SELECTION: Selection = { selected: new Set(), anchor: null };

/**
 * Finder-style click selection over an ordered list of ids:
 * plain click selects one, cmd/ctrl-click toggles one, shift-click selects the
 * range from the anchor (adding to the selection when cmd/ctrl is also held).
 */
export function applyClick(
	prev: Selection,
	ids: readonly number[],
	id: number,
	mods: Modifiers,
): Selection {
	if (mods.shift && prev.anchor !== null) {
		const from = ids.indexOf(prev.anchor);
		const to = ids.indexOf(id);
		if (from !== -1 && to !== -1) {
			const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
			const base = mods.toggle ? prev.selected : new Set<number>();
			return { selected: new Set([...base, ...range]), anchor: prev.anchor };
		}
	}
	if (mods.toggle) {
		const next = new Set(prev.selected);
		if (!next.delete(id)) {
			next.add(id);
		}
		return { selected: next, anchor: id };
	}
	return { selected: new Set([id]), anchor: id };
}
