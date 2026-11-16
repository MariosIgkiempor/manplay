import { Check, Diff, Lock, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import {
	DiffHunk,
	DiffRow,
	groupByDir,
	PathDiff,
	Tally as TallyView,
	TONE,
	type Tone,
} from "#/components/diff-view.tsx";
import { TagDiffInline } from "#/components/tag-diff.tsx";
import { Button } from "#/components/ui/button.tsx";
import { formatBytes } from "#/lib/format.ts";
import type { PushAction, PushPlan } from "#/lib/sync-choices.ts";

type Kind = PushAction["kind"];

export const LABEL: Record<Kind, { tone: Tone; label: string }> = {
	upload: { tone: "add", label: "Push" },
	replace: { tone: "change", label: "Change" },
	move: { tone: "move", label: "Move" },
	delete: { tone: "remove", label: "Delete" },
};
export const KINDS: Kind[] = ["upload", "replace", "move", "delete"];
const STYLE = Object.fromEntries(
	KINDS.map((k) => [k, { ...TONE[LABEL[k].tone], label: LABEL[k].label }]),
) as unknown as Record<Kind, { sign: string; row: string; text: string; label: string }>;

const HUNKS_PER_PAGE = 40;
const path = (rel: readonly string[]) => rel.join("/");
const dirOf = (a: PushAction) => path(a.rel.slice(0, -1)) || "(top level)";
const nameOf = (a: PushAction) => a.rel.at(-1) ?? "";

const toHunks = (actions: readonly PushAction[]) => groupByDir(actions, dirOf, nameOf);

export type Counts = Partial<Record<Kind, number>>;

export function countKinds(actions: readonly PushAction[]): Counts {
	const out: Counts = {};
	for (const a of actions) {
		out[a.kind] = (out[a.kind] ?? 0) + 1;
	}
	return out;
}

export function Tally({ counts }: { counts: Counts }) {
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

/** Which changes a push list shows: everything, or one kind. */
export type PushFilter = Kind | "all";

/**
 * Signed, colour-coded counts such as `+29 push  ~19 change`, each one a button that shows only
 * that kind of change. The pressed one is underlined.
 */
export function FilterTally({
	counts,
	totals,
	active,
	onPick,
}: {
	/** What is ticked. */
	counts: Counts;
	/** Everything there is: a kind with changes shows even when none are ticked. */
	totals: Counts;
	active: PushFilter | null;
	onPick: (kind: Kind) => void;
}) {
	const shown = KINDS.filter((k) => (totals[k] ?? 0) > 0);
	if (shown.length === 0) {
		return <span className="text-muted-foreground text-sm">No changes</span>;
	}
	return (
		<span className="inline-flex flex-wrap gap-x-1 gap-y-0.5 text-sm tabular-nums">
			{shown.map((k) => (
				<button
					key={k}
					type="button"
					aria-pressed={active === k}
					onClick={() => onPick(k)}
					className="rounded-md px-1.5 py-0.5 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 aria-pressed:bg-muted"
				>
					<span
						className={`font-medium ${(counts[k] ?? 0) > 0 ? STYLE[k].text : "text-muted-foreground"}`}
						title={`${(counts[k] ?? 0).toLocaleString()} of ${(totals[k] ?? 0).toLocaleString()} ticked`}
					>
						{STYLE[k].sign}
						{(counts[k] ?? 0).toLocaleString()}
						<span className="font-normal text-muted-foreground">
							/{(totals[k] ?? 0).toLocaleString()}
						</span>
					</span>{" "}
					<span className="text-muted-foreground">{LABEL[k].label.toLowerCase()}</span>
				</button>
			))}
		</span>
	);
}

/** The size on the right of a row; a changed file also shows by how much, in front of the new size. */
function SizeOf({ action }: { action: PushAction }) {
	const delta =
		action.kind === "replace" && action.remoteSize !== null ? action.size - action.remoteSize : 0;
	return (
		<span className="inline-flex items-baseline gap-2">
			{delta !== 0 && (
				<span className="text-xs opacity-70">
					{delta > 0 ? "+" : "−"}
					{formatBytes(Math.abs(delta))}
				</span>
			)}
			<span className="text-foreground/80">{formatBytes(action.size)}</span>
		</span>
	);
}

/** Which copy a replace leaves on the destination, so ticking or unticking is never a guess. */
function Verdict({ picked }: { picked: boolean }) {
	return (
		<span
			className={`mb-1 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs ${picked ? "bg-primary/15 font-medium text-primary" : "bg-secondary text-muted-foreground"}`}
		>
			{picked ? <Check className="size-3" /> : <Lock className="size-3" />}
			{picked ? "Yours → remote" : "Remote kept"}
		</span>
	);
}

function ActionRow({
	action,
	picked,
	onToggle,
}: {
	action: PushAction;
	picked: boolean;
	onToggle: () => void;
}) {
	const from = action.kind === "move" && action.from ? path(action.from) : null;
	return (
		<DiffRow
			tone={LABEL[action.kind].tone}
			name={
				<>
					{nameOf(action)}
					{action.kind === "replace" && action.note && (
						<Diff
							role="img"
							aria-label={action.note}
							className="ml-2 inline size-3.5 -translate-y-px text-warning"
						>
							<title>{action.note}</title>
						</Diff>
					)}
				</>
			}
			detail={
				from ? (
					<>
						<PathDiff from={from} to={path(action.rel)} />
						{action.kind !== "replace" && action.note && (
							<span className="block text-warning">{action.note}</span>
						)}
					</>
				) : action.kind === "replace" ? null : (
					action.note
				)
			}
			warn={action.note !== null && from === null}
			picked={picked}
			onToggle={onToggle}
			extra={
				action.kind === "replace" && (
					<>
						{!action.tags && <Verdict picked={picked} />}
						{action.tags && <TagDiffInline changes={action.tags} keep={picked} />}
					</>
				)
			}
			label={path(action.rel)}
			aside={<SizeOf action={action} />}
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
	actions: PushAction[];
	skipped: ReadonlySet<number>;
	onToggle: (id: number) => void;
	onToggleAll: (ids: number[], on: boolean) => void;
}) {
	return (
		<DiffHunk
			flush
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

/** What a push would do on one destination: the changes folder by folder, one kind or all. */
export function PushList({
	plan,
	skipped,
	onToggle,
	onToggleAll,
	filter,
	onShowAll,
}: {
	plan: PushPlan;
	filter: PushFilter;
	onShowAll: () => void;
	skipped: ReadonlySet<number>;
	onToggle: (id: number) => void;
	onToggleAll: (ids: number[], on: boolean) => void;
}) {
	const [shown, setShown] = useState(HUNKS_PER_PAGE);
	const hunks = useMemo(
		() => toHunks(plan.actions.filter((a) => filter === "all" || a.kind === filter)),
		[plan.actions, filter],
	);
	return (
		<div>
			{plan.error && (
				<p className="mx-[var(--diff-inset,0)] my-3 break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
					{plan.error}
				</p>
			)}
			{!plan.error && plan.actions.length === 0 && (
				<p className="px-[var(--diff-inset,0)] py-3 text-muted-foreground text-sm">Up to date</p>
			)}
			{filter !== "all" && (
				<p className="flex items-center gap-2 border-b px-[var(--diff-inset,0)] py-1.5 text-muted-foreground text-xs">
					Showing {STYLE[filter].label.toLowerCase()} only
					<button
						type="button"
						onClick={onShowAll}
						className="rounded-md px-1.5 py-0.5 text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
					>
						Show all {plan.actions.length.toLocaleString()}
					</button>
				</p>
			)}
			<div>
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
			{plan.unchecked > 0 && (
				<p className="px-[var(--diff-inset,0)] py-2 text-muted-foreground text-xs">
					{plan.unchecked.toLocaleString()} files not compared
				</p>
			)}
			{plan.held.length > 0 && (
				<details className="mx-[var(--diff-inset,0)] my-3 rounded-md border px-3 py-2 text-xs">
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
				<Button
					variant="ghost"
					size="sm"
					className="mx-[var(--diff-inset,0)] my-2"
					onClick={() => setShown(shown + HUNKS_PER_PAGE)}
				>
					Show more folders ({hunks.length - shown} hidden)
				</Button>
			)}
		</div>
	);
}

/** The confirmation a push needs before it deletes files from a destination. */
export function DeleteGuard({
	removing,
	remoteFiles,
	understood,
	onChange,
}: {
	removing: number;
	remoteFiles: number;
	understood: boolean;
	onChange: (v: boolean) => void;
}) {
	if (removing === 0) {
		return null;
	}
	// Deleting most of a destination usually means the wrong folder or library was picked.
	const drastic = remoteFiles > 0 && removing / remoteFiles > 0.5;
	return (
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
					onChange={(e) => onChange(e.target.checked)}
				/>
				<span>
					Delete {removing.toLocaleString()} {removing === 1 ? "file" : "files"} (backed up first)
				</span>
			</label>
		</div>
	);
}
