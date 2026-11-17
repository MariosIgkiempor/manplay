import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CloudUpload, Download, Loader2, RefreshCw } from "lucide-react";
import {
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";
import { ChangeBar, RunProgress, Tally } from "#/components/diff-view.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { PullList } from "#/components/pull-review.tsx";
import { IncomingList } from "#/components/sync-incoming.tsx";
import { SyncResult } from "#/components/sync-result.tsx";
import {
	countKinds,
	DeleteGuard,
	FilterTally,
	KINDS,
	LABEL,
	type PushFilter,
	PushList,
} from "#/components/sync-review.tsx";
import { SyncShell, type SyncShellVariant } from "#/components/sync-shell.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import {
	type ApplySummary,
	type LibraryOutcome,
	libsyncRun,
	onPullProgress,
	type PlanId,
	type PullOutcome,
	type PullProgress,
	type RemoteFile,
	type Resolution,
	remotePull,
	type SyncAction,
	type TargetPlan,
	type TargetScan,
} from "#/lib/api.ts";
import { formatBytes } from "#/lib/format.ts";
import {
	DELETED_KEY,
	useSyncApply,
	useSyncRescan,
	useSyncScans,
	useSyncTargets,
	useTargetScans,
} from "#/lib/queries.ts";
import {
	hasNewerRead,
	latestReads,
	shownReads,
	unreadTargets,
	waitingOnOther,
} from "#/lib/review-reads.ts";
import {
	type Choices,
	type IncomingAction,
	isIncoming,
	isPush,
	isSettled,
	type PushAction,
} from "#/lib/sync-choices.ts";
import { cn } from "#/lib/utils.ts";

/** Which halves of a sync start switched on. */
export type SyncMode = "both" | "pull" | "push";
type Side = "pull" | "push";

const bytes = (items: readonly { size: number }[]) => items.reduce((n, i) => n + i.size, 0);
const flip = <T,>(set: ReadonlySet<T>, v: T): Set<T> => {
	const next = new Set(set);
	if (!next.delete(v)) {
		next.add(v);
	}
	return next;
};
const pullKey = (id: number, f: RemoteFile) => `${id}:${f.rel.join("/")}`;

type Phase =
	| { step: "review" }
	| { step: "pulling" }
	| { step: "pushing" }
	| {
			step: "done";
			pulled: PullOutcome[];
			pushed: ApplySummary[];
			library: LibraryOutcome[];
	  }
	| { step: "failed"; error: string };

/** One half of a sync on one destination: a switch, what it would do, and the list on demand. */
function Section({
	icon,
	title,
	on,
	onToggle,
	summary,
	size,
	empty,
	open,
	onOpen,
	children,
}: {
	icon: ReactNode;
	title: string;
	on: boolean;
	onToggle: (on: boolean) => void;
	/** Counts after the title; they may be buttons that open the list. */
	summary: ReactNode;
	size: number;
	/** Nothing to do: the switch and the list are off. */
	empty: boolean;
	open: boolean;
	/** Opens or closes the whole list. */
	onOpen: () => void;
	children: ReactNode;
}) {
	return (
		<div className="border-b first:border-t [--sync-head:3rem]">
			<div
				className={cn(
					"sticky top-[var(--sync-top,-1rem)] z-20 flex h-12 items-center gap-3 bg-background px-[var(--diff-inset)]",
					open && !empty && "border-b",
				)}
			>
				<Switch checked={on && !empty} disabled={empty} onChange={onToggle} label={title} />
				<button
					type="button"
					aria-expanded={open}
					disabled={empty}
					onClick={onOpen}
					className="flex shrink-0 items-center gap-1.5 rounded-md font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default [&_svg]:size-4"
				>
					{icon}
					{title}
				</button>
				<span className={cn("min-w-0 transition-opacity", !on && !empty && "opacity-45")}>
					{summary}
				</span>
				{/* The empty stretch of the row opens the list too. */}
				<button
					type="button"
					tabIndex={-1}
					aria-hidden="true"
					disabled={empty}
					onClick={onOpen}
					className="flex min-w-0 flex-1 items-center justify-end gap-3 self-stretch text-muted-foreground disabled:cursor-default"
				>
					{size > 0 && <span className="text-xs tabular-nums">{formatBytes(size)}</span>}
					{!empty && (
						<ChevronRight
							className={cn(
								"size-4 shrink-0 transition-transform motion-reduce:transition-none",
								open && "rotate-90",
							)}
						/>
					)}
				</button>
			</div>
			{open && !empty && <div>{children}</div>}
		</div>
	);
}

