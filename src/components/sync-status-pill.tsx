import { useSyncProgress } from "#/context/sync-progress-context.ts";

/** Sync progress for the status bar: text and a bar, totals summed over running syncs. */
export function SyncStatusPill() {
	const running = [...useSyncProgress().values()];
	if (running.length === 0) {
		return null;
	}
	const done = running.reduce((n, p) => n + p.done, 0);
	const total = running.reduce((n, p) => n + p.total, 0);
	const percent = total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100));
	return (
		<div className="flex items-center gap-2 text-primary">
			<span className="tabular-nums">
				Syncing {done}/{total}
			</span>
			<div
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={percent}
				className="h-1.5 w-32 overflow-hidden rounded-full bg-primary/20"
			>
				<div
					className="h-full rounded-full bg-primary transition-[width] duration-200"
					style={{ width: `${percent}%` }}
				/>
			</div>
		</div>
	);
}
