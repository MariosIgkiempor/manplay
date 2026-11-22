import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import {
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ChangeBar, RunProgress, Tally } from "#/components/diff-view.tsx";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { SyncResult } from "#/components/sync-result.tsx";
import { DeleteGuard, KINDS, LABEL } from "#/components/sync-review.tsx";
import type { ReviewControls } from "#/components/sync-review-item.tsx";
import { ReviewLanes } from "#/components/sync-review-lanes.tsx";
import { FolderTree } from "#/components/sync-review-tree.tsx";
import { ReviewViewMenu } from "#/components/sync-review-view-menu.tsx";
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
	targetShortName,
} from "#/lib/api.ts";
import { formatBytes, timeAgo } from "#/lib/format.ts";
import {
	DELETED_KEY,
	useSyncApply,
	useSyncRescan,
	useSyncScans,
	useSyncTargets,
	useTargetScans,
	useTracks,
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
	onlyThere,
	type PushAction,
	type SyncDirection,
	type ThereChoice,
	type ThereFile,
} from "#/lib/sync-choices.ts";
import {
	type AlbumInfo,
	isSend,
	reviewItems,
	type SendAction,
	type TrackLookup,
} from "#/lib/sync-review-model.ts";
import { parseReviewView, type ReviewView } from "#/lib/sync-review-view.ts";
import { cn } from "#/lib/utils.ts";

/** Which directions a sync starts with. */
export type SyncMode = SyncDirection;

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

/**
 * Sync with the destinations: shows what their last background read found at once, as one
 * decision per song, by album or as the destination's folders after the sync. Nothing changes until
 * Sync. Refresh reads them again and waits for that.
 */
export function SyncPanel({
	ids,
	mode: startMode = "both",
	variant = "drawer",
	onClose,
	onModeChange,
}: {
	ids: number[];
	/** The direction the review starts in; the toolbar switches it. */
	mode?: SyncMode;
	variant?: SyncShellVariant;
	onClose?: () => void;
	onModeChange?: (mode: SyncMode) => void;
}) {
	const rescan = useSyncRescan();
	// Kept here so a Refresh, which starts the review afresh, keeps the chosen direction.
	const [mode, setMode] = useState<SyncMode>(startMode);
	const chooseMode = (next: SyncMode) => {
		setMode(next);
		onModeChange?.(next);
	};
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
			onMode={chooseMode}
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
	send: SendAction[];
	sendSel: SendAction[];
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
	setFlips: Dispatch<SetStateAction<ReadonlySet<number>>>;
	setThere: Dispatch<SetStateAction<ReadonlyMap<string, ThereChoice>>>;
	setChoices: Dispatch<SetStateAction<Choices>>;
	choices: Choices;
	picked: (a: SyncAction) => boolean;
	thereChoice: (id: number, f: ThereFile) => ThereChoice;
}

const count = (n: number) => n.toLocaleString();

/** The review's view, remembered on this device. */
const VIEW_KEY = "manplay.sync.reviewView";

function useReviewView() {
	const [view, setView] = useState<ReviewView>(() => {
		try {
			return parseReviewView(localStorage.getItem(VIEW_KEY));
		} catch {
			return parseReviewView(null);
		}
	});
	const choose = (next: ReviewView) => {
		setView(next);
		try {
			localStorage.setItem(VIEW_KEY, next);
		} catch {
			// Remembering the view is a convenience only.
		}
	};
	return [view, choose] as const;
}

/** Album and album artist of each library song, for the album view. */
function useTrackLookup(): TrackLookup {
	const tracks = useTracks().data;
	return useMemo(() => {
		const byId = new Map<number, AlbumInfo>(
			(tracks ?? []).map(({ id, album, artist, fields }) => {
				const { albumArtist } = fields;
				return [id, { album, artist: albumArtist?.trim() || artist }];
			}),
		);
		return (id: number) => byId.get(id);
	}, [tracks]);
}

