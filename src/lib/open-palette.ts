const listeners = new Set<() => void>();

/** Opens Search everything (⌘K) from code outside the palette, e.g. ⌘F on a page with no search. */
export function openPalette() {
	for (const listener of listeners) {
		listener();
	}
}

/** Listens for `openPalette`; the palette itself is the one listener. */
export function onOpenPalette(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
