import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CloudUpload, Plus } from "lucide-react";
import { useState } from "react";
import { AddDestination } from "#/components/add-destination.tsx";
import { DestinationCard } from "#/components/destination-card.tsx";
import { SyncHistory } from "#/components/sync-history.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { removeSyncTarget, syncHistory, tailscaleStatus } from "#/lib/api.ts";
import { useSyncRun, useSyncTargets, useTracks } from "#/lib/queries.ts";

export const Route = createFileRoute("/sync")({ component: SyncPage });

const HISTORY_LIMIT = 30;

function SyncPage() {
	const queryClient = useQueryClient();
	const [adding, setAdding] = useState(false);
	const progress = useSyncProgress();
	const targets = useSyncTargets();
	const tracks = useTracks();
	const status = useQuery({ queryKey: ["ts-status"], queryFn: tailscaleStatus });
	const history = useQuery({
		queryKey: ["sync-history"],
		queryFn: () => syncHistory(HISTORY_LIMIT),
	});
	const run = useSyncRun();
	const remove = useMutation({
		mutationFn: removeSyncTarget,
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
			await queryClient.invalidateQueries({ queryKey: ["sync-history"] });
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
		},
	});

	const list = targets.data ?? [];
	const busy = progress.size > 0 || run.isPending;
	const showAdd = adding || (targets.isSuccess && list.length === 0);

	return (
		<main className="space-y-8 p-6">
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h1 className="font-bold text-2xl">Sync</h1>
					<p className="text-muted-foreground text-sm">
						Every file in your library is copied to each destination. Nothing is ever deleted there.
					</p>
				</div>
				<div className="flex gap-2">
					<Button variant="outline" onClick={() => setAdding(!adding)}>
						<Plus /> Add destination
					</Button>
					<Button onClick={() => run.mutate(undefined)} disabled={busy || list.length === 0}>
						<CloudUpload /> Sync all
					</Button>
				</div>
			</header>

			{[run, remove].map(
				(m) =>
					m.isError && (
						<p key={m.submittedAt} className="text-destructive text-sm">
							{String(m.error)}
						</p>
					),
			)}

			{showAdd && <AddDestination onAdded={() => setAdding(false)} />}

			<section className="space-y-3">
				<h2 className="font-semibold">Destinations</h2>
				{list.length === 0 && !showAdd && (
					<p className="text-muted-foreground text-sm">No destinations yet.</p>
				)}
				<div className="grid gap-4 lg:grid-cols-2">
					{list.map((t) => (
						<DestinationCard
							key={t.id}
							target={t}
							totalTracks={tracks.data?.length ?? 0}
							machine={status.data?.machines.find((m) => m.name === t.machine)}
							progress={progress.get(t.id)}
							lastRun={history.data?.find((r) => r.targetId === t.id)}
							busy={busy}
							onSync={() => run.mutate(t.id)}
							onRemove={() => remove.mutate(t.id)}
						/>
					))}
				</div>
			</section>

			<section className="space-y-3">
				<h2 className="font-semibold">History</h2>
				<SyncHistory runs={history.data ?? []} />
			</section>
		</main>
	);
}
