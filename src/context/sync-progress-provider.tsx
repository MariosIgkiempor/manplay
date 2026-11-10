import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { SyncProgressContext } from "#/context/sync-progress-context.ts";
import { onSyncProgress, type SyncProgress } from "#/lib/api.ts";

const REFRESH_KEYS = ["tracks", "playlist-tracks", "sync-targets", "sync-history"] as const;

export function SyncProgressProvider({ children }: { children: ReactNode }) {
	const queryClient = useQueryClient();
	const [running, setRunning] = useState<ReadonlyMap<number, SyncProgress>>(new Map());

	useEffect(() => {
		let cancelled = false;
		let unlisten: (() => void) | undefined;
		const handle = (p: SyncProgress) => {
			const finished = p.done >= p.total;
			setRunning((prev) => {
				const next = new Map(prev);
				if (finished) {
					next.delete(p.targetId);
				} else {
					next.set(p.targetId, p);
				}
				return next;
			});
			if (finished) {
				for (const key of REFRESH_KEYS) {
					void queryClient.invalidateQueries({ queryKey: [key] });
				}
			}
		};
		void onSyncProgress(handle).then((fn) => {
			if (cancelled) {
				fn();
			} else {
				unlisten = fn;
			}
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [queryClient]);

	return <SyncProgressContext.Provider value={running}>{children}</SyncProgressContext.Provider>;
}
