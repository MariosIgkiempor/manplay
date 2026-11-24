/** Where a picked name goes: a playlist the song joins, or a tag the song gets. */
export type PickKind = "playlist" | "tag";

/** One choice in the picker: an existing playlist or tag, or a new one named by the query. */
export interface PickRow {
	kind: PickKind;
	name: string;
	/** Songs in it now; null for one the pick would create. */
	count: number | null;
	isNew: boolean;
	/** The song is in it already (a tag it has, or one just picked). */
	checked: boolean;
}

export interface PickSource {
	name: string;
	count: number;
	checked: boolean;
}

/** At most this many of each kind show; typing narrows them. */
export const PICK_LIMIT = 8;

/**
 * The picker's rows for `query`: playlists then tags whose names hold it (any case), each list
 * cut to `PICK_LIMIT`, then a row to create a playlist and one to create a tag of that name, for
 * whichever kind has no exact match.
 */
export function pickRows(
	query: string,
	playlists: readonly PickSource[],
	tags: readonly PickSource[],
): PickRow[] {
	const q = query.trim();
	const lower = q.toLowerCase();
	const rowsOf = (kind: PickKind, sources: readonly PickSource[]): PickRow[] =>
		sources
			.filter((s) => s.name.toLowerCase().includes(lower))
			.slice(0, PICK_LIMIT)
			.map((s) => ({ kind, name: s.name, count: s.count, isNew: false, checked: s.checked }));
	const exact = (sources: readonly PickSource[]) =>
		sources.some((s) => s.name.toLowerCase() === lower);
	const create = (kind: PickKind, sources: readonly PickSource[]): PickRow[] =>
		q === "" || exact(sources) ? [] : [{ kind, name: q, count: null, isNew: true, checked: false }];
	return [
		...rowsOf("playlist", playlists),
		...rowsOf("tag", tags),
		...create("playlist", playlists),
		...create("tag", tags),
	];
}

/** Marks the playing song in the player bar, where the picker opens when the pointer is away. */
export const NOW_PLAYING_ATTRIBUTE = "data-now-playing";

/** What the picker's field does with a key: move through the rows, pick one, or close. */
export type PickerKey = { kind: "step"; by: -1 | 1 } | { kind: "pick" } | { kind: "escape" } | null;

/** The arrows step, and Ctrl+J/K or Ctrl+N/P as in Vim; Enter picks; Escape clears or closes. */
export function pickerKey(e: { key: string; code: string; ctrlKey: boolean }): PickerKey {
	if (e.key === "ArrowDown" || (e.ctrlKey && (e.code === "KeyJ" || e.code === "KeyN"))) {
		return { kind: "step", by: 1 };
	}
	if (e.key === "ArrowUp" || (e.ctrlKey && (e.code === "KeyK" || e.code === "KeyP"))) {
		return { kind: "step", by: -1 };
	}
	if (e.key === "Enter") {
		return { kind: "pick" };
	}
	return e.key === "Escape" ? { kind: "escape" } : null;
}
