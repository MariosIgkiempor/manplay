import { CheckCircle2, CloudUpload, FolderArchive, Loader2, ShieldAlert } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
	DiffHunk,
	DiffRow,
	groupByDir,
	ProgressBar,
	Tally as TallyView,
	TONE,
	type Tone,
} from "#/components/diff-view.tsx";
import { Drawer } from "#/components/drawer.tsx";
import { TagChanges } from "#/components/tag-diff.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import {
	type ApplySummary,
	onPullProgress,
	type PullProgress,
	type SyncAction,
	type SyncPlan,
	type TargetPlan,
} from "#/lib/api.ts";
import { formatBytes } from "#/lib/format.ts";
import { useSyncApply, useSyncPlan } from "#/lib/queries.ts";

type Kind = SyncAction["kind"];

const LABEL: Record<Kind, { tone: Tone; label: string }> = {
	upload: { tone: "add", label: "Push" },
	replace: { tone: "change", label: "Replace" },
	move: { tone: "move", label: "Rename" },
	delete: { tone: "remove", label: "Delete" },
};
const KINDS: Kind[] = ["upload", "replace", "move", "delete"];
const STYLE = Object.fromEntries(
	KINDS.map((k) => [k, { ...TONE[LABEL[k].tone], label: LABEL[k].label }]),
) as Record<Kind, { sign: string; row: string; text: string; label: string }>;

const HUNKS_PER_PAGE = 40;
const path = (rel: readonly string[]) => rel.join("/");
const dirOf = (a: SyncAction) => path(a.rel.slice(0, -1)) || "(top level)";
const nameOf = (a: SyncAction) => a.rel.at(-1) ?? "";

/** Everything the review shows for one choice of actions. */
function totals(actions: readonly SyncAction[]) {
	const count = (k: Kind) => actions.filter((a) => a.kind === k).length;
	return {
		push: count("upload") + count("replace"),
		move: count("move"),
		remove: count("delete"),
		bytes: actions
			.filter((a) => a.kind === "upload" || a.kind === "replace")
			.reduce((n, a) => n + a.size, 0),
	};
}

const toHunks = (actions: readonly SyncAction[]) => groupByDir(actions, dirOf, nameOf);

type Counts = Partial<Record<Kind, number>>;

function countKinds(actions: readonly SyncAction[]): Counts {
	const out: Counts = {};
	for (const a of actions) {
		out[a.kind] = (out[a.kind] ?? 0) + 1;
	}
	return out;
}

function Tally({ counts }: { counts: Counts }) {
	return (
		<TallyView
			items={KINDS.map((k) => ({
				tone: LABEL[k].tone,
				label: LABEL[k].label.toLowerCase(),
				count: counts[k] ?? 0,
			}))}
		/>
	);
}

/** Where a renamed file came from: just the old name when it stays in the same folder. */
function movedFrom(action: SyncAction): string | null {
	if (action.kind !== "move" || !action.from) {
		return null;
	}
	const sameDir = path(action.from.slice(0, -1)) === path(action.rel.slice(0, -1));
	return `Was ${sameDir ? (action.from.at(-1) ?? "") : path(action.from)}`;
}

function sizeOf(action: SyncAction): string {
	if (
		action.kind === "replace" &&
		action.remoteSize !== null &&
		action.remoteSize !== action.size
	) {
		return `${formatBytes(action.remoteSize)} → ${formatBytes(action.size)}`;
	}
	return formatBytes(action.size);
}

function ActionRow({
	action,
	picked,
	onToggle,
}: {
	action: SyncAction;
	picked: boolean;
	onToggle: () => void;
}) {
	const from = movedFrom(action);
	return (
		<DiffRow
			tone={LABEL[action.kind].tone}
			name={nameOf(action)}
			detail={
				action.note && from ? (
					<>
						{from}
						<span className="block text-warning">{action.note}</span>
					</>
				) : (
					(action.note ?? from)
				)
			}
			warn={action.note !== null && from === null}
			picked={picked}
			onToggle={onToggle}
			extra={action.tags && <TagChanges changes={action.tags} />}
			label={path(action.rel)}
			aside={sizeOf(action)}
		/>
	);
}