/**
 * Sync with the destinations: shows what their last background read found at once, a pull and a
 * push for each, each with a switch and its full list of changes to tick. Nothing changes until
 * Sync. Refresh reads them again and waits for that.
 */
export function SyncPanel({
	ids,
	mode = "both",
	variant = "drawer",
	onClose,
}: {
	ids: number[];
	mode?: SyncMode;
	variant?: SyncShellVariant;
	onClose?: () => void;
}) {
	const rescan = useSyncRescan();
	// Each round starts the review afresh; reads already shown are not shown again.
	const [session, setSession] = useState<{ round: number; stale: ReadonlySet<PlanId> }>({
		round: 0,
		stale: new Set(),
	});
	const { mutate: readAgain } = rescan;
	const refresh = (shown: readonly PlanId[]) => {
		readAgain(ids);
		setSession((s) => ({ round: s.round + 1, stale: new Set([...s.stale, ...shown]) }));
	};
	return (
		<Gather
			key={session.round}
			ids={ids}
			stale={session.stale}
			mode={mode}
			variant={variant}
			onClose={onClose}
			onRefresh={refresh}
			rescanError={rescan.isError ? String(rescan.error) : null}
		/>
	);
}

interface Row {
	plan: TargetPlan;
	missing: RemoteFile[];
	pullError: string | null;
	pullOn: boolean;
	pushOn: boolean;
	/** What would be pulled if the switch were on, and what is, with it off nothing. */
	pullSel: RemoteFile[];
	pull: RemoteFile[];
	/** Files edited on the destination that would change the library: they belong to the pull. */
	incoming: IncomingAction[];
	incomingSel: IncomingAction[];
	/** What runs: the selection, unless the pull is switched off. */
	incomingRun: IncomingAction[];
	pushActions: PushAction[];
	pushSel: PushAction[];
	push: PushAction[];
}

/** The state setters and tick lookups a destination's block works through. */
interface Ui {
	setOpen: Dispatch<SetStateAction<ReadonlyMap<string, string>>>;
	setSwitched: Dispatch<SetStateAction<ReadonlyMap<string, boolean>>>;
	setPullFlips: Dispatch<SetStateAction<ReadonlySet<string>>>;
	setPushFlips: Dispatch<SetStateAction<ReadonlySet<number>>>;
	setChoices: Dispatch<SetStateAction<Choices>>;
	choices: Choices;
	pullPicked: (id: number, f: RemoteFile) => boolean;
	pushPicked: (a: SyncAction) => boolean;
}

/** What a destination's pull holds: songs the library lacks and songs edited over there. */
function PullSummary({ t }: { t: Row }) {
	if (t.pullError !== null) {
		return <span className="text-destructive text-sm">Could not check</span>;
	}
	if (t.missing.length + t.incoming.length === 0) {
		return <span className="text-muted-foreground text-sm">Nothing to pull</span>;
	}
	return (
		<span className="inline-flex flex-wrap gap-x-4 text-sm tabular-nums">
			{t.missing.length > 0 && (
				<span>
					<span className="font-medium text-success">+{t.pullSel.length.toLocaleString()}</span>{" "}
					<span className="text-muted-foreground">
						of {t.missing.length.toLocaleString()} songs not in your library
					</span>
				</span>
			)}
			{t.incoming.length > 0 && (
				<span>
					<span className="font-medium text-warning">~{t.incomingSel.length.toLocaleString()}</span>{" "}
					<span className="text-muted-foreground">
						of {t.incoming.length.toLocaleString()} edited on the destination
					</span>
				</span>
			)}
		</span>
	);
}

