import { useQueryClient } from "@tanstack/react-query";
import {
	CheckCircle2,
	ChevronRight,
	CloudUpload,
	Download,
	FolderSearch,
	Loader2,
	RefreshCw,
} from "lucide-react";
import {
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";
import { ChangeBar, RunProgress, Tally, TONE, type Tone } from "#/components/diff-view.tsx";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { IncomingList } from "#/components/sync-incoming.tsx";
import { OnlyThereList } from "#/components/sync-only-there.tsx";
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
import { formatBytes, timeAgo } from "#/lib/format.ts";
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
	chooseAll,
	type IncomingAction,
	isIncoming,
	isPicked,
	isPush,
	isSettled,
	onlyThere,
	type PushAction,
	type SyncDirection,
	type ThereChoice,
	type ThereFile,
} from "#/lib/sync-choices.ts";
import { cn } from "#/lib/utils.ts";

/** Which directions a sync starts with. */
export type SyncMode = SyncDirection;
type Group = "send" | "bring" | "there";

const bytes = (items: readonly { size: number }[]) => items.reduce((n, i) => n + i.size, 0);
const flip = <T,>(set: ReadonlySet<T>, v: T): Set<T> => {
	const next = new Set(set);
	if (!next.delete(v)) {
		next.add(v);
	}
	return next;
};

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

/** One group of a destination's changes: a header with what it holds, and the list on demand. */
function Section({
	icon,
	title,
	summary,
	size,
	open,
	onOpen,
	children,
}: {
	icon: ReactNode;
	title: string;
	/** Counts after the title; they may be buttons that open the list. */
	summary: ReactNode;
	size: number;
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
					open && "border-b",
				)}
			>
				<button
					type="button"
					aria-expanded={open}
					onClick={onOpen}
					className="flex shrink-0 items-center gap-1.5 rounded-md font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-4"
				>
					{icon}
					{title}
				</button>
				<span className="min-w-0">{summary}</span>
				{/* The empty stretch of the row opens the list too. */}
				<button
					type="button"
					tabIndex={-1}
					aria-hidden="true"
					onClick={onOpen}
					className="flex min-w-0 flex-1 items-center justify-end gap-3 self-stretch text-muted-foreground"
				>
					{size > 0 && <span className="text-xs tabular-nums">{formatBytes(size)}</span>}
					<ChevronRight
						className={cn(
							"size-4 shrink-0 transition-transform motion-reduce:transition-none",
							open && "rotate-90",
						)}
					/>
				</button>
			</div>
			{open && <div>{children}</div>}
		</div>
	);
}

/**
 * Sync with the destinations: shows what their last background read found at once, as one
 * decision per song in three groups (send there, bring here, only there). Nothing changes until
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
	pullError: string | null;
	/** Library files to put on the destination: new, changed or moved. */
	send: PushAction[];
	sendSel: PushAction[];
	/** Files edited on the destination that would change the library. */
	incoming: IncomingAction[];
	incomingSel: IncomingAction[];
	/** Files only on the destination, one decision each. */
	there: ThereFile[];
	/** What the there-choices come to. */
	pulls: RemoteFile[];
	deletes: PushAction[];
}

/** The state setters and lookups a destination's block works through. */
interface Ui {
	setOpen: Dispatch<SetStateAction<ReadonlyMap<string, string>>>;
	setFlips: Dispatch<SetStateAction<ReadonlySet<number>>>;
	setThere: Dispatch<SetStateAction<ReadonlyMap<string, ThereChoice>>>;
	setChoices: Dispatch<SetStateAction<Choices>>;
	choices: Choices;
	picked: (a: SyncAction) => boolean;
	thereChoice: (id: number, f: ThereFile) => ThereChoice;
}

const count = (n: number) => n.toLocaleString();

