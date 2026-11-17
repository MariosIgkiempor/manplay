import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { onSyncScan } from "#/lib/api.ts";
import { SYNC_SCANS_KEY } from "#/lib/queries.ts";

/**
 * Keeps what the background reads of the destinations found up to date in the app: refetches it
 * whenever a read is queued, starts or finishes. Renders nothing.
 */
export function SyncScanEvents() {
	const queryClient = useQueryClient();
	useEffect(() => {
		const unlisten = onSyncScan(() => {
			void queryClient.invalidateQueries({ queryKey: SYNC_SCANS_KEY });
		});
		return () => {
			void unlisten.then((f) => f());
		};
	}, [queryClient]);
	return null;
}