/** Files edited on the destination: updates, merges and conflicts, with their ticks and choices. */
function PullIncoming({ t, ui }: { t: Row; ui: Ui }) {
	if (t.incoming.length === 0) {
		return null;
	}
	const { setPushFlips, setChoices, choices, pushPicked } = ui;
	return (
		<IncomingList
			actions={t.incoming}
			choices={choices}
			picked={pushPicked}
			// A conflict is ticked by choosing a copy; unticking forgets the choice.
			onToggle={(a) =>
				a.kind === "conflict"
					? setChoices((m) => {
							const next = new Map(m);
							next.delete(a.id);
							return next;
						})
					: setPushFlips((s) => flip(s, a.id))
			}
			onToggleAll={(items, on) =>
				setPushFlips((s) => {
					let next = s;
					for (const a of items) {
						if (a.kind !== "conflict" && isSettled(a, choices.get(a.id)) && pushPicked(a) !== on) {
							next = flip(next, a.id);
						}
					}
					return next;
				})
			}
			onChoose={(aid, next) => setChoices((m) => new Map(m).set(aid, next))}
		/>
	);
}

/** One destination: how much already matches, then its pull and its push. */
function TargetBlock({
	t,
	multi,
	open,
	ui,
}: {
	t: Row;
	multi: boolean;
	open: ReadonlyMap<string, string>;
	ui: Ui;
}) {
	const { setOpen, setSwitched, setPullFlips, setPushFlips, pullPicked, pushPicked } = ui;
	const id = t.plan.targetId;
	const skippedPush = new Set(t.pushActions.filter((a) => !pushPicked(a)).map((a) => a.id));
	const pullCount = t.missing.length + t.incoming.length;
	// Pressing the title opens the list; with a filter on it first clears the filter, and only a
	// list showing everything closes.
	const toggleOpen = (side: Side) =>
		setOpen((prev) => {
			const next = new Map(prev);
			const at = `${id}:${side}`;
			if (prev.get(at) === "all") {
				next.delete(at);
			} else {
				next.set(at, "all");
			}
			return next;
		});
	// A count of one kind shows only that kind; pressing it again goes back to all, still open.
	const pickKind = (kind: PushFilter) =>
		setOpen((prev) =>
			new Map(prev).set(`${id}:push`, prev.get(`${id}:push`) === kind ? "all" : kind),
		);
	const pushFilter = (open.get(`${id}:push`) ?? "all") as PushFilter;
	return (
		<section key={id}>
			{(multi || t.plan.inSync > 0) && (
				<div className="flex flex-wrap items-baseline justify-between gap-x-3 px-[var(--diff-inset)] py-2">
					{multi ? <h3 className="break-words font-semibold text-sm">{t.plan.name}</h3> : <span />}
					<span className="text-muted-foreground text-xs tabular-nums">
						{t.plan.inSync.toLocaleString()} already match
					</span>
				</div>
			)}
			{[...new Set([t.pullError, t.plan.error])].map(
				(message) =>
					message && (
						<ErrorLine key={message} className="px-[var(--diff-inset)] py-2">
							{message}
						</ErrorLine>
					),
			)}
			<Section
				icon={<Download />}
				title="Pull"
				on={t.pullOn}
				onToggle={(v) => setSwitched((m) => new Map(m).set(`${id}:pull`, v))}
				empty={pullCount === 0}
				size={bytes(t.pullSel) + bytes(t.incomingSel)}
				open={open.has(`${id}:pull`)}
				onOpen={() => toggleOpen("pull")}
				summary={<PullSummary t={t} />}
			>
				<PullIncoming t={t} ui={ui} />
				<PullList
					missing={t.missing}
					picked={(f) => pullPicked(id, f)}
					onToggle={(f) => setPullFlips((s) => flip(s, pullKey(id, f)))}
					onToggleGroup={(files, on) =>
						setPullFlips((s) => {
							let next = s;
							for (const f of files) {
								if (pullPicked(id, f) !== on) {
									next = flip(next, pullKey(id, f));
								}
							}
							return next;
						})
					}
					onOnly={(keep) =>
						setPullFlips(
							new Set(
								t.missing
									.filter((f) => !f.otherFormat !== keep.includes(f))
									.map((f) => pullKey(id, f)),
							),
						)
					}
				/>
			</Section>
			<Section
				icon={<CloudUpload />}
				title="Push"
				on={t.pushOn}
				onToggle={(v) => setSwitched((m) => new Map(m).set(`${id}:push`, v))}
				empty={t.pushActions.length === 0 || t.plan.error !== null}
				size={bytes(t.pushSel.filter((a) => a.kind === "upload" || a.kind === "replace"))}
				open={open.has(`${id}:push`)}
				onOpen={() => toggleOpen("push")}
				summary={
					t.plan.error ? (
						<span className="text-destructive text-sm">Could not check</span>
					) : t.pushActions.length === 0 ? (
						<span className="text-muted-foreground text-sm">Up to date</span>
					) : (
						<FilterTally
							counts={countKinds(t.pushSel)}
							totals={countKinds(t.pushActions)}
							active={(open.get(`${id}:push`) as PushFilter | undefined) ?? null}
							onPick={pickKind}
						/>
					)
				}
			>
				<PushList
					filter={pushFilter}
					onShowAll={() => setOpen((prev) => new Map(prev).set(`${id}:push`, "all"))}
					plan={{ ...t.plan, actions: t.pushActions }}
					skipped={skippedPush}
					onToggle={(aid) => setPushFlips((s) => flip(s, aid))}
					onToggleAll={(aids, on) =>
						setPushFlips((s) => {
							let next = s;
							for (const a of t.pushActions.filter((x) => aids.includes(x.id))) {
								if (pushPicked(a) !== on) {
									next = flip(next, a.id);
								}
							}
							return next;
						})
					}
				/>
			</Section>
		</section>
	);
}

