import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ProgressBar, Tally } from "#/components/diff-view.tsx";
import { PushResult } from "#/components/sync-review.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import {
	type ApplySummary,
	onPullProgress,
	type PullOutcome,
	type PullProgress,
	type RemoteFile,
	remotePull,
	remoteScan,
	type SyncAction,
	type TargetPlan,
} from "#/lib/api.ts";
import { formatBytes } from "#/lib/format.ts";
import { useSyncApply, useSyncPlan } from "#/lib/queries.ts";

const key = (rel: readonly string[]) => rel.join("/");
const bytes = (items: readonly { size: number }[]) => items.reduce((n, i) => n + i.size, 0);

/** What one destination's sync does with the default choices of both reviews. */
interface TargetSummary {
	plan: TargetPlan;
	/** Songs pulled into the library: everything missing except other formats of a library song. */
	pull: RemoteFile[];
	pullError: string | null;
	/** Push actions that start ticked in the push review. */
	push: SyncAction[];
	/** Opt-in push actions left out, such as deleting files that are only on the destination. */
	skipped: number;
}

function summarize(
	plan: TargetPlan,
	missing: readonly RemoteFile[] | undefined,
	error: unknown,
): TargetSummary {
	const pull = (missing ?? []).filter((f) => !f.otherFormat);
	const pulled = new Set(pull.map((f) => key(f.rel)));
	const push = plan.actions.filter((a) => !a.optional);
	// A song about to be pulled is no extra file on the destination any more.
	const skipped = plan.actions.filter((a) => a.optional && !pulled.has(key(a.rel))).length;
	return { plan, pull, pullError: error ? String(error) : null, push, skipped };
}

function count(actions: readonly SyncAction[], kind: SyncAction["kind"]) {
	return actions.filter((a) => a.kind === kind).length;
}

/** One line of the summary: what happens, the counts, and the bytes moved. */
function Line({
	label,
	children,
	size,
}: {
	label: string;
	children: React.ReactNode;
	size?: number;
}) {
	return (
		<div className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-baseline gap-2 py-1">
			<span className="text-muted-foreground text-xs">{label}</span>
			<span className="min-w-0">{children}</span>
			<span className="text-muted-foreground text-xs tabular-nums">
				{size ? formatBytes(size) : ""}
			</span>
		</div>
	);
}

function TargetBlock({ s }: { s: TargetSummary }) {
	const { plan } = s;
	return (
		<section className="rounded-lg border px-3 py-2">
			<h3 className="break-words pb-1 font-semibold text-sm">{plan.name}</h3>
			{plan.error && <p className="break-words py-1 text-destructive text-sm">{plan.error}</p>}
			{!plan.error && s.pull.length + s.push.length + s.skipped === 0 && !s.pullError && (
				<p className="py-1 text-muted-foreground text-sm">Up to date</p>
			)}
			{!plan.error && (s.pull.length + s.push.length + s.skipped > 0 || s.pullError) && (
				<>
					<Line label="Pull" size={bytes(s.pull)}>
						{s.pullError ? (
							<span className="text-destructive text-sm">{s.pullError}</span>
						) : (
							<Tally
								items={[{ tone: "add", label: "songs", count: s.pull.length }]}
								empty="Nothing"
							/>
						)}
					</Line>
					<Line
						label="Push"
						size={bytes(s.push.filter((a) => a.kind === "upload" || a.kind === "replace"))}
					>
						<Tally
							items={[
								{ tone: "add", label: "new", count: count(s.push, "upload") },
								{ tone: "change", label: "replace", count: count(s.push, "replace") },
								{ tone: "move", label: "rename", count: count(s.push, "move") },
								{ tone: "remove", label: "delete", count: count(s.push, "delete") },
							]}
							empty="Nothing"
						/>
					</Line>
					{s.skipped > 0 && (
						<Line label="Skipped">
							<span className="text-muted-foreground text-sm">
								{s.skipped.toLocaleString()} opt-in changes
							</span>
						</Line>
					)}
				</>
			)}
		</section>
	);
}

type Phase =
	| { step: "review" }
	| { step: "pulling" }
	| { step: "pushing" }
	| { step: "done"; pulled: PullOutcome[]; pushed: ApplySummary[] }
	| { step: "failed"; error: string };

/**
 * First step of a sync: reads both sides, then shows what a pull and a push would do for every
 * destination. Confirming runs both with the default choices; nothing changes before that.
 */
