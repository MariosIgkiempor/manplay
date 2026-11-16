import { createFileRoute } from "@tanstack/react-router";
import { Upload } from "lucide-react";
import { Destinations } from "#/components/destinations.tsx";
import { Page } from "#/components/page.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { PullButton, PushButton, SyncButton } from "#/components/sync-flow.tsx";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { useSyncTargets, useTracks } from "#/lib/queries.ts";

export const Route = createFileRoute("/export")({ component: ExportPage });

function ExportPage() {
	const progress = useSyncProgress();
	const targets = useSyncTargets();
	const tracks = useTracks();
	const targetCount = targets.data?.length ?? 0;
	const pending =
		targetCount === 0 ? 0 : (tracks.data ?? []).filter((t) => t.syncedCount < targetCount).length;
	const busy = progress.size > 0;

	return (
		<Page
			title="Export"
			icon={<Upload />}
			meta={
				<>
					<span>
						{targetCount} {targetCount === 1 ? "destination" : "destinations"}
					</span>
					<span>
						{pending === 0 ? "Everything synced" : `${pending.toLocaleString()} songs to sync`}
					</span>
				</>
			}
			actions={
				<>
					<PullButton disabled={busy || targetCount === 0} />
					<PushButton variant="outline" disabled={busy || targetCount === 0} />
					<SyncButton disabled={busy || targetCount === 0} label="Sync all" />
				</>
			}
		>
			<Destinations />
			<StatusBar>
				<Stat label="Destinations" value={targetCount} />
				<Stat label="Songs to sync" value={pending} />
			</StatusBar>
		</Page>
	);
}
