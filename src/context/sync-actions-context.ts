import { createContext, useContext } from "react";

/** The three reviews that move songs between the library and its destinations. */
export type SyncKind = "pull" | "push" | "sync";

/** A review being asked for: `ids` limits it to some destinations, all of them when omitted. */
export interface SyncRequest {
	kind: SyncKind;
	ids: number[] | undefined;
	/** Changes on every request, so asking again starts a fresh review. */
	session: number;
}

export interface SyncActionsApi {
	request: SyncRequest | null;
	start: (kind: SyncKind, ids?: number[]) => void;
	close: () => void;
}

export const SyncActionsContext = createContext<SyncActionsApi | null>(null);

/** Opens the pull, push and sync reviews from anywhere (sidebar, pages, destination panels). */
export function useSyncActions(): SyncActionsApi {
	const ctx = useContext(SyncActionsContext);
	if (ctx === null) {
		throw new Error("useSyncActions must be used inside <SyncActionsProvider>");
	}
	return ctx;
}
