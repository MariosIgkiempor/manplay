import { createFileRoute } from "@tanstack/react-router";
import { DestinationServiceCard } from "#/components/destination-service.tsx";
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
		<main className="mx-auto w-full max-w-5xl space-y-8 p-6 lg:p-8">
			<header className="flex flex-wrap items-end justify-between gap-4">
				<div className="space-y-1">
					<h1 className="font-semibold text-2xl tracking-tight">Export</h1>
					<p className="max-w-xl text-muted-foreground text-sm">
						Back up or hand off your library. Nothing is sent until you review and confirm it. Pull
						copies files from a destination into your library, push sends yours, and sync does both.
						Deleting files from a destination is opt-in and always backed up first. Switch a service
						off to pause it.
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<PullButton disabled={busy || targetCount === 0} />
					<SyncReviewButton variant="outline" disabled={busy || targetCount === 0} />
					<SyncButton disabled={busy || targetCount === 0} />
				</div>
			</header>
			<section className="grid gap-4 lg:grid-cols-2">
				<DestinationServiceCard kind="tailscale" />
				<DestinationServiceCard kind="r2" />
				<RekordboxCard />
				<UsbCard />
			</section>
			<StatusBar>
				<Stat label="Destinations" value={targetCount} />
				<Stat label="Songs to sync" value={pending} />
			</StatusBar>
		</main>
	);
}
