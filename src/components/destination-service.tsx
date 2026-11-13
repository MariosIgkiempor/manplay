import { useQuery } from "@tanstack/react-query";
import { ChevronRight, CloudUpload, Plus } from "lucide-react";
import { useState } from "react";
import { AddR2, AddTailscale } from "#/components/add-destination.tsx";
import { type Brand, BrandIcon } from "#/components/brand-icon.tsx";
import { Drawer } from "#/components/drawer.tsx";
import { PullReview } from "#/components/pull-review.tsx";
import { SourceCard } from "#/components/source-card.tsx";
import { SectionTitle, SourcePanel } from "#/components/source-panel.tsx";
import { TargetDetail } from "#/components/target-detail.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { isR2, type SyncTarget, tailscaleStatus } from "#/lib/api.ts";
import { duration, timeAgo } from "#/lib/format.ts";
import { useServices, useSyncHistory, useSyncRun, useSyncTargets } from "#/lib/queries.ts";

export type DestinationKind = "tailscale" | "r2";

const COPY = {
	tailscale: {
		brand: "tailscale" as Brand,
		title: "Tailscale",
		blurb:
			"Back up to folders shared from your other machines over Tailscale. Files are copied one way and never modified; removing a track locally only removes its backup after a grace period.",
		list: "Machines & folders",
		add: "Add folder",
	},
	r2: {
		brand: "cloudflare" as Brand,
		title: "Cloudflare R2",
		blurb:
			"Back up to a Cloudflare R2 bucket. Files are copied one way and never modified; removing a track locally only removes its backup after a grace period.",
		list: "Buckets & folders",
		add: "Add bucket",
	},
} as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function useDestinations(kind: DestinationKind) {
	const targets = useSyncTargets();
	const services = useServices();
	const mine = (targets.data ?? []).filter((t) => isR2(t) === (kind === "r2"));
	return {
		mine,
		enabled: services.isEnabled(kind, mine.length > 0),
		setEnabled: (on: boolean) => services.setEnabled(kind, on),
	};
}

function summary(kind: DestinationKind, mine: readonly SyncTarget[]): string {
	if (mine.length === 0) {
		return kind === "r2" ? "No buckets added" : "No folders added";
	}
	const hosts = new Set(mine.map((t) => t.machine)).size;
	return kind === "r2"
		? `${plural(mine.length, "folder", "folders")} in ${plural(hosts, "bucket", "buckets")}`
		: `${plural(mine.length, "folder", "folders")} on ${plural(hosts, "machine", "machines")}`;
}

export function DestinationServiceCard({ kind }: { kind: DestinationKind }) {
	const detail = useDetail();
	const { mine, enabled, setEnabled } = useDestinations(kind);
	const progress = useSyncProgress();
	const run = useSyncRun();
	const history = useSyncHistory();
	const ids = new Set(mine.map((t) => t.id));
	const active = [...progress.values()].filter((p) => ids.has(p.targetId));
	const last = history.data?.find((r) => ids.has(r.targetId));
	const busy = progress.size > 0 || run.isPending;
	const open = () => detail.open({ kind: "service", service: kind });

	let status: string;
	if (active.length > 0) {
		status = `Syncing… ${active.reduce((n, p) => n + p.done, 0)}/${active.reduce((n, p) => n + p.total, 0)}`;
	} else if (last) {
		status = `Last sync ${timeAgo(last.finishedAt)} · ${duration(last.finishedAt - last.startedAt)} · ${last.uploaded.toLocaleString()} uploaded`;
	} else {
		status = mine.length === 0 ? "Nothing set up yet" : "Never synced";
	}
	return (
		<SourceCard
			brand={COPY[kind].brand}
			title={COPY[kind].title}
			subtitle={summary(kind, mine)}
			enabled={enabled}
			onToggle={setEnabled}
			status={status}
			onOpen={open}
			action={
				mine.length === 0 ? (
					<Button size="sm" onClick={open}>
						<Plus /> Set up
					</Button>
				) : (
					<Button size="sm" onClick={() => run.mutate([...ids])} disabled={busy}>
						<CloudUpload /> Sync now
					</Button>
				)
			}
		/>
	);
}

function TargetRow({ target, onOpen }: { target: SyncTarget; onOpen: () => void }) {
	const machines = useQuery({
		queryKey: ["ts-status"],
		queryFn: tailscaleStatus,
		enabled: !isR2(target),
	});
	const online = machines.data?.machines.find((m) => m.name === target.machine)?.online;
	return (
		<li>
			<button
				type="button"
				onClick={onOpen}
				className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-muted/40"
			>
				{!isR2(target) && (
					<span
						role="img"
						aria-label={online ? "online" : "offline"}
						className={`size-2 shrink-0 rounded-full ${online ? "bg-emerald-500" : "bg-muted-foreground"}`}
					/>
				)}
				<span className="min-w-0 flex-1">
					<span className="block truncate font-medium text-sm">{target.machine}</span>
					<span className="block truncate text-muted-foreground text-xs">
						{target.path.join(" / ") || "(bucket root)"} · {target.syncedTracks.toLocaleString()}{" "}
						tracks synced
					</span>
				</span>
				<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
			</button>
		</li>
	);
}

export function DestinationServicePanel({ kind }: { kind: DestinationKind }) {
	const { mine, enabled, setEnabled } = useDestinations(kind);
	const [selected, setSelected] = useState<number | null>(null);
	const [adding, setAdding] = useState(false);
	const [reviewing, setReviewing] = useState<number | null>(null);
	const copy = COPY[kind];
	const target = mine.find((t) => t.id === selected);
	const onAdded = (id: number) => {
		setAdding(false);
		setReviewing(id);
	};
	return (
		<SourcePanel
			brand={copy.brand}
			title={copy.title}
			subtitle={copy.blurb}
			enabled={enabled}
			onToggle={setEnabled}
		>
			<section className="space-y-2">
				<SectionTitle
					action={
						<Button variant="outline" size="sm" onClick={() => setAdding(true)}>
							<Plus /> {copy.add}
						</Button>
					}
				>
					{copy.list}
				</SectionTitle>
				{mine.length === 0 ? (
					<p className="py-6 text-center text-muted-foreground text-sm">
						{kind === "r2" ? "No buckets added yet." : "No folders added yet."}
					</p>
				) : (
					<ul className="divide-y">
						{mine.map((t) => (
							<TargetRow key={t.id} target={t} onOpen={() => setSelected(t.id)} />
						))}
					</ul>
				)}
			</section>
			<Drawer
				open={target !== undefined}
				onClose={() => setSelected(null)}
				title={target?.machine ?? ""}
				width="w-[32rem]"
			>
				{selected !== null && <TargetDetail id={selected} onRemoved={() => setSelected(null)} />}
			</Drawer>
			<Drawer open={adding} onClose={() => setAdding(false)} title={copy.add} width="w-[32rem]">
				<div className="space-y-4 pb-6">
					<div className="flex items-center gap-3">
						<BrandIcon brand={copy.brand} className="size-10" />
						<h2 className="font-semibold text-xl tracking-tight">{copy.add}</h2>
					</div>
					{kind === "r2" ? <AddR2 onAdded={onAdded} /> : <AddTailscale onAdded={onAdded} />}
				</div>
			</Drawer>
			<Drawer
				open={reviewing !== null}
				onClose={() => setReviewing(null)}
				title="Pull existing files"
				width="w-[44rem]"
			>
				{reviewing !== null && (
					<PullReview targetId={reviewing} onDone={() => setReviewing(null)} />
				)}
			</Drawer>
		</SourcePanel>
	);
}