/**
 * Exchanges tags and playlists with the destinations that share them, then refreshes what the
 * received edits can change.
 */
async function exchangeLibraryData(
	ids: number[],
	queryClient: ReturnType<typeof useQueryClient>,
): Promise<LibraryOutcome[]> {
	if (ids.length === 0) {
		return [];
	}
	const outcomes = await libsyncRun(ids);
	// Who deleted what can also change when only a snapshot was written or read.
	await queryClient.invalidateQueries({ queryKey: DELETED_KEY });
	if (outcomes.some((l) => l.received > 0)) {
		for (const key of [
			"tracks",
			"playlists",
			"playlist-tracks",
			"tags",
			"smart-playlists",
			"clashes",
		]) {
			await queryClient.invalidateQueries({ queryKey: [key] });
		}
	}
	return outcomes;
}

/** What shows before there is a plan to review, and after the run: loading, errors, the result. */
function notReady({
	phase,
	ready,
	error: readError,
	waiting,
	progress,
	onRefresh,
	onClose,
	variant,
}: {
	phase: Phase;
	/** Every destination has a read to show. */
	ready: boolean;
	error: string | null;
	/** Another destination is being read first. */
	waiting: boolean;
	progress: PullProgress | null;
	onRefresh: () => void;
	onClose: (() => void) | undefined;
	variant: SyncShellVariant;
}): ReactNode {
	if (phase.step === "done") {
		return (
			<SyncResult
				pulled={phase.pulled}
				pushed={phase.pushed}
				library={phase.library}
				variant={variant}
				onDone={onClose ?? onRefresh}
			/>
		);
	}
	const error = phase.step === "failed" ? phase.error : readError;
	if (error !== null) {
		return (
			<SyncShell variant={variant}>
				<div className="space-y-3 px-[var(--diff-inset)] py-4">
					<ErrorLine>{error}</ErrorLine>
					<Button variant="outline" className="w-full" onClick={onRefresh}>
						Try again
					</Button>
				</div>
			</SyncShell>
		);
	}
	if (ready) {
		return null;
	}
	return (
		<SyncShell variant={variant}>
			<div className="space-y-3 px-[var(--diff-inset)] py-12 text-center text-sm">
				<Loader2 className="mx-auto size-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
				<p>
					{waiting ? "Waiting for another destination to be read…" : "Reading the destinations…"}
				</p>
				{!waiting && progress && progress.total > 0 && (
					<div className="mx-auto max-w-sm">
						<RunProgress done={progress.done} total={progress.total} current={progress.current} />
					</div>
				)}
			</div>
		</SyncShell>
	);
}

