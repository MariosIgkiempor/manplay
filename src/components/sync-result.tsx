import { CheckCircle2, FolderArchive, Trash2, TriangleAlert } from "lucide-react";
import { TONE, type Tone } from "#/components/diff-view.tsx";
import { FailureList } from "#/components/failure-list.tsx";
import { SyncShell, type SyncShellVariant } from "#/components/sync-shell.tsx";
import { Button } from "#/components/ui/button.tsx";
import type { ApplySummary, LibraryOutcome, PullOutcome } from "#/lib/api.ts";
import { TRASH } from "#/lib/platform.ts";
import { cn } from "#/lib/utils.ts";

/** One figure of the result: a big number in its tone's colour and what it counts. */
/** Things worth knowing about a library sync that are not errors. */
function libraryNotes(l: LibraryOutcome): string[] {
	const notes: string[] = [];
	if (l.clockWrong) {
		notes.push(
			"Clock wrong: set date, time and time zone (automatic if you can). Other devices hold back your edits until then.",
		);
	}
	if (l.held > 0) {
		notes.push(
			`${l.held.toLocaleString()} edits held back: another device's clock is ahead of yours.`,
		);
	}
	if (l.deleteHold) {
		notes.push(
			`${l.deleteHold.count.toLocaleString()} deletions from another device are waiting: choose under Changes. Nothing else arrives until then.`,
		);
	}
	if (l.newDeviceId) {
		notes.push(
			"Device ID was in use by another copy (copied app data or a backup). New ID given; nothing lost.",
		);
	}
	return notes;
}

function Stat({ tone, count, label }: { tone: Tone; count: number; label: string }) {
	return (
		<div className="min-w-0">
			<p className={cn("font-semibold text-2xl tabular-nums leading-none", TONE[tone].text)}>
				{TONE[tone].sign}
				{count.toLocaleString()}
			</p>
			<p className="mt-1 text-muted-foreground text-xs">{label}</p>
		</div>
	);
}

/** A destination, or the pull, with its figures and whatever failed. Runs edge to edge. */
function Block({
	title,
	stats,
	backupDir,
	trashed,
	failed,
	failedTotal,
	outcome,
}: {
	title: string;
	stats: { tone: Tone; count: number; label: string }[];
	backupDir?: string | null;
	/** Library files replaced by the destination's copy, now in the Trash. */
	trashed?: number;
	failed: readonly string[];
	failedTotal: number;
	outcome?: string;
}) {
	const shown = stats.filter((s) => s.count > 0);
	return (
		<section className="space-y-4 border-y px-[var(--diff-inset)] py-4">
			<h3 className="break-words font-semibold text-sm">{title}</h3>
			{shown.length > 0 ? (
				<div className="flex flex-wrap gap-x-8 gap-y-3">
					{shown.map((s) => (
						<Stat key={s.label} {...s} />
					))}
				</div>
			) : (
				<p className="text-muted-foreground text-sm">Nothing changed</p>
			)}
			{backupDir && (
				<div className="space-y-0.5 text-muted-foreground text-xs">
					<p className="flex items-center gap-1.5">
						<FolderArchive className="size-3.5 shrink-0" />
						Backed up first, kept for 30 days
					</p>
					<p className="break-all font-mono opacity-70">{backupDir}</p>
				</div>
			)}
			{trashed !== undefined && trashed > 0 && (
				<p className="flex items-center gap-1.5 text-muted-foreground text-xs">
					<Trash2 className="size-3.5 shrink-0" />
					{trashed.toLocaleString()} replaced {trashed === 1 ? "file is" : "files are"} in the{" "}
					{TRASH}
				</p>
			)}
			{failedTotal > 0 && <FailureList messages={failed} total={failedTotal} outcome={outcome} />}
		</section>
	);
}

/**
 * What a sync did, per destination, with the Done button pinned to the bottom. Used for the pull
 * and the push of one run together.
 */
export function SyncResult({
	pulled,
	pushed,
	library = [],
	variant,
	onDone,
}: {
	pulled: PullOutcome[];
	pushed: ApplySummary[];
	/** Tags and playlists exchanged with destinations that share them. */
	library?: LibraryOutcome[];
	variant: SyncShellVariant;
	onDone: () => void;
}) {
	const errors =
		pulled.reduce((n, p) => n + p.failedTotal, 0) +
		pushed.reduce((n, p) => n + p.failedTotal, 0) +
		library.filter((l) => l.error !== null).length;
	const Icon = errors > 0 ? TriangleAlert : CheckCircle2;
	const sum = <T,>(items: T[], pick: (t: T) => number) => items.reduce((n, i) => n + pick(i), 0);
	return (
		<SyncShell
			variant={variant}
			footer={
				<Button className="w-full" onClick={onDone}>
					Done
				</Button>
			}
		>
			<div className="space-y-6 py-4">
				<header className="flex items-center gap-3 px-[var(--diff-inset)]">
					<Icon className={cn("size-8 shrink-0", errors > 0 ? "text-warning" : "text-success")} />
					<div>
						<h2 className="font-semibold text-xl tracking-tight">
							{errors > 0 ? "Sync finished with errors" : "Sync complete"}
						</h2>
						{errors > 0 && (
							<p className="text-muted-foreground text-sm">
								{errors.toLocaleString()} {errors === 1 ? "file" : "files"} left unchanged
							</p>
						)}
					</div>
				</header>
				<div className="-space-y-px">
					{library.map((l) => (
						<Block
							key={`library-${l.targetId}`}
							title={`Library data: ${l.name}`}
							stats={[
								{ tone: "add", count: l.sent, label: "library edits sent" },
								{ tone: "change", count: l.received, label: "received" },
							]}
							failed={[...(l.error ? [l.error] : []), ...libraryNotes(l)]}
							failedTotal={(l.error ? 1 : 0) + libraryNotes(l).length}
							outcome="not shared"
						/>
					))}
					{pulled.length > 0 && (
						<Block
							title="Pull into your library"
							stats={[
								{ tone: "add", count: sum(pulled, (p) => p.pulled), label: "pulled" },
								{ tone: "change", count: sum(pulled, (p) => p.skipped), label: "already there" },
							]}
							failed={pulled.flatMap((p) => p.failed)}
							failedTotal={sum(pulled, (p) => p.failedTotal)}
						/>
					)}
					{pushed.map((r) => (
						<Block
							key={r.targetId}
							title={r.name}
							stats={[
								{ tone: "add", count: r.uploaded, label: "pushed" },
								{ tone: "change", count: r.merged, label: "merged" },
								{ tone: "change", count: r.updated, label: "updated in your library" },
								{ tone: "move", count: r.moved, label: "moved" },
								{ tone: "remove", count: r.deleted, label: "deleted" },
							]}
							backupDir={r.backupDir}
							trashed={r.updated}
							failed={r.failed}
							failedTotal={r.failedTotal}
							outcome="left unchanged"
						/>
					))}
				</div>
			</div>
		</SyncShell>
	);
}
