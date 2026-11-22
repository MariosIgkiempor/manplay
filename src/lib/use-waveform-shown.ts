import { useSyncExternalStore } from "react";

const KEY = "manplay.player-waveform";

function read(): boolean {
	try {
		return localStorage.getItem(KEY) !== "0";
	} catch {
		return true;
	}
}

let shown = read();
const listeners = new Set<() => void>();

/** Shows or hides the big waveform (the grid editor) above the player bar. */
export function setWaveformShown(next: boolean) {
	shown = next;
	try {
		localStorage.setItem(KEY, next ? "1" : "0");
	} catch {
		// Not remembered; the switch still works for now.
	}
	for (const listener of listeners) {
		listener();
	}
}

/**
 * Whether the big waveform above the player bar is shown; remembered on this computer. Shared, so
 * "Edit grid & cues…" can open it from a menu.
 */
export function useWaveformShown(): boolean {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => shown,
		// Rendered ahead of the app's start, before this computer's choice can be read.
		() => true,
	);
}
