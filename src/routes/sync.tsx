import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CloudUpload, Plus } from "lucide-react";
import { DestinationCard } from "#/components/destination-card.tsx";
import { SyncHistory } from "#/components/sync-history.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { removeSyncTarget, syncHistory, tailscaleStatus } from "#/lib/api.ts";
import { useSyncRun, useSyncTargets, useTracks } from "#/lib/queries.ts";

export const Route = createFileRoute("/sync")({ component: SyncPage });

const HISTORY_LIMIT = 200;

function SectionTitle({ title, count }: { title: string; count?: number }) {
	return (
		<h2 className="flex items-center gap-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
			{title}
			{count !== undefined && count > 0 && (
				<span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
					{count}
				</span>
			)}
		</h2>
	);
}

function SyncPage() {
	const queryClient = useQueryClient();
	const detail = useDetail();
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

	return (
		<main className="mx-auto w-full max-w-5xl space-y-8 p-6 lg:p-8">
			<header className="flex flex-wrap items-end justify-between gap-4">
				<div className="space-y-1">
					<h1 className="font-semibold text-2xl tracking-tight">Sync</h1>
					<p className="max-w-xl text-muted-foreground text-sm">
						Back up your library to one or more destinations. Files are copied one way and never
						modified; removing a track locally only removes its backup after a grace period.
					</p>
				</div>
				<div className="flex gap-2">
					<Button variant="outline" onClick={() => detail.open({ kind: "add-destination" })}>
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

			<section className="space-y-3">
				<SectionTitle title="Destinations" count={list.length} />
				{list.length === 0 && targets.isSuccess && (
					<div className="rounded-xl border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
						<p>Add a Cloudflare R2 bucket or a Tailscale machine to start backing up.</p>
						<Button
							className="mt-3"
							variant="outline"
							onClick={() => detail.open({ kind: "add-destination" })}
						>
							<Plus /> Add destination
						</Button>
					</div>
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
				<SectionTitle title="History" />
				<SyncHistory runs={history.data ?? []} />
			</section>
		</main>
	);
}