/**
 * The reads a review shows, one per destination: the newest, unless it was shown before a Refresh.
 * While `frozen` (something is ticked, or a run is going) the reads on screen stay put, and
 * `newer` says a newer one is ready instead of swapping it in under the user's choices. A
 * destination never read yet (e.g. just added) is queued for a read, unless it already waits.
 */
function useReviewReads(ids: readonly number[], stale: ReadonlySet<PlanId>, frozen: boolean) {
	const reads = useTargetScans(ids);
	const status = useSyncScans().data;
	const { mutate: readNow } = useSyncRescan();
	const latest = latestReads(
		reads.map((r) => r?.data),
		stale,
	);
	const [pinned, setPinned] = useState<ReadonlyMap<number, TargetScan>>(new Map());
	const shown = shownReads(ids, latest, pinned, frozen);
	const shownKey = shown.map((r) => r?.planId ?? "").join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-pin only when what is shown changes
	useEffect(() => {
		setPinned(new Map(shown.flatMap((r) => (r === null ? [] : [[r.targetId, r] as const]))));
	}, [shownKey]);

	const asked = useRef(false);
	const unread = unreadTargets(
		ids,
		reads.map((r) => r?.data),
		status,
	);
	useEffect(() => {
		if (unread.length > 0 && !asked.current) {
			asked.current = true;
			readNow(unread);
		}
	}, [unread, readNow]);

	const queryError = reads.find((r) => r.isError)?.error;
	return {
		shown,
		newer: hasNewerRead(ids, latest, pinned),
		waiting: waitingOnOther(ids, status),
		error: queryError === undefined ? null : String(queryError),
	};
}

