import { type ReactNode, useCallback, useMemo, useState } from "react";
import {
	type SyncActionsApi,
	SyncActionsContext,
	type SyncKind,
	type SyncRequest,
} from "#/context/sync-actions-context.ts";

export function SyncActionsProvider({ children }: { children: ReactNode }) {
	const [request, setRequest] = useState<SyncRequest | null>(null);
	const start = useCallback(
		(kind: SyncKind, ids?: number[]) =>
			setRequest((r) => ({ kind, ids, session: (r?.session ?? 0) + 1 })),
		[],
	);
	const close = useCallback(() => setRequest(null), []);
	const value = useMemo<SyncActionsApi>(() => ({ request, start, close }), [request, start, close]);
	return <SyncActionsContext.Provider value={value}>{children}</SyncActionsContext.Provider>;
}
