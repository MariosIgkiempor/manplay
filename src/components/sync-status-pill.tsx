import { useSyncProgress } from "#/context/sync-progress-context.ts";

export function SyncStatusPill() {
	const progress = [...useSyncProgress().values()][0];
	if (!progress) {
		return null;
	}
	return (
		<span className="rounded-full bg-primary/15 px-3 py-1 text-primary text-xs">
			Syncing {progress.done}/{progress.total}
		</span>
	);
}
