import { useSyncExternalStore } from "react";

// Whether the BPM and key analysis drawer is open. Opened from the library header and the
// status bar, rendered once in the app shell.
let open = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
	open = next;
	for (const l of listeners) {
		l();
	}
}

export const openAnalysisDrawer = () => set(true);
export const closeAnalysisDrawer = () => set(false);

export function useAnalysisDrawerOpen(): boolean {
	return useSyncExternalStore(
		(l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		() => open,
		() => false,
	);
}
