import { useCallback, useEffect, useState } from "react";

function load(key: string, fallback: number): number {
	try {
		const n = Number(localStorage.getItem(key));
		return n > 0 ? n : fallback;
	} catch {
		return fallback;
	}
}

/**
 * A pane's width in px, kept between `min` and `max()` and remembered in this browser between
 * launches (a per-device preference, so it is not stored with the library).
 */
export function usePaneWidth({
	key,
	initial,
	min,
	max,
}: {
	key: string;
	initial: number;
	min: number;
	max: () => number;
}) {
	const [width, setWidth] = useState(initial);
	useEffect(() => setWidth(load(key, initial)), [key, initial]);
	const set = useCallback(
		(w: number) => {
			const next = Math.round(Math.max(min, Math.min(w, max())));
			setWidth(next);
			try {
				localStorage.setItem(key, String(next));
			} catch {
				// Not remembered; the width still applies now.
			}
		},
		[key, min, max],
	);
	return [width, set] as const;
}

/** A remembered on/off preference, e.g. whether the sidebar is collapsed. */
export function useStoredFlag(key: string): [boolean, (on: boolean) => void] {
	const [on, setOn] = useState(false);
	useEffect(() => {
		try {
			setOn(localStorage.getItem(key) === "1");
		} catch {
			// Starts off.
		}
	}, [key]);
	const set = useCallback(
		(next: boolean) => {
			setOn(next);
			try {
				localStorage.setItem(key, next ? "1" : "0");
			} catch {
				// Not remembered.
			}
		},
		[key],
	);
	return [on, set];
}