function Count({ tone, n, label }: { tone: Tone; n: number; label: string }) {
	if (n === 0) {
		return null;
	}
	return (
		<span>
			<span className={cn("font-medium", TONE[tone].text)}>
				{TONE[tone].sign}
				{count(n)}
			</span>{" "}
			<span className="text-muted-foreground">{label}</span>
		</span>
	);
}

/** Files edited on the destination: updates, merges and conflicts, with their ticks and choices. */
function BringList({ t, ui }: { t: Row; ui: Ui }) {
	const { setFlips, setChoices, choices, picked } = ui;
	return (
		<IncomingList
			actions={t.incoming}
			choices={choices}
			picked={picked}
			// A conflict is ticked by choosing a copy; unticking forgets the choice.
			onToggle={(a) =>
				a.kind === "conflict"
					? setChoices((m) => {
							const next = new Map(m);
							next.delete(a.id);
							return next;
						})
					: setFlips((s) => flip(s, a.id))
			}
			onToggleAll={(items, on) =>
				setFlips((s) => {
					let next = s;
					for (const a of items) {
						if (a.kind !== "conflict" && isSettled(a, choices.get(a.id)) && picked(a) !== on) {
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

/** One destination: how much already matches, then what to send, bring and settle. */
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
	const { setOpen, setFlips, setThere, picked, thereChoice } = ui;
	const id = t.plan.targetId;
	const name = t.plan.name;
	const skipped = new Set(t.send.filter((a) => !picked(a)).map((a) => a.id));
	const needChoice = t.incoming.filter((a) => !picked(a)).length;
	const nothing = t.send.length + t.incoming.length + t.there.length === 0;
	// Pressing the title opens the list; with a filter on it first clears the filter, and only a
	// list showing everything closes.
	const toggleOpen = (group: Group) =>
		setOpen((prev) => {
			const next = new Map(prev);
			const at = `${id}:${group}`;
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
			new Map(prev).set(`${id}:send`, prev.get(`${id}:send`) === kind ? "all" : kind),
		);
	const sendFilter = (open.get(`${id}:send`) ?? "all") as PushFilter;
	const thereCounts = {
		pull: t.pulls.length,
		delete: t.deletes.length,
		leave: t.there.length - t.pulls.length - t.deletes.length,
	};
	return (
		<section key={id}>
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 px-[var(--diff-inset)] py-2">
				{multi ? <h3 className="break-words font-semibold text-sm">{name}</h3> : <span />}
				<span className="text-muted-foreground text-xs tabular-nums">
					{count(t.plan.inSync)} already match
					{t.plan.held.length > 0 && ` · ${count(t.plan.held.length)} kept for 7 days`}
					{t.plan.unchecked > 0 && ` · ${count(t.plan.unchecked)} not compared`}
				</span>
			</div>
			{[...new Set([t.pullError, t.plan.error])].map(
				(message) =>
					message && (
						<ErrorLine key={message} className="px-[var(--diff-inset)] py-2">
							{message}
						</ErrorLine>
					),
			)}
			{nothing && !t.plan.error && (
				<p className="flex items-center gap-2 border-t px-[var(--diff-inset)] py-3 text-muted-foreground text-sm">
					<CheckCircle2 className="size-4 text-success" /> Up to date
				</p>
			)}
			{t.send.length > 0 && (
				<Section
					icon={<CloudUpload />}
					title={`Send to ${name}`}
					size={bytes(t.sendSel.filter((a) => a.kind !== "move"))}
					open={open.has(`${id}:send`)}
					onOpen={() => toggleOpen("send")}
					summary={
						<FilterTally
							counts={countKinds(t.sendSel)}
							totals={countKinds(t.send)}
							active={(open.get(`${id}:send`) as PushFilter | undefined) ?? null}
							onPick={pickKind}
						/>
					}
				>
					<PushList
						filter={sendFilter}
						onShowAll={() => setOpen((prev) => new Map(prev).set(`${id}:send`, "all"))}
						plan={{ ...t.plan, actions: t.send, held: [], unchecked: 0 }}
						skipped={skipped}
						onToggle={(aid) => setFlips((s) => flip(s, aid))}
						onToggleAll={(aids, on) =>
							setFlips((s) => {
								let next = s;
								for (const a of t.send.filter((x) => aids.includes(x.id))) {
									if (picked(a) !== on) {
										next = flip(next, a.id);
									}
								}
								return next;
							})
						}
					/>
				</Section>
			)}
			{t.incoming.length > 0 && (
				<Section
					icon={<Download />}
					title="Bring into your library"
					size={bytes(t.incomingSel)}
					open={open.has(`${id}:bring`)}
					onOpen={() => toggleOpen("bring")}
					summary={
						<span className="inline-flex flex-wrap gap-x-4 text-sm tabular-nums">
							<Count tone="change" n={t.incomingSel.length} label={`edited on ${name}`} />
							{needChoice > 0 && (
								<span className="text-warning">{count(needChoice)} need a choice</span>
							)}
						</span>
					}
				>
					<BringList t={t} ui={ui} />
				</Section>
			)}
			{t.there.length > 0 && (
				<Section
					icon={<FolderSearch />}
					title={`Only on ${name}`}
					size={bytes(t.pulls) + bytes(t.deletes)}
					open={open.has(`${id}:there`)}
					onOpen={() => toggleOpen("there")}
					summary={
						<span className="inline-flex flex-wrap gap-x-4 text-sm tabular-nums">
							<Count tone="add" n={thereCounts.pull} label="copy here" />
							<Count tone="remove" n={thereCounts.delete} label="delete there" />
							{thereCounts.leave > 0 && (
								<span className="text-muted-foreground">{count(thereCounts.leave)} left</span>
							)}
						</span>
					}
				>
					<OnlyThereList
						files={t.there}
						choice={(f) => thereChoice(id, f)}
						onChoose={(f, c) => setThere((m) => new Map(m).set(`${id}:${f.key}`, c))}
						onChooseAll={(c) => setThere((m) => chooseAll(m, id, t.there, c))}
					/>
				</Section>
			)}
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

/**
 * Runs what the review settled: library data first, then copies into the library, then
 * everything the plans apply (sends, deletes, updates, merges). `setPhase` follows each step.
 */
async function runSync({
	libraryIds,
	pulls,
	applyIds,
	planIds,
	resolutions,
	queryClient,
	apply,
	setPhase,
}: {
	libraryIds: number[];
	pulls: readonly Row[];
	applyIds: number[];
	planIds: PlanId[];
	resolutions: Record<number, Resolution>;
	queryClient: ReturnType<typeof useQueryClient>;
	apply: (args: {
		planIds: PlanId[];
		actionIds: number[];
		resolutions: Record<number, Resolution>;
	}) => Promise<ApplySummary[]>;
	setPhase: (phase: Phase) => void;
}) {
	try {
		setPhase({ step: "pulling" });
		const library = await exchangeLibraryData(libraryIds, queryClient);
		const pulled: PullOutcome[] = [];
		for (const t of pulls) {
			pulled.push(
				await remotePull(
					t.plan.targetId,
					t.pulls.map((f) => f.rel),
				),
			);
		}
		if (pulled.length > 0) {
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["library-status"] });
		}
		setPhase({ step: "pushing" });
		const pushed =
			applyIds.length > 0 ? await apply({ planIds, actionIds: applyIds, resolutions }) : [];
		setPhase({ step: "done", pulled, pushed, library });
	} catch (e) {
		setPhase({ step: "failed", error: String(e) });
	}
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

/** Each destination's read split into what to send, bring and settle, with what is chosen. */
function toRows(
	reviewed: readonly TargetScan[],
	mode: SyncMode,
	picked: (a: SyncAction) => boolean,
	thereChoice: (id: number, f: ThereFile) => ThereChoice,
): Row[] {
	return reviewed.map(({ plan: t, pull }) => {
		const pushes = t.actions.filter(isPush);
		const send = pushes.filter((a) => a.kind !== "delete");
		const incoming = t.actions.filter(isIncoming);
		const thereFiles = onlyThere(pull.missing, pushes, mode);
		const chosen = (c: ThereChoice) => thereFiles.filter((f) => thereChoice(t.targetId, f) === c);
		return {
			plan: t,
			pullError: pull.error,
			send,
			sendSel: t.error ? [] : send.filter(picked),
			incoming,
			incomingSel: incoming.filter(picked),
			there: thereFiles,
			pulls: chosen("pull").flatMap((f) => (f.pull ? [f.pull] : [])),
			deletes: chosen("delete").flatMap((f) => (f.remove ? [f.remove] : [])),
		};
	});
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

	// What the user changed from the suggestions: ticks, choices and which lists are open.
	const [flips, setFlips] = useState<ReadonlySet<number>>(new Set());
	const [there, setThere] = useState<ReadonlyMap<string, ThereChoice>>(new Map());
	const [open, setOpen] = useState<ReadonlyMap<string, string>>(new Map());
	const [understood, setUnderstood] = useState(false);
	// What was chosen for merges and conflicts.
	const [choices, setChoices] = useState<Choices>(new Map());

	const picked = (a: SyncAction) => isPicked(a, mode, flips.has(a.id), choices.get(a.id));
	const thereChoice = (id: number, f: ThereFile) => there.get(`${id}:${f.key}`) ?? f.suggested;

	const busy = phase.step !== "review";
	const touched = flips.size + there.size + choices.size > 0;
	const { shown, newer, waiting, error } = useReviewReads(ids, stale, touched || busy);
	const showLatest = () => {
		setFlips(new Set());
		setThere(new Map());
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

	const targets = toRows(reviewed, mode, picked, thereChoice);
	const pulls = targets.filter((t) => t.pulls.length > 0);
	const pushed = targets.flatMap((t) => [...t.sendSel, ...t.deletes]);
	const pushIds = pushed.map((a) => a.id);
	const removing = pushed.filter((a) => a.kind === "delete").length;
	const remoteFiles = targets
		.filter((t) => t.deletes.length > 0)
		.reduce((n, t) => n + t.plan.remoteTotal, 0);
	const incomingRun = targets.flatMap((t) => t.incomingSel);
	// Updates and merges run with the push: the plan applies them.
	const applyIds = [...pushIds, ...incomingRun.map((a) => a.id)];
	const resolutions: Record<number, Resolution> = Object.fromEntries(
		incomingRun.flatMap((a) => {
			const choice = choices.get(a.id);
			return choice ? [[a.id, choice] as const] : [];
		}),
	);
	const pullCount = pulls.reduce((n, t) => n + t.pulls.length, 0);
	const total = pullCount + applyIds.length;
	// Destinations that share tags and playlists: they are exchanged first, whatever is ticked.
	const libraryIds = ids.filter((id) => syncTargets.data?.find((t) => t.id === id)?.libsync);
	// Only the plans with something ticked are applied, so an untouched old one cannot refuse.
	const applying = new Set(applyIds);
	const planIds = reviewed
		.filter((r) => r.plan.actions.some((a) => applying.has(a.id)))
		.map((r) => r.planId);
	const refresh = () => onRefresh(reviewed.map((r) => r.planId));

	const run = () =>
		runSync({
			libraryIds,
			pulls,
			applyIds,
			planIds,
			resolutions,
			queryClient,
			apply: apply.mutateAsync,
			setPhase,
		});

	if (showsUpToDate(phase, newer, targets)) {
		return (
			<UpToDate
				variant={variant}
				targets={targets}
				scannedAt={Math.min(...reviewed.map((r) => r.scannedAt))}
				libraryData={libraryIds.length > 0}
				onRefresh={refresh}
				onSyncLibrary={() => void run()}
				onClose={onClose}
			/>
		);
	}

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
									{ tone: "add", label: "to copy here", count: pullCount },
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
									bytes(pulls.flatMap((t) => t.pulls)) +
										bytes(incomingRun) +
										bytes(pushed.filter((a) => a.kind === "upload" || a.kind === "replace")),
								)}
							</span>
						</div>
						<ChangeBar
							parts={[
								{ tone: "add", count: pullCount },
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
						<SyncButton
							busy={busy}
							total={total}
							libraryData={libraryIds.length > 0}
							needsConfirm={removing > 0 && !understood}
							onRun={() => void run()}
						/>
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
						ui={{ setOpen, setFlips, setThere, setChoices, choices, picked, thereChoice }}
					/>
				))}
			</div>
		</SyncShell>
	);
}

/**
 * Whether the review is the up-to-date screen: still reviewing, no newer read waiting, and every
 * destination read with nothing to send, bring or settle.
 */
const showsUpToDate = (phase: Phase, newer: boolean, targets: readonly Row[]) =>
	phase.step === "review" &&
	!newer &&
	targets.length > 0 &&
	targets.every(
		(t) =>
			t.send.length + t.incoming.length + t.there.length === 0 &&
			t.plan.error === null &&
			t.pullError === null,
	);

/**
 * Nothing to send, bring or settle anywhere: one calm line on how much matches and when it was
 * checked, with Refresh. Destinations sharing library data still offer to exchange it.
 */
function UpToDate({
	variant,
	targets,
	scannedAt,
	libraryData,
	onRefresh,
	onSyncLibrary,
	onClose,
}: {
	variant: SyncShellVariant;
	targets: readonly Row[];
	scannedAt: number;
	libraryData: boolean;
	onRefresh: () => void;
	onSyncLibrary: () => void;
	onClose: (() => void) | undefined;
}) {
	const matching = targets.reduce((n, t) => n + t.plan.inSync, 0);
	const only = targets.length === 1 ? targets[0] : undefined;
	const where = only ? only.plan.name : `${targets.length} destinations`;
	const held = targets.reduce((n, t) => n + t.plan.held.length, 0);
	return (
		<SyncShell
			variant={variant}
			footer={
				(libraryData || onClose) && (
					<div className="flex gap-2">
						{onClose && (
							<Button variant="outline" onClick={onClose}>
								Close
							</Button>
						)}
						{libraryData && (
							<Button className="flex-1" onClick={onSyncLibrary}>
								<RefreshCw /> Sync library data
							</Button>
						)}
					</div>
				)
			}
		>
			<EmptyState
				className="py-16"
				icon={<CheckCircle2 className="size-8 text-success" />}
				title={only ? `${only.plan.name} is up to date` : "Everything is up to date"}
				action={
					<Button size="sm" variant="outline" onClick={onRefresh}>
						<RefreshCw /> Check again
					</Button>
				}
			>
				{matching > 0
					? `All ${count(matching)} songs match ${where}.`
					: `Nothing to sync with ${where}.`}{" "}
				Checked {timeAgo(scannedAt)}.
				{held > 0 && ` ${count(held)} removed songs are kept there for 7 days.`}
			</EmptyState>
		</SyncShell>
	);
}

/** The footer's main button: how many changes run, or only the library data exchange. */
function SyncButton({
	busy,
	total,
	libraryData,
	needsConfirm,
	onRun,
}: {
	busy: boolean;
	total: number;
	libraryData: boolean;
	/** Deletes are ticked but not confirmed yet. */
	needsConfirm: boolean;
	onRun: () => void;
}) {
	let label = `Sync ${total.toLocaleString()} changes`;
	if (busy) {
		label = "Syncing…";
	} else if (total === 0) {
		label = "Sync library data";
	}
	return (
		<Button
			className="flex-1"
			onClick={onRun}
			disabled={busy || (total === 0 && !libraryData) || needsConfirm}
		>
			<RefreshCw className={busy ? "animate-spin motion-reduce:animate-none" : ""} />
			{label}
		</Button>
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