export function SyncSummary({
	ids,
	onReviewSteps,
	onClose,
}: {
	ids: number[];
	onReviewSteps: () => void;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const scans = useQueries({
		queries: ids.map((id) => ({
			queryKey: ["remote-scan", id],
			queryFn: () => remoteScan(id),
			gcTime: 0,
			retry: false,
		})),
	});
	const scanned = scans.every((s) => !s.isPending);
	const plan = useSyncPlan();
	const apply = useSyncApply();
	const [phase, setPhase] = useState<Phase>({ step: "review" });
	const [progress, setProgress] = useState<PullProgress | null>(null);

	// Plan the push once the scans are done, so the destinations are read one job at a time.
	const started = useRef(false);
	const { mutate: startPlan } = plan;
	useEffect(() => {
		if (scanned && !started.current) {
			started.current = true;
			startPlan(ids);
		}
	}, [scanned, ids, startPlan]);
	useEffect(() => {
		const unlisten = onPullProgress(setProgress);
		return () => {
			void unlisten.then((f) => f());
		};
	}, []);

	if (phase.step === "done") {
		return <Done pulled={phase.pulled} pushed={phase.pushed} onDone={onClose} />;
	}
	if (phase.step === "failed") {
		return (
			<div className="space-y-3">
				<p className="break-words text-destructive text-sm">{phase.error}</p>
				<Button variant="outline" className="w-full" onClick={onClose}>
					Close
				</Button>
			</div>
		);
	}
	if (plan.isError) {
		return (
			<div className="space-y-3">
				<p className="break-words text-destructive text-sm">{String(plan.error)}</p>
				<Button variant="outline" className="w-full" onClick={onClose}>
					Close
				</Button>
			</div>
		);
	}
	if (!plan.data) {
		return (
			<div className="space-y-3 py-12 text-center text-sm">
				<Loader2 className="mx-auto size-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
				<p>Comparing with your library…</p>
				{progress && progress.total > 0 && (
					<div className="mx-auto max-w-sm space-y-1">
						<ProgressBar done={progress.done} total={progress.total} />
						<p className="truncate text-muted-foreground text-xs">{progress.current}</p>
					</div>
				)}
			</div>
		);
	}

	const planId = plan.data.id;
	const summaries = plan.data.targets.map((t) => {
		const scan = scans[ids.indexOf(t.targetId)];
		return summarize(t, scan?.data?.missing, scan?.error);
	});
	const pulls = summaries.filter((s) => s.pull.length > 0 && !s.plan.error);
	const pushIds = summaries.filter((s) => !s.plan.error).flatMap((s) => s.push.map((a) => a.id));
	const total = pulls.reduce((n, s) => n + s.pull.length, 0) + pushIds.length;
	const busy = phase.step !== "review";

	const run = async () => {
		try {
			setPhase({ step: "pulling" });
			const pulled: PullOutcome[] = [];
			for (const s of pulls) {
				pulled.push(
					await remotePull(
						s.plan.targetId,
						s.pull.map((f) => f.rel),
					),
				);
			}
			if (pulled.length > 0) {
				await queryClient.invalidateQueries({ queryKey: ["tracks"] });
				await queryClient.invalidateQueries({ queryKey: ["library-status"] });
			}
			setPhase({ step: "pushing" });
			const pushed =
				pushIds.length > 0 ? await apply.mutateAsync({ planId, actionIds: pushIds }) : [];
			setPhase({ step: "done", pulled, pushed });
		} catch (e) {
			setPhase({ step: "failed", error: String(e) });
		}
	};

	return (
		<div className="space-y-4">
			<div className="space-y-2">
				{summaries.map((s) => (
					<TargetBlock key={s.plan.targetId} s={s} />
				))}
			</div>
			<div className="sticky -bottom-4 z-20 -mx-4 -mb-4 space-y-3 border-t bg-background px-4 pt-3 pb-4">
				<RunStatus phase={phase} pulling={progress} />
				<div className="flex flex-wrap gap-2">
					<Button variant="ghost" onClick={onReviewSteps} disabled={busy}>
						Review each step
					</Button>
					<span className="flex-1" />
					<Button variant="outline" onClick={onClose} disabled={busy}>
						{total === 0 ? "Close" : "Cancel"}
					</Button>
					{total > 0 && (
						<Button onClick={() => void run()} disabled={busy}>
							<RefreshCw className={busy ? "animate-spin motion-reduce:animate-none" : ""} />
							{busy ? "Syncing…" : `Sync ${total.toLocaleString()} changes`}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}

/** Progress of the step that is running. */
function RunStatus({ phase, pulling }: { phase: Phase; pulling: PullProgress | null }) {
	const pushing = [...useSyncProgress().values()];
	let done = 0;
	let total = 0;
	let current = "";
	if (phase.step === "pulling" && pulling) {
		({ done, total } = pulling);
		current = `Pulling ${pulling.current}`;
	} else if (phase.step === "pushing") {
		done = pushing.reduce((n, p) => n + p.done, 0);
		total = pushing.reduce((n, p) => n + p.total, 0);
		current = `Pushing ${pushing[0]?.current ?? ""}`;
	}
	if (total === 0) {
		return null;
	}
	return (
		<div className="space-y-1">
			<ProgressBar done={done} total={total} />
			<p className="truncate text-muted-foreground text-xs">{current}</p>
		</div>
	);
}

function Done({
	pulled,
	pushed,
	onDone,
}: {
	pulled: PullOutcome[];
	pushed: ApplySummary[];
	onDone: () => void;
}) {
	const failed = pulled.flatMap((p) => p.failed);
	return (
		<div className="space-y-6">
			{pulled.length > 0 && (
				<div className="space-y-2">
					<h3 className="font-semibold text-xl tracking-tight">Pull</h3>
					<Tally
						items={[
							{ tone: "add", label: "pulled", count: pulled.reduce((n, p) => n + p.pulled, 0) },
							{
								tone: "remove",
								label: "failed",
								count: pulled.reduce((n, p) => n + p.failedTotal, 0),
							},
						]}
						empty="Nothing pulled"
					/>
					{failed.map((m) => (
						<p key={m} className="break-all text-destructive text-xs">
							{m}
						</p>
					))}
				</div>
			)}
			<PushResult results={pushed} onDone={onDone} />
		</div>
	);
}
