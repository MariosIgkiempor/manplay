import { createContext, useContext } from "react";
import type { SyncProgress } from "#/lib/api.ts";

/** Live progress of running syncs, keyed by target id. Empty when idle. */
export const SyncProgressContext = createContext<ReadonlyMap<number, SyncProgress>>(new Map());

export function useSyncProgress(): ReadonlyMap<number, SyncProgress> {
	return useContext(SyncProgressContext);
}
