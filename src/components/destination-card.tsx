import { CloudUpload, Trash2 } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import type { Machine, SyncProgress, SyncRun, SyncTarget } from "#/lib/api.ts";
import { timeAgo } from "#/lib/format.ts";
import { cn } from "#/lib/utils.ts";

interface Props {
	target: SyncTarget;
	totalTracks: number;
	machine: Machine | undefined;
	progress: SyncProgress | undefined;
	lastRun: SyncRun | undefined;
	busy: boolean;
	onSync: () => void;
	onRemove: () => void;
}

function Bar({ value, className }: { value: number; className?: string }) {
	return (
		<div className="h-1.5 overflow-hidden rounded-full bg-muted">
			<div
				className={cn("h-full rounded-full bg-primary transition-all", className)}
				style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
			/>
		</div>
	);
}

function LastRun({ run }: { run: SyncRun | undefined }) {
	if (!run) {
		return <span className="text-muted-foreground">Never synced</span>;
	}
	return (
		<span className="text-muted-foreground">
			Last sync {timeAgo(run.finishedAt)} · {run.uploaded} uploaded
			{run.failed > 0 && <span className="text-destructive"> · {run.failed} failed</span>}
		</span>
	);
}

function Header({
	target,
	machine,
	online,
	busy,
	onRemove,
}: Pick<Props, "target" | "machine" | "busy" | "onRemove"> & { online: boolean }) {
	return (
		<div className="flex items-start justify-between gap-3">
			<div className="min-w-0">
				<div className="flex items-center gap-2 font-medium">
					<span
						role="img"
						aria-label={online ? "online" : "offline"}
						className={cn("size-2 rounded-full", online ? "bg-emerald-500" : "bg-muted-foreground")}
					/>
					<span className="truncate">{machine?.hostName ?? target.machine}</span>
					{machine && <span className="text-muted-foreground text-xs">{machine.os}</span>}
				</div>
				<div className="truncate text-muted-foreground text-sm" title={target.path.join(" / ")}>
					{target.path.join(" / ")}
				</div>
			</div>
			<Button
				variant="ghost"
				size="icon"
				aria-label={`Remove ${target.machine}`}
				disabled={busy}
				onClick={onRemove}
			>
				<Trash2 />
			</Button>
		</div>
	);
}

export function DestinationCard({
	target,
	totalTracks,
	machine,
	progress,
	lastRun,
	busy,
	onSync,
	onRemove,
}: Props) {
	const running = progress !== undefined;
	const online = machine?.online ?? false;
	const synced = Math.min(target.syncedTracks, totalTracks);

	return (
		<div className="space-y-3 rounded-xl border bg-card p-4">
			<Header target={target} machine={machine} online={online} busy={busy} onRemove={onRemove} />

			<div className="space-y-1.5">
				<div className="flex justify-between text-sm">
					<span>
						{synced} of {totalTracks} tracks synced
					</span>
					<span className="text-muted-foreground tabular-nums">
						{totalTracks > 0 ? Math.round((synced / totalTracks) * 100) : 0}%
					</span>
				</div>
				<Bar value={totalTracks > 0 ? synced / totalTracks : 0} />
			</div>

			{running ? (
				<div className="space-y-1.5 text-xs">
					<Bar value={progress.total > 0 ? progress.done / progress.total : 0} />
					<div className="truncate text-muted-foreground" title={progress.current}>
						{progress.done}/{progress.total} · {progress.current}
					</div>
				</div>
			) : (
				<div className="flex items-center justify-between gap-2 text-xs">
					<LastRun run={lastRun} />
					<Button size="sm" onClick={onSync} disabled={busy || !online}>
						<CloudUpload /> Sync now
					</Button>
				</div>
			)}
			{!(online || running) && machine && (
				<p className="text-amber-500 text-xs">
					This machine is offline; sync will resume when it is back.
				</p>
			)}
		</div>
	);
}