function Hunk({
	dir,
	actions,
	skipped,
	onToggle,
	onToggleAll,
}: {
	dir: string;
	actions: SyncAction[];
	skipped: ReadonlySet<number>;
	onToggle: (id: number) => void;
	onToggleAll: (ids: number[], on: boolean) => void;
}) {
	return (
		<DiffHunk
			dir={dir}
			total={actions.length}
			picked={actions.filter((a) => !skipped.has(a.id)).length}
			onToggleAll={(on) =>
				onToggleAll(
					actions.map((a) => a.id),
					on,
				)
			}
			tallies={KINDS.map((k) => ({
				tone: LABEL[k].tone,
				count: actions.filter((a) => a.kind === k).length,
			}))}
		>
			{actions.map((a) => (
				<ActionRow
					key={a.id}
					action={a}
					picked={!skipped.has(a.id)}
					onToggle={() => onToggle(a.id)}
				/>
			))}
		</DiffHunk>
	);
}

function TargetSection({
	plan,
	skipped,
	onToggle,
	onToggleAll,
}: {
	plan: TargetPlan;
	skipped: ReadonlySet<number>;
	onToggle: (id: number) => void;
	onToggleAll: (ids: number[], on: boolean) => void;
}) {
	const [filter, setFilter] = useState<Kind | null>(null);
	const [shown, setShown] = useState(HUNKS_PER_PAGE);
	const hunks = useMemo(
		() => toHunks(plan.actions.filter((a) => filter === null || a.kind === filter)),
		[plan.actions, filter],
	);
	const count = (k: Kind) => plan.actions.filter((a) => a.kind === k).length;
	return (
		<section className="space-y-3 border-t pt-6 first:border-t-0 first:pt-0">
			<div className="space-y-1">
				<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
					<h3 className="break-words font-semibold">{plan.name}</h3>
					<span className="text-muted-foreground text-xs tabular-nums">
						{plan.inSync.toLocaleString()} already match
					</span>
				</div>
				{plan.unchecked > 0 && (
					<p className="text-muted-foreground text-xs">
						{plan.unchecked.toLocaleString()} not compared
					</p>
				)}
			</div>
			{plan.error && (
				<p className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
					{plan.error}
				</p>
			)}
			{!plan.error && plan.actions.length === 0 && (
				<p className="text-muted-foreground text-sm">Up to date</p>
			)}
			{plan.actions.length > 0 && (
				<div className="flex flex-wrap gap-1 text-muted-foreground text-xs tabular-nums">
					<button
						type="button"
						onClick={() => setFilter(null)}
						aria-pressed={filter === null}
						className="rounded-md px-2.5 py-1 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:bg-muted aria-pressed:text-foreground"
					>
						All <span className="ml-1 text-foreground">{plan.actions.length.toLocaleString()}</span>
					</button>
					{KINDS.filter((k) => count(k) > 0).map((k) => (
						<button
							key={k}
							type="button"
							onClick={() => setFilter(filter === k ? null : k)}
							aria-pressed={filter === k}
							className="rounded-md px-2.5 py-1 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:bg-muted aria-pressed:text-foreground"
						>
							{STYLE[k].label}{" "}
							<span className={`ml-1 font-medium ${STYLE[k].text}`}>
								{STYLE[k].sign}
								{count(k).toLocaleString()}
							</span>
						</button>
					))}
				</div>
			)}
			<div className="space-y-2">
				{hunks.slice(0, shown).map(([dir, actions]) => (
					<Hunk
						key={dir}
						dir={dir}
						actions={actions}
						skipped={skipped}
						onToggle={onToggle}
						onToggleAll={onToggleAll}
					/>
				))}
			</div>
			{plan.held.length > 0 && (
				<details className="rounded-md border px-3 py-2 text-xs">
					<summary className="cursor-pointer text-muted-foreground">
						{plan.held.length.toLocaleString()} kept for 7 days after leaving the library
					</summary>
					<ul className="mt-2 space-y-0.5 font-mono">
						{plan.held.slice(0, 50).map((h) => (
							<li key={path(h.rel)} className="break-all">
								{path(h.rel)}
							</li>
						))}
						{plan.held.length > 50 && <li>…and {plan.held.length - 50} more</li>}
					</ul>
				</details>
			)}
			{hunks.length > shown && (
				<Button variant="ghost" size="sm" onClick={() => setShown(shown + HUNKS_PER_PAGE)}>
					Show more folders ({hunks.length - shown} hidden)
				</Button>
			)}
		</section>
	);
}

