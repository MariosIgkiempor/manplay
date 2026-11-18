import { useCallback, useSyncExternalStore } from "react";
import { dismissalKey } from "#/lib/name-split.ts";

const STORAGE_KEY = "manplay.dismissedNameSplits";
const listeners = new Set<() => void>();
let cached: ReadonlySet<string> | null = null;

function load(): ReadonlySet<string> {
	try {
		const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
		return new Set(Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : []);
	} catch {
		return new Set();
	}
}

function snapshot(): ReadonlySet<string> {
	cached ??= load();
	return cached;
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function store(next: ReadonlySet<string>) {
	cached = next;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
	} catch {
		// Remembering dismissals is only a convenience.
	}
	for (const listener of listeners) {
		listener();
	}
}

/** Names whose "split into several artists" suggestion was dismissed, kept across launches. */
export function useDismissedSplits() {
	const dismissed = useSyncExternalStore(subscribe, snapshot);
	const dismiss = useCallback(
		(name: string) => store(new Set([...snapshot(), dismissalKey(name)])),
		[],
	);
	return { dismissed, dismiss };
}