const MODES: {
	mode: SyncMode;
	label: string;
	hint: string;
	icon: ReactNode;
	/** The button's colour while chosen; the icon keeps it while not. */
	on: string;
	tint: string;
}[] = [
	{
		mode: "both",
		label: "Both ways",
		hint: "Tick what goes out and what comes in.",
		icon: <ArrowUpDown />,
		on: "border-foreground/30 bg-foreground/10 text-foreground",
		tint: "[&_svg]:text-foreground",
	},
	{
		mode: "push",
		label: "Push only",
		hint: "Tick only what goes to the destination.",
		icon: <ArrowUp />,
		on: "border-primary/50 bg-primary/15 text-primary",
		tint: "[&_svg]:text-primary",
	},
	{
		mode: "pull",
		label: "Pull only",
		hint: "Tick only what comes into your library.",
		icon: <ArrowDown />,
		on: "border-success/50 bg-success/15 text-success",
		tint: "[&_svg]:text-success",
	},
];

/** The direction buttons, and on the right the view menu: Albums or Folders, and its options. */
function ReviewToolbar({
	mode,
	onMode,
	view,
	onView,
	showUnchanged,
	onShowUnchanged,
}: {
	mode: SyncMode;
	onMode: (m: SyncMode) => void;
	view: ReviewView;
	onView: (v: ReviewView) => void;
	showUnchanged: boolean;
	onShowUnchanged: (on: boolean) => void;
}) {
	return (
		<div className="sticky top-0 z-30 flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-background px-[var(--diff-inset)] py-2 text-sm">
			<fieldset className="flex gap-1.5">
				<legend className="sr-only">Sync direction</legend>
				{MODES.map((m) => {
					const chosen = mode === m.mode;
					return (
						<Button
							key={m.mode}
							size="sm"
							variant="outline"
							aria-pressed={chosen}
							title={`${m.hint} Starts your ticks again.`}
							onClick={() => onMode(m.mode)}
							className={cn(chosen ? m.on : "text-muted-foreground", !chosen && m.tint)}
						>
							{m.icon}
							{m.label}
						</Button>
					);
				})}
			</fieldset>
			<div className="ml-auto">
				<ReviewViewMenu
					view={view}
					onView={onView}
					showUnchanged={showUnchanged}
					onShowUnchanged={onShowUnchanged}
				/>
			</div>
		</div>
	);
}