function DeleteToggle({
	total,
	marked,
	busy,
	onToggle,
}: {
	total: number;
	marked: number;
	busy: boolean;
	onToggle: () => void;
}) {
	if (total === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground text-xs">
			<span>
				{marked === 0
					? `${total.toLocaleString()} extra files kept`
					: `${marked.toLocaleString()} of ${total.toLocaleString()} extra files to delete`}
			</span>
			<Button variant="ghost" size="sm" disabled={busy} onClick={onToggle}>
				{marked === 0 ? "Delete them" : "Keep them"}
			</Button>
		</div>
	);
}

function Review({
	plan,
	busy,
	onConfirm,
	onCancel,
}: {
	plan: SyncPlan;
	busy: boolean;
	onConfirm: (ids: number[]) => void;
	onCancel: () => void;
}) {
	const all = useMemo(() => plan.targets.flatMap((p) => p.actions), [plan]);
	// Opt-in actions start unticked: deletions (other people may share the destination) and
	// uploads of audio the destination already holds under another path.
	const [skipped, setSkipped] = useState<ReadonlySet<number>>(
		() => new Set(all.filter((a) => a.optional).map((a) => a.id)),
	);
	const [understood, setUnderstood] = useState(false);
	const deletes = all.filter((a) => a.kind === "delete");
	const chosen = all.filter((a) => !skipped.has(a.id));
	const t = totals(chosen);
	const progress = useSyncProgress();
	const active = [...progress.values()];
	const remoteFiles = plan.targets.reduce((n, p) => n + p.remoteTotal, 0);
	// Deleting most of a destination usually means the wrong folder or library was picked.
	const drastic = t.remove > 0 && remoteFiles > 0 && t.remove / remoteFiles > 0.5;

	const toggle = (id: number) =>
		setSkipped((prev) => {
			const next = new Set(prev);
			if (!next.delete(id)) {
				next.add(id);
			}
			return next;
		});
	const toggleAll = (ids: number[], on: boolean) =>
		setSkipped((prev) => {
			const next = new Set(prev);
			for (const id of ids) {
				if (on) {
					next.delete(id);
				} else {
					next.add(id);
				}
			}
			return next;
		});

	return (
		<div className="space-y-8">
			{plan.targets.map((p) => (
				<TargetSection
					key={p.targetId}
					plan={p}
					skipped={skipped}
					onToggle={toggle}
					onToggleAll={toggleAll}
				/>
			))}
			<div className="sticky -bottom-4 z-20 -mx-4 -mb-4 space-y-3 border-t bg-background px-4 pt-3 pb-4">
				<DeleteToggle
					total={deletes.length}
					marked={t.remove}
					busy={busy}
					onToggle={() =>
						toggleAll(
							deletes.map((a) => a.id),
							t.remove === 0,
						)
					}
				/>
				{t.remove > 0 && (
					<div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
						{drastic && (
							<p className="flex items-start gap-2 font-medium text-destructive">
								<ShieldAlert className="mt-0.5 size-4 shrink-0" />
								Deletes over half the destination. Right folder?
							</p>
						)}
						<label className="flex cursor-pointer items-start gap-2">
							<input
								type="checkbox"
								className="mt-0.5 size-4 shrink-0 accent-primary"
								checked={understood}
								onChange={(e) => setUnderstood(e.target.checked)}
							/>
							<span>
								Delete {t.remove.toLocaleString()} {t.remove === 1 ? "file" : "files"} (backed up
								first)
							</span>
						</label>
					</div>
				)}
				<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
					<Tally counts={countKinds(chosen)} />
					<span className="text-muted-foreground text-xs">{formatBytes(t.bytes)} to upload</span>
				</div>
				{busy && active.length > 0 && (
					<div className="space-y-1">
						<ProgressBar
							done={active.reduce((n, p) => n + p.done, 0)}
							total={active.reduce((n, p) => n + p.total, 0)}
						/>
						<p className="break-all text-muted-foreground text-xs">{active[0]?.current}</p>
					</div>
				)}
				<div className="flex gap-2">
					<Button variant="outline" className="flex-1" onClick={onCancel} disabled={busy}>
						{all.length === 0 ? "Close" : "Cancel"}
					</Button>
					{all.length > 0 && (
						<Button
							className="flex-1"
							disabled={busy || chosen.length === 0 || (t.remove > 0 && !understood)}
							onClick={() => onConfirm(chosen.map((a) => a.id))}
						>
							<CloudUpload /> {busy ? "Pushing…" : `Push ${chosen.length.toLocaleString()} changes`}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}

export function PushResult({ results, onDone }: { results: ApplySummary[]; onDone: () => void }) {
	const failed = results.reduce((n, r) => n + r.failedTotal, 0);
	return (
		<div className="space-y-6">
			<div className="flex items-center gap-2">
				<CheckCircle2 className={`size-5 ${failed > 0 ? "text-warning" : "text-success"}`} />
				<h3 className="font-semibold text-xl tracking-tight">
					{failed > 0 ? `Pushed with ${failed.toLocaleString()} errors` : "Push complete"}
				</h3>
			</div>
			{results.length === 0 && <p className="text-sm">Nothing was changed.</p>}
			{results.map((r) => (
				<div key={r.targetId} className="space-y-2">
					<h4 className="break-words font-medium text-sm">{r.name}</h4>
					<Tally counts={{ upload: r.uploaded, move: r.moved, delete: r.deleted }} />
					{r.backupDir && (
						<p className="flex items-start gap-1.5 break-all text-muted-foreground text-xs">
							<FolderArchive className="mt-0.5 size-3.5 shrink-0" />
							Backup, kept 30 days: {r.backupDir}
						</p>
					)}
					{r.failedTotal > 0 && (
						<div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-xs">
							<p className="font-medium">{r.failedTotal} failed, left unchanged:</p>
							{r.failed.map((m) => (
								<p key={m} className="break-all">
									{m}
								</p>
							))}
						</div>
					)}
				</div>
			))}
			<Button className="w-full" onClick={onDone}>
				Done
			</Button>
		</div>
	);
}

export function ReviewBody({ ids, onClose }: { ids: number[] | undefined; onClose: () => void }) {
	const plan = useSyncPlan();
	const apply = useSyncApply();
	const [progress, setProgress] = useState<PullProgress | null>(null);
	const { mutate: start } = plan;

	// Read the destinations as soon as the review opens; this changes nothing on them.
	// A ref guard keeps React's dev double-mount from starting two plans (the second would be
	// refused as "a sync is already running").
	const started = useRef(false);
	useEffect(() => {
		if (started.current) {
			return;
		}
		started.current = true;
		start(ids);
	}, [ids, start]);
	useEffect(() => {
		const unlisten = onPullProgress(setProgress);
		return () => {
			void unlisten.then((f) => f());
		};
	}, []);

	let content: ReactNode;
	if (apply.isSuccess) {
		content = <PushResult results={apply.data} onDone={onClose} />;
	} else if (plan.isPending) {
		content = (
			<div className="space-y-3 py-12 text-center text-sm">
				<Loader2 className="mx-auto size-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
				<p>Comparing with your library…</p>
				{progress && progress.total > 0 && (
					<div className="mx-auto max-w-sm space-y-1">
						<ProgressBar done={progress.done} total={progress.total} />
						<p className="break-all text-muted-foreground text-xs">
							Checking {progress.done}/{progress.total}: {progress.current}
						</p>
					</div>
				)}
			</div>
		);
	} else if (plan.isError) {
		content = (
			<div className="space-y-3">
				<p className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
					{String(plan.error)}
				</p>
				<Button variant="outline" className="w-full" onClick={onClose}>
					Close
				</Button>
			</div>
		);
	} else if (plan.data) {
		const data = plan.data;
		content = (
			<div className="space-y-3">
				{apply.isError && (
					<p className="break-words text-destructive text-sm">{String(apply.error)}</p>
				)}
				<Review
					plan={data}
					busy={apply.isPending}
					onCancel={onClose}
					onConfirm={(actionIds) => apply.mutate({ planId: data.id, actionIds })}
				/>
			</div>
		);
	}
	return <div className="space-y-5">{content}</div>;
}

/** Button that opens the review: nothing reaches a destination until the changes are confirmed. */
export function SyncReviewButton({
	ids,
	label = "Review push",
	size,
	variant,
	disabled,
}: {
	ids?: number[];
	label?: string;
	size?: "sm" | "default";
	variant?: "default" | "outline";
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [session, setSession] = useState(0);
	return (
		<>
			<Button
				size={size}
				variant={variant}
				disabled={disabled}
				title="See what will be sent, renamed or deleted before anything changes."
				onClick={() => {
					setSession((n) => n + 1);
					setOpen(true);
				}}
			>
				<CloudUpload /> {label}
			</Button>
			<Drawer open={open} onClose={() => setOpen(false)} title="Review push" width="w-[44rem]">
				{open && <ReviewBody key={session} ids={ids} onClose={() => setOpen(false)} />}
			</Drawer>
		</>
	);
}