function Gather({
	ids,
	stale,
	mode,
	variant,
	onClose,
	onRefresh,
	rescanError,
}: {
	ids: number[];
	/** Reads shown before a Refresh: waited past, never shown again. */
	stale: ReadonlySet<PlanId>;
	mode: SyncMode;
	variant: SyncShellVariant;
	onClose: (() => void) | undefined;
	onRefresh: (shown: readonly PlanId[]) => void;
	rescanError: string | null;
}) {
	const queryClient = useQueryClient();
	const apply = useSyncApply();
	const syncTargets = useSyncTargets();
	const [phase, setPhase] = useState<Phase>({ step: "review" });
	const [progress, setProgress] = useState<PullProgress | null>(null);
	useEffect(() => {
		const unlisten = onPullProgress(setProgress);
		return () => {
			void unlisten.then((f) => f());
		};
	}, []);

	// What the user changed from the defaults: switches, ticks and which lists are open.
	const [switched, setSwitched] = useState<ReadonlyMap<string, boolean>>(new Map());
	const [pullFlips, setPullFlips] = useState<ReadonlySet<string>>(new Set());
	const [pushFlips, setPushFlips] = useState<ReadonlySet<number>>(new Set());
	const [open, setOpen] = useState<ReadonlyMap<string, string>>(new Map());
	const [understood, setUnderstood] = useState(false);
	// What was chosen for merges and conflicts.
	const [choices, setChoices] = useState<Choices>(new Map());

	const isOn = (id: number, side: Side) =>
		switched.get(`${id}:${side}`) ?? (mode === "both" || mode === side);
	// Songs that only exist here in another format, and opt-in changes such as deletes, start unticked.
	const pullPicked = (id: number, f: RemoteFile) =>
		!f.otherFormat !== pullFlips.has(pullKey(id, f));
	// A merge or conflict only runs once its choices are made; unticking a ready merge is a flip.
	const pushPicked = (a: SyncAction) => {
		if (isIncoming(a)) {
			return isSettled(a, choices.get(a.id)) && (a.kind === "conflict" || !pushFlips.has(a.id));
		}
		return !a.optional !== pushFlips.has(a.id);
	};

	const busy = phase.step !== "review";
	const touched = switched.size + pullFlips.size + pushFlips.size + choices.size > 0;
	const { shown, newer, waiting, error } = useReviewReads(ids, stale, touched || busy);
	const showLatest = () => {
		setSwitched(new Map());
		setPullFlips(new Set());
		setPushFlips(new Set());
		setChoices(new Map());
		setOpen(new Map());
		setUnderstood(false);
	};

	const early = notReady({
		phase,
		ready: shown.every((r) => r !== null),
		error: rescanError ?? error,
		waiting,
		progress,
		onRefresh: () => onRefresh(shown.flatMap((r) => (r ? [r.planId] : []))),
		onClose,
		variant,
	});
	// Not ready means some destination has no read yet: `early` shows the wait.
	if (early !== null) {
		return early;
	}
	const reviewed = shown.filter((r): r is TargetScan => r !== null);

	const targets = reviewed.map(({ plan: t, pull }) => {
		const missing = pull.missing;
		const pullOn = isOn(t.targetId, "pull");
		const pushOn = isOn(t.targetId, "push") && !t.error;
		const pullSel = missing.filter((f) => pullPicked(t.targetId, f));
		const pushActions = t.actions.filter(isPush);
		const incoming = t.actions.filter(isIncoming);
		const pushSel = pushActions.filter(pushPicked);
		const incomingSel = incoming.filter(pushPicked);
		return {
			plan: t,
			missing,
			pullError: pull.error,
			pullOn,
			pushOn,
			pullSel,
			pull: pullOn ? pullSel : [],
			incoming,
			incomingSel,
			incomingRun: pullOn ? incomingSel : [],
			pushActions,
			pushSel,
			push: pushOn ? pushSel : [],
		};
	});
	const pulls = targets.filter((t) => t.pull.length > 0);
	const pushIds = targets.flatMap((t) => t.push.map((a) => a.id));
	const pushed = targets.flatMap((t) => t.push);
	const removing = pushed.filter((a) => a.kind === "delete").length;
	const remoteFiles = targets
		.filter((t) => t.push.some((a) => a.kind === "delete"))
		.reduce((n, t) => n + t.plan.remoteTotal, 0);
	const incomingRun = targets.flatMap((t) => t.incomingRun);
	// Updates and merges run with the push: the plan applies them.
	const applyIds = [...pushIds, ...incomingRun.map((a) => a.id)];
	const resolutions: Record<number, Resolution> = Object.fromEntries(
		incomingRun.flatMap((a) => {
			const choice = choices.get(a.id);
			return choice ? [[a.id, choice] as const] : [];
		}),
	);
	const total = pulls.reduce((n, t) => n + t.pull.length, 0) + applyIds.length;
	// Destinations that share tags and playlists: they are exchanged first, whatever is ticked.
	const libraryIds = ids.filter((id) => syncTargets.data?.find((t) => t.id === id)?.libsync);
	// Only the plans with something ticked are applied, so an untouched old one cannot refuse.
	const applying = new Set(applyIds);
	const planIds = reviewed
		.filter((r) => r.plan.actions.some((a) => applying.has(a.id)))
		.map((r) => r.planId);
	const refresh = () => onRefresh(reviewed.map((r) => r.planId));

	const run = async () => {
		try {
			setPhase({ step: "pulling" });
			const library = await exchangeLibraryData(libraryIds, queryClient);
			const pulled: PullOutcome[] = [];
			for (const t of pulls) {
				pulled.push(
					await remotePull(
						t.plan.targetId,
						t.pull.map((f) => f.rel),
					),
				);
			}
			if (pulled.length > 0) {
				await queryClient.invalidateQueries({ queryKey: ["tracks"] });
				await queryClient.invalidateQueries({ queryKey: ["library-status"] });
			}
			setPhase({ step: "pushing" });
			const result =
				applyIds.length > 0
					? await apply.mutateAsync({ planIds, actionIds: applyIds, resolutions })
					: [];
			setPhase({ step: "done", pulled, pushed: result, library });
		} catch (e) {
			setPhase({ step: "failed", error: String(e) });
		}
	};

	return (
		<SyncShell
			variant={variant}
			footer={
				<>
					<DeleteGuard
						removing={removing}
						remoteFiles={remoteFiles}
						understood={understood}
						onChange={setUnderstood}
					/>
					<div className="space-y-1.5">
						<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
							<Tally
								items={[
									{
										tone: "add",
										label: "to pull",
										count: pulls.reduce((n, t) => n + t.pull.length, 0),
									},
									{
										tone: "change",
										label: "to update your library",
										count: incomingRun.length,
									},
									...KINDS.map((k) => ({
										tone: LABEL[k].tone,
										label: LABEL[k].label.toLowerCase(),
										count: pushed.filter((a) => a.kind === k).length,
									})),
								]}
								empty="Nothing selected"
							/>
							<span className="text-muted-foreground text-xs tabular-nums">
								{formatBytes(
									bytes(pulls.flatMap((t) => t.pull)) +
										bytes(incomingRun) +
										bytes(pushed.filter((a) => a.kind === "upload" || a.kind === "replace")),
								)}
							</span>
						</div>
						<ChangeBar
							parts={[
								{ tone: "add", count: pulls.reduce((n, t) => n + t.pull.length, 0) },
								{ tone: "change", count: incomingRun.length },
								...KINDS.map((k) => ({
									tone: LABEL[k].tone,
									count: pushed.filter((a) => a.kind === k).length,
								})),
							]}
						/>
					</div>
					<RunStatus phase={phase} pulling={progress} />
					<div className="flex gap-2">
						<Button variant="outline" onClick={refresh} disabled={busy}>
							Refresh
						</Button>
						{onClose && (
							<Button variant="outline" onClick={onClose} disabled={busy}>
								Close
							</Button>
						)}
						<Button
							className="flex-1"
							onClick={() => void run()}
							disabled={
								busy || (total === 0 && libraryIds.length === 0) || (removing > 0 && !understood)
							}
						>
							<RefreshCw className={busy ? "animate-spin motion-reduce:animate-none" : ""} />
							{busy
								? "Syncing…"
								: total === 0
									? "Sync library data"
									: `Sync ${total.toLocaleString()} changes`}
						</Button>
					</div>
				</>
			}
		>
			<div>
				<NewerRead show={newer && !busy} onShow={showLatest} />
				{targets.map((t) => (
					<TargetBlock
						key={t.plan.targetId}
						t={t}
						multi={ids.length > 1}
						open={open}
						ui={{
							setOpen,
							setSwitched,
							setPullFlips,
							setPushFlips,
							setChoices,
							choices,
							pullPicked,
							pushPicked,
						}}
					/>
				))}
			</div>
		</SyncShell>
	);
}

/** Offers the destination's newer read when the one on screen was kept for the user's ticks. */
function NewerRead({ show, onShow }: { show: boolean; onShow: () => void }) {
	if (!show) {
		return null;
	}
	return (
		<div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-[var(--diff-inset)] py-2 text-sm">
			<span className="text-muted-foreground">
				The destination was read again since you started ticking.
			</span>
			<Button size="sm" variant="outline" onClick={onShow}>
				Show the latest
			</Button>
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
	return <RunProgress done={done} total={total} current={current} />;
}
