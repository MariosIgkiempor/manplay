import { createFileRoute } from "@tanstack/react-router";
import { CloudUpload } from "lucide-react";
import { DestinationServiceCard } from "#/components/destination-service.tsx";
import { MutationErrors } from "#/components/path-setting.tsx";
import { RekordboxCard } from "#/components/rekordbox-source.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { useSyncRun, useSyncTargets } from "#/lib/queries.ts";

export const Route = createFileRoute("/export")({ component: ExportPage });

function ExportPage() {
	const progress = useSyncProgress();
	const targets = useSyncTargets();
	const run = useSyncRun();
	const busy = progress.size > 0 || run.isPending;

	return (
		<main className="mx-auto w-full max-w-5xl space-y-8 p-6 lg:p-8">
			<header className="flex flex-wrap items-end justify-between gap-4">
				<div className="space-y-1">
					<h1 className="font-semibold text-2xl tracking-tight">Export</h1>
					<p className="max-w-xl text-muted-foreground text-sm">
						Back up or hand off your library. Files are copied one way and never modified. Switch a
						service off to pause it.
					</p>
				</div>
				<Button
					onClick={() => run.mutate(undefined)}
					disabled={busy || (targets.data?.length ?? 0) === 0}
				>
					<CloudUpload /> Sync all
				</Button>
			</header>
			<MutationErrors mutations={[run]} />
			<section className="grid gap-4 lg:grid-cols-2">
				<DestinationServiceCard kind="tailscale" />
				<DestinationServiceCard kind="r2" />
				<RekordboxCard />
			</section>
		</main>
	);
}
