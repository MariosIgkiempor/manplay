import { createFileRoute } from "@tanstack/react-router";
import { DestinationServiceCard } from "#/components/destination-service.tsx";
import { Page, Section } from "#/components/page.tsx";
import { RekordboxCard } from "#/components/rekordbox-source.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { PullButton, SyncButton } from "#/components/sync-flow.tsx";
import { SyncReviewButton } from "#/components/sync-review.tsx";
import { UsbCard } from "#/components/usb-drives.tsx";
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
			description="Send your library to other machines and DJ software. Nothing is copied or deleted until you review it. Pull brings files back, push sends yours, sync does both."
			actions={
				<>
					<PullButton disabled={busy || targetCount === 0} />
					<SyncReviewButton variant="outline" disabled={busy || targetCount === 0} />
					<SyncButton disabled={busy || targetCount === 0} />
				</>
			}
		>
			<Section
				title="Destinations"
				description="Switch a destination off to pause it. Deleting remote files is opt-in and backed up first."
			>
				<div className="grid gap-4 lg:grid-cols-2">
					<DestinationServiceCard kind="tailscale" />
					<DestinationServiceCard kind="r2" />
					<RekordboxCard />
					<UsbCard />
				</div>
			</Section>
			<StatusBar>
				<Stat label="Destinations" value={targetCount} />
				<Stat label="Songs to sync" value={pending} />
			</StatusBar>
		</Page>
	);
}