/** One destination: how much already matches, what is ticked, then its files in the chosen view. */
function TargetBlock({
	t,
	destination,
	direction,
	multi,
	view,
	showUnchanged,
	lookup,
	ui,
}: {
	t: Row;
	/** The destination's short name, for the section titles. */
	destination: string;
	direction: SyncMode;
	multi: boolean;
	view: ReviewView;
	showUnchanged: boolean;
	lookup: TrackLookup;
	ui: Ui;
}) {
	const { setFlips, setThere, setChoices, choices, picked, thereChoice } = ui;
	const id = t.plan.targetId;
	const items = reviewItems(t.send, t.incoming, t.there);
	const controls: ReviewControls = {
		picked,
		choiceOf: (a) => choices.get(a.id),
		// A conflict is ticked by choosing a copy; unticking forgets the choice.
		toggle: (a) =>
			a.kind === "conflict"
				? setChoices((m) => {
						const next = new Map(m);
						next.delete(a.id);
						return next;
					})
				: setFlips((s) => flip(s, a.id)),
		toggleAll: (actions, on) =>
			setFlips((s) => {
				let next = s;
				for (const a of actions) {
					if (a.kind !== "conflict" && picked(a) !== on) {
						next = flip(next, a.id);
					}
				}
				return next;
			}),
		resolve: (a, next) => setChoices((m) => new Map(m).set(a.id, next)),
		there: (f) => thereChoice(id, f),
		chooseThere: (files, c) => setThere((m) => chooseAll(m, id, files, c)),
	};
	const needChoice = t.incoming.filter((a) => !picked(a)).length;
	const notes = [
		...(t.plan.held.length > 0 ? [`${count(t.plan.held.length)} kept for 7 days`] : []),
		...(t.plan.unchecked > 0 ? [`${count(t.plan.unchecked)} not compared`] : []),
	];
	const header = multi || needChoice > 0 || notes.length > 0;
	return (
		<section>
			{header && (
				<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b px-[var(--diff-inset)] py-2">
					{multi && <h3 className="break-words font-semibold text-sm">{t.plan.name}</h3>}
					{needChoice > 0 && (
						<span className="text-sm text-warning">{count(needChoice)} need a choice</span>
					)}
					{notes.length > 0 && (
						<span className="ml-auto text-muted-foreground text-xs tabular-nums">
							{notes.join(" · ")}
						</span>
					)}
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
			{items.length === 0 && !t.plan.error && (
				<p className="flex items-center gap-2 px-[var(--diff-inset)] py-3 text-muted-foreground text-sm">
					<CheckCircle2 className="size-4 text-success" /> Up to date
				</p>
			)}
			{items.length > 0 &&
				(view === "albums" ? (
					<ReviewLanes
						items={items}
						destination={destination}
						direction={direction}
						lookup={lookup}
						controls={controls}
					/>
				) : (
					<FolderTree
						items={items}
						folders={t.plan.folders}
						controls={controls}
						showUnchanged={showUnchanged}
					/>
				))}
			{t.plan.held.length > 0 && (
				<details className="mx-[var(--diff-inset)] mb-3 rounded-md border px-3 py-2 text-xs">
					<summary className="cursor-pointer text-muted-foreground">
						{count(t.plan.held.length)} kept for 7 days after leaving the library
					</summary>
					<ul className="mt-2 space-y-0.5 font-mono">
						{t.plan.held.slice(0, 50).map((h) => (
							<li key={h.rel.join("/")} className="break-all">
								{h.rel.join("/")}
							</li>
						))}
						{t.plan.held.length > 50 && <li>…and {count(t.plan.held.length - 50)} more</li>}
					</ul>
				</details>
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
		const send = pushes.filter(isSend);
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
	onMode,
	variant,
	onClose,
	onRefresh,
	rescanError,
}: {
	ids: number[];
	/** Reads shown before a Refresh: waited past, never shown again. */
	stale: ReadonlySet<PlanId>;
	mode: SyncMode;
	onMode: (mode: SyncMode) => void;
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

	// What the user changed from the suggestions: ticks and choices.
	const [flips, setFlips] = useState<ReadonlySet<number>>(new Set());
	const [there, setThere] = useState<ReadonlyMap<string, ThereChoice>>(new Map());
	const [view, setView] = useReviewView();
	const [showUnchanged, setShowUnchanged] = useState(false);
	const lookup = useTrackLookup();
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
		setUnderstood(false);
	};
	// Ticks are kept as changes from the direction's suggestions, so a new direction starts clean.
	const switchMode = (next: SyncMode) => {
		if (next !== mode) {
			showLatest();
			onMode(next);
		}
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
	const shortName = (plan: TargetPlan) => {
		const target = syncTargets.data?.find((x) => x.id === plan.targetId);
		return target ? targetShortName(target) : plan.name;
	};

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
				<ReviewToolbar
					mode={mode}
					onMode={switchMode}
					view={view}
					onView={setView}
					showUnchanged={showUnchanged}
					onShowUnchanged={setShowUnchanged}
				/>
				{targets.map((t) => (
					<TargetBlock
						// A new direction starts the sections folded afresh.
						key={`${t.plan.targetId}:${mode}`}
						t={t}
						destination={shortName(t.plan)}
						direction={mode}
						multi={ids.length > 1}
						view={view}
						showUnchanged={showUnchanged}
						lookup={lookup}
						ui={{ setFlips, setThere, setChoices, choices, picked, thereChoice }}
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
