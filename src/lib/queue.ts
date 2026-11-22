/**
 * The play queue's edits: songs slotted in right after the playing one, or added at the end. A
 * song already waiting later in the queue moves rather than playing twice.
 */

interface Identified {
	id: number;
}

/** `queue` with `songs` right after position `index`, the playing song. */
export function withNext<T extends Identified>(
	queue: readonly T[],
	index: number,
	songs: readonly T[],
): T[] {
	const ids = new Set(songs.map((s) => s.id));
	const head = queue.slice(0, index + 1);
	const tail = queue.slice(index + 1).filter((t) => !ids.has(t.id));
	return [...head, ...songs.filter((s) => !head.some((h) => h.id === s.id)), ...tail];
}

/** `queue` with `songs` at the end, after position `index`, the playing song. */
export function withAdded<T extends Identified>(
	queue: readonly T[],
	index: number,
	songs: readonly T[],
): T[] {
	const ids = new Set(songs.map((s) => s.id));
	const head = queue.slice(0, index + 1);
	const tail = queue.slice(index + 1).filter((t) => !ids.has(t.id));
	return [...head, ...tail, ...songs.filter((s) => !head.some((h) => h.id === s.id))];
}
