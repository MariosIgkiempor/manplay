import { createFileRoute } from "@tanstack/react-router";
import { CloudUpload, Download, Upload } from "lucide-react";
import { Destinations } from "#/components/destinations.tsx";
import { HeaderMenu } from "#/components/header-menu.tsx";
import { Page } from "#/components/page.tsx";
import { SyncButton } from "#/components/sync-flow.tsx";
import { useSyncActions } from "#/context/sync-actions-context.ts";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { useSyncTargets, useTracks } from "#/lib/queries.ts";

export const Route = createFileRoute("/export/")({ component: ExportPage });

function ExportPage() {
	const progress = useSyncProgress();
	const { start } = useSyncActions();
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
					<SyncButton disabled={busy || targetCount === 0} label="Sync all" />
					<HeaderMenu
						entries={[
							{
								label: "Only bring into your library…",
								icon: <Download />,
								onSelect: () => start("pull"),
								disabled: busy || targetCount === 0,
							},
							{
								label: "Only send to destinations…",
								icon: <CloudUpload />,
								onSelect: () => start("push"),
								disabled: busy || targetCount === 0,
							},
						]}
					/>
				</>
			}
		>
			<Destinations />
		</Page>
	);
}
