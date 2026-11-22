import { type SetStateAction, useCallback, useState } from "react";

function loadFlag(key: string, fallback: boolean): boolean {
	try {
		const stored = localStorage.getItem(key);
		return stored === null ? fallback : stored === "1";
	} catch {
		return fallback;
	}
}

/**
 * An on/off preference remembered in this browser between launches (a per-device choice, so it
 * is not stored with the library).
 */
export function useStoredFlag(
	key: string,
	initial: boolean,
): [boolean, (on: SetStateAction<boolean>) => void] {
	const [on, setOn] = useState(() => loadFlag(key, initial));
	const set = useCallback(
		(change: SetStateAction<boolean>) => {
			setOn((was) => {
				const next = typeof change === "function" ? change(was) : change;
				try {
					localStorage.setItem(key, next ? "1" : "0");
				} catch {
					// Not remembered; the choice still applies now.
				}
				return next;
			});
		},
		[key],
	);
	return [on, set];
}

function loadNumber(key: string, fallback: number): number {
	try {
		const stored = localStorage.getItem(key);
		const n = stored === null ? Number.NaN : Number(stored);
		return Number.isFinite(n) ? n : fallback;
	} catch {
		return fallback;
	}
}

/** A number remembered in this browser between launches, like {@link useStoredFlag}. */
export function useStoredNumber(
	key: string,
	initial: number,
): [number, (n: SetStateAction<number>) => void] {
	const [value, setValue] = useState(() => loadNumber(key, initial));
	const set = useCallback(
		(change: SetStateAction<number>) => {
			setValue((was) => {
				const next = typeof change === "function" ? change(was) : change;
				try {
					localStorage.setItem(key, String(next));
				} catch {
					// Not remembered; the value still applies now.
				}
				return next;
			});
		},
		[key],
	);
	return [value, set];
}
