import { useSyncExternalStore } from "react";

let artVersion = 0;
const artListeners = new Set<() => void>();

/** Makes every cover reload, after cover art was written to files. */
export function bumpArt() {
	artVersion += 1;
	for (const l of artListeners) {
		l();
	}
}

/** Changes whenever covers should reload; append it to art URLs. */
export function useArtVersion(): number {
	return useSyncExternalStore(
		(l) => {
			artListeners.add(l);
			return () => artListeners.delete(l);
		},
		() => artVersion,
		() => artVersion,
	);
}
