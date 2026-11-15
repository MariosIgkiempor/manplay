import { createFileRoute } from "@tanstack/react-router";
import { DestinationServiceCard } from "#/components/destination-service.tsx";
import { RekordboxCard } from "#/components/rekordbox-source.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { SyncReviewButton } from "#/components/sync-review.tsx";
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
						Back up or hand off your library. Nothing is sent until you review and confirm it. Files
						missing from your library are removed from a destination only after a backup copy is
						saved. Switch a service off to pause it.
					</p>
				</div>
				<SyncReviewButton label="Review all" disabled={busy || targetCount === 0} />
			</header>
			<section className="grid gap-4 lg:grid-cols-2">
				<DestinationServiceCard kind="tailscale" />
				<DestinationServiceCard kind="r2" />
				<RekordboxCard />
			</section>
			<StatusBar>
				<Stat label="Destinations" value={targetCount} />
				<Stat label="Songs to sync" value={pending} />
			</StatusBar>
		</main>
	);
}
