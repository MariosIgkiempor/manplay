/** A drawn song list that can put its cursor on one of its songs. */
export interface RevealTarget {
	has: (trackId: number) => boolean;
	/** On the page, not in the side panel; the page's list is tried first. */
	inPage: () => boolean;
	reveal: (trackId: number) => void;
}

const targets = new Set<RevealTarget>();

/** Lets a song list take part in `revealTrack` while it is drawn. */
export function onRevealTrack(target: RevealTarget): () => void {
	targets.add(target);
	return () => targets.delete(target);
}

/**
 * Scrolls the page's song list (else the side panel's) to a song and puts the cursor on it.
 * False when no list on screen holds it.
 */
export function revealTrack(trackId: number): boolean {
	const holding = [...targets].filter((t) => t.has(trackId));
	const target = holding.find((t) => t.inPage()) ?? holding[0];
	target?.reveal(trackId);
	return target !== undefined;
}
