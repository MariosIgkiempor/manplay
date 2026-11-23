import { Check, Copy, FolderOpen, Play, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { fileMenuEntries } from "#/components/file-menu.tsx";
import { RowMenu } from "#/components/menu.tsx";
import { ErrorLine } from "#/components/page.tsx";
import {
	ActionBar,
	DiffGroup,
	DiffLine,
	type DiffSide,
	MarkedName,
	NoteChip,
	PROBLEM_ROW,
	ProblemList,
	ProblemsCleared,
	ProblemText,
	ReviewSheet,
} from "#/components/problem-panel.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ConfirmButton } from "#/components/ui/confirm-button.tsx";

import { PanelBarTitle } from "#/context/panel-bar.tsx";
import { usePlayer } from "#/context/player-context.ts";
import {
	type CarryCandidate,
	type DuplicateGroup,
	fsReveal,
	type TrashDuplicatesReport,
} from "#/lib/api.ts";
import { confirmTrash } from "#/lib/confirm.ts";
import {
	type CueApp,
	copyMarker,
	cuesLostWith,
	type DuplicateCopy,
	decideGroups,
	extraCopies,
	type GroupChoice,
	type GroupDecision,
	type GroupKey,
	type KeepReason,
	type TrashPlan,
	trashPlan,
	type UndecidedReason,
} from "#/lib/duplicates.ts";
import { formatBytes } from "#/lib/format.ts";
import { baseName, relSegments } from "#/lib/fs-path.ts";
import { FILE_MANAGER, TRASH } from "#/lib/platform.ts";
import {
	useAudit,
	useCarryCandidates,
	useCarryDecision,
	useDuplicates,
	useFsTrash,
	useLibraryRoot,
	useTracks,
	useTrashDuplicates,
} from "#/lib/queries.ts";
import { cn } from "#/lib/utils.ts";

/** Status bar notice: the same audio is stored in more than one file, or a song was re-encoded. */
export function DuplicatesIndicator({ onClick }: { onClick: () => void }) {
	const groups = useDuplicates().data ?? [];
	const carry = useCarryCandidates().data ?? [];
	if (groups.length === 0 && carry.length === 0) {
		return null;
	}
	if (groups.length === 0) {
		return (
			<button
				type="button"
				onClick={onClick}
				data-hint={`${carry.length} re-encoded ${carry.length === 1 ? "song" : "songs"}: they can take their tags and playlists along`}
				aria-label={`${carry.length} re-encoded ${carry.length === 1 ? "song" : "songs"}`}
				className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-warning hover:bg-warning/15"
			>
				<Copy className="size-3.5" />
				{carry.length} re-encoded
			</button>
		);
	}
	const copies = extraCopies(groups);
	return (
		<button
			type="button"
			onClick={onClick}
			data-hint={`${copies} duplicate ${copies === 1 ? "file" : "files"}: songs stored more than once. Show them.`}
			aria-label={`${copies} duplicate ${copies === 1 ? "file" : "files"}`}
			className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-warning hover:bg-warning/15"
		>
			<Copy className="size-3.5" />
			{copies} {copies === 1 ? "duplicate" : "duplicates"}
		</button>
	);
}

/** What an undecided group says under its title: pick a copy, and why none was picked. */
/** Why no copy was picked, on hovering "Pick one". */
const UNDECIDED_HINT: Record<UndecidedReason, string> = {
	unclear: "Neither the names nor file issues single out one copy",
	signsDisagree: "The plain-named copy has file issues and a copy marked as one has none",
	cuesWouldGo: "Cue points are only in a copy that would go",
};

const CUE_APP_NAME: Record<CueApp, string> = { serato: "Serato", traktor: "Traktor" };

function cueNames(apps: readonly CueApp[]): string {
	return apps.map((a) => CUE_APP_NAME[a]).join(" and ");
}

/** Chips under a copy's name: cue points held in its own tags, a warning when it would go. */
function copyNotes(
	copy: DuplicateCopy,
	side: DiffSide,
): { text: string; tone: "warning" | "muted" }[] {
	return copy.embeddedCues.length > 0
		? [
				{
					text: `${cueNames(copy.embeddedCues)} cues`,
					tone: side === "remove" ? "warning" : "muted",
				},
			]
		: [];
}

/** Why the copy that stays was picked, on hovering its mark. */
const KEEP_REASON: Record<KeepReason, string> = {
	unmarked: "Kept: the other names end like a copy",
	tidy: "Kept: the others have file issues",
	picked: "Kept: your pick",
};

function sideHint(decision: GroupDecision, side: DiffSide): string | undefined {
	if (decision.kind === "keep" && side === "keep") {
		return KEEP_REASON[decision.reason];
	}
	return side === "remove" ? `Goes to the ${TRASH}` : undefined;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The folder a copy is in, below the library folder. */
function folderOf(root: string, path: string): string {
	return relSegments(root, path).slice(0, -1).join(" / ") || "Library folder";
}

/** A copy's name with its copy marker struck, given the other copies of the same song. */
function CopyName({ copy, group }: { copy: DuplicateCopy; group: DuplicateGroup }) {
	const name = baseName(copy.path);
	const siblings = group.tracks.filter((t) => t !== copy).map((t) => baseName(t.path));
	return <MarkedName name={name} marker={copyMarker(name, siblings)} />;
}

function sideOf(decision: GroupDecision, copy: DuplicateCopy): DiffSide {
	switch (decision.kind) {
		case "keep":
			return decision.path === copy.path ? "keep" : "remove";
		case "keepAll":
			return "keep";
		case "undecided":
			return "open";
	}
}

const SIDE_LABEL: Record<DiffSide, string> = {
	keep: "Kept",
	remove: `Goes to the ${TRASH}`,
	change: "Changed",
	open: "Not decided",
};

/** Row buttons show only while the pointer or focus is on the row, in place of the size. */
const HOVER_ONLY = "hidden group-hover/copy:inline-flex group-focus-within/copy:inline-flex";
const SHOWN_AT_REST = "group-hover/copy:hidden group-focus-within/copy:hidden";

/** One song's copies: which stays and which go, each copy one click from being the keeper. */
function GroupCard({
	group,
	decision,
	root,
	onChoose,
}: {
	group: DuplicateGroup;
	decision: GroupDecision;
	root: string;
	onChoose: (choice: GroupChoice | null) => void;
}) {
	const trash = useFsTrash();
	const player = usePlayer();
	const library = useTracks().data;
	const songs = useMemo(() => new Map((library ?? []).map((t) => [t.id, t])), [library]);
	const first = group.tracks[0];
	const undecided = decision.kind === "undecided";
	return (
		<ProblemList
			title={first?.title || "Untitled"}
			description={
				decision.kind === "undecided" ? (
					<span className="font-medium text-warning" data-hint={UNDECIDED_HINT[decision.why]}>
						Pick one
					</span>
				) : (
					first?.artist
				)
			}
			action={
				<Button
					variant="ghost"
					size="xs"
					className="text-muted-foreground"
					aria-pressed={decision.kind === "keepAll"}
					data-hint={
						decision.kind === "keepAll"
							? "Go back to keeping one copy"
							: `Leave every copy where it is; none goes to the ${TRASH}`
					}
					onClick={() => onChoose(decision.kind === "keepAll" ? null : { kind: "keepAll" })}
				>
					{decision.kind === "keepAll" ? "Undo keep all" : "Keep all"}
				</Button>
			}
		>
			{group.tracks.map((t) => {
				const side = sideOf(decision, t);
				const isKeeper = decision.kind === "keep" && decision.path === t.path;
				return (
					<RowMenu
						key={t.path}
						label={baseName(t.path)}
						render={<li className="group/copy" />}
						items={[
							{
								label: "Keep this copy",
								icon: <Check />,
								disabled: isKeeper,
								onSelect: () => onChoose({ kind: "keep", path: t.path }),
							},
							{
								label: "Play this copy",
								icon: <Play />,
								disabled: !songs.has(t.id),
								onSelect: () => {
									const song = songs.get(t.id);
									if (song) {
										player.play([song], 0);
									}
								},
							},
							"separator",
							...fileMenuEntries(t.path),
							"separator",
							{
								label: `Move to ${TRASH}…`,
								icon: <Trash2 />,
								destructive: true,
								disabled: trash.isPending,
								onSelect: async () => {
									if (await confirmTrash([baseName(t.path)])) {
										trash.mutate([t.path]);
									}
								},
							},
						]}
					>
						<DiffLine
							side={side}
							label={SIDE_LABEL[side]}
							hint={sideHint(decision, side)}
							className={cn(side === "remove" && "[&_.copy-name]:text-muted-foreground")}
							aside={
								<>
									<span
										className={cn(
											"text-muted-foreground text-xs tabular-nums",
											!undecided && SHOWN_AT_REST,
										)}
									>
										{formatBytes(t.size)}
									</span>
									<Button
										variant="ghost"
										size="icon-xs"
										className={HOVER_ONLY}
										aria-label={`Show ${baseName(t.path)} in ${FILE_MANAGER}`}
										data-hint={`Show in ${FILE_MANAGER}`}
										onClick={() => void fsReveal(t.path)}
									>
										<FolderOpen />
									</Button>
									{!isKeeper && (
										<Button
											variant="outline"
											size="xs"
											className={undecided ? undefined : HOVER_ONLY}
											onClick={() => onChoose({ kind: "keep", path: t.path })}
										>
											Keep
										</Button>
									)}
								</>
							}
						>
							<ProblemText
								name={
									<span className="copy-name">
										<CopyName copy={t} group={group} />
									</span>
								}
								where={folderOf(root, t.path)}
								hint={t.path}
								notes={copyNotes(t, side)}
							/>
						</DiffLine>
					</RowMenu>
				);
			})}
		</ProblemList>
	);
}

/** What the bulk action will do, and the button that opens its review, pinned to the top. */
function PlanBar({ plan, onReview }: { plan: TrashPlan; onReview: () => void }) {
	const count = plan.paths.length;
	return (
		<ActionBar
			summary={
				count > 0
					? `${plural(count, "copy", "copies")} to the ${TRASH} · ${formatBytes(plan.bytes)}`
					: "Nothing to remove yet"
			}
			detail={
				plan.undecided > 0 ? (
					<span className="text-warning">{plural(plan.undecided, "song", "songs")} to pick</span>
				) : plan.keptAll > 0 ? (
					`${plural(plan.keptAll, "song", "songs")} kept whole`
				) : (
					"Copies share tags, grid and playlists"
				)
			}
		>
			<Button size="sm" disabled={count === 0} onClick={onReview}>
				Review
			</Button>
		</ActionBar>
	);
}

/** What the move did: how many went, and each copy that stayed and why. */
function TrashResult({ report }: { report: TrashDuplicatesReport }) {
	const { trashed, skipped } = report;
	return (
		<div className="space-y-0.5 text-sm">
			<p className={skipped.length > 0 ? "text-warning" : "text-success"}>
				{plural(trashed.length, "file", "files")} moved to the {TRASH}
				{skipped.length > 0 && ` · ${skipped.length} skipped`}
			</p>
			{skipped.map((s) => (
				<p key={s.path} className="truncate text-muted-foreground text-xs" data-hint={s.path}>
					{baseName(s.path)}: {s.reason}
				</p>
			))}
		</div>
	);
}

/** Every copy about to go, beside the copy of the same song that stays. */
function TrashReview({
	plan,
	root,
	pending,
	onBack,
	onConfirm,
}: {
	plan: TrashPlan;
	root: string;
	pending: boolean;
	onBack: () => void;
	onConfirm: () => void;
}) {
	const count = plan.paths.length;
	return (
		<ReviewSheet
			title={`Move ${plural(count, "file", "files")} to the ${TRASH}`}
			summary={`Frees ${formatBytes(plan.bytes)}. Songs keep their tags, grid and playlists. A file whose audio differs from the kept copy is skipped.`}
			onBack={onBack}
			confirm={
				<ConfirmButton
					size="sm"
					variant="destructive"
					destructive
					disabled={pending || count === 0}
					confirmLabel={`Move ${count} to the ${TRASH}`}
					onConfirm={onConfirm}
				>
					<Trash2 />
					{pending ? "Moving…" : `Move ${count} to ${TRASH}`}
				</ConfirmButton>
			}
		>
			{plan.groups.map(({ group, keep, trash }) => (
				<DiffGroup
					key={group.audioFp}
					title={[keep.title || "Untitled", keep.artist].filter(Boolean).join(", ")}
				>
					{[keep, ...trash].map((t) => {
						const side: DiffSide = t.path === keep.path ? "keep" : "remove";
						const lost = side === "remove" ? cuesLostWith([keep, t], keep) : [];
						return (
							<DiffLine
								key={t.path}
								side={side}
								label={SIDE_LABEL[side]}
								aside={
									side === "remove" ? (
										<span className="text-muted-foreground text-xs tabular-nums">
											{formatBytes(t.size)}
										</span>
									) : undefined
								}
							>
								<div className="truncate text-sm" data-hint={t.path}>
									<CopyName copy={t} group={group} />
								</div>
								<div className="truncate text-muted-foreground text-xs">
									{folderOf(root, t.path)}
								</div>
								{lost.length > 0 && (
									<div className="pt-0.5">
										<NoteChip tone="warning">{cueNames(lost)} cues lost</NoteChip>
									</div>
								)}
							</DiffLine>
						);
					})}
				</DiffGroup>
			))}
		</ReviewSheet>
	);
}

function DuplicateList({ groups }: { groups: readonly DuplicateGroup[] }) {
	const trash = useTrashDuplicates();
	const root = useLibraryRoot().data ?? "";
	const audit = useAudit().data;
	const issueCount = useMemo(() => {
		const counts = new Map<string, number>();
		for (const i of audit ?? []) {
			counts.set(i.path, (counts.get(i.path) ?? 0) + 1);
		}
		return (path: string) => counts.get(path) ?? 0;
	}, [audit]);
	const [choices, setChoices] = useState<ReadonlyMap<GroupKey, GroupChoice>>(new Map());
	const [reviewing, setReviewing] = useState(false);
	const [report, setReport] = useState<TrashDuplicatesReport | null>(null);
	const decisions = useMemo(
		() => decideGroups(groups, choices, issueCount),
		[groups, choices, issueCount],
	);
	const plan = useMemo(() => trashPlan(groups, decisions), [groups, decisions]);

	const choose = (key: GroupKey, choice: GroupChoice | null) => {
		setReport(null);
		setChoices((prev) => {
			const next = new Map(prev);
			if (choice === null) {
				next.delete(key);
			} else {
				next.set(key, choice);
			}
			return next;
		});
	};

	if (reviewing) {
		return (
			<TrashReview
				plan={plan}
				root={root}
				pending={trash.isPending}
				onBack={() => setReviewing(false)}
				onConfirm={() => {
					trash.mutate(
						plan.groups.map((g) => ({ keep: g.keep.path, trash: g.trash.map((t) => t.path) })),
						{
							onSuccess: (done) => {
								setReport(done);
								setReviewing(false);
							},
						},
					);
				}}
			/>
		);
	}
	return (
		<div className="space-y-3">
			<PlanBar plan={plan} onReview={() => setReviewing(true)} />
			{trash.isError && <ErrorLine>{String(trash.error)}</ErrorLine>}
			{report && <TrashResult report={report} />}
			{groups.map((g) => (
				<GroupCard
					key={g.audioFp}
					group={g}
					decision={decisions.get(g.audioFp) ?? { kind: "undecided", why: "unclear" }}
					root={root}
					onChoose={(choice) => choose(g.audioFp, choice)}
				/>
			))}
		</div>
	);
}

function CarryList({ items }: { items: readonly CarryCandidate[] }) {
	const decide = useCarryDecision();
	return (
		<div className="space-y-3">
			{decide.isError && <ErrorLine>{String(decide.error)}</ErrorLine>}
			<ProblemList
				title="Re-encoded"
				description={`${plural(items.length, "song", "songs")}: old tags and playlists left behind`}
			>
				{items.map((c) => (
					<li key={c.oldFp} className={cn(PROBLEM_ROW, "flex-col items-stretch gap-2")}>
						<ProblemText
							name={c.title}
							where={c.artist || baseName(c.path)}
							hint={c.oldPath ? `${c.oldPath} → ${c.path}` : c.path}
							notes={[
								{
									text: `Has ${[
										c.tags > 0 && `${c.tags} ${c.tags === 1 ? "tag" : "tags"}`,
										c.playlists > 0 &&
											`${c.playlists} ${c.playlists === 1 ? "playlist" : "playlists"}`,
										c.edits && "hand-set BPM, key or grid",
									]
										.filter(Boolean)
										.join(", ")}`,
									tone: "warning",
								},
							]}
						/>
						<div className="flex gap-2">
							<Button
								size="sm"
								disabled={decide.isPending}
								onClick={() => decide.mutate({ oldFp: c.oldFp, trackId: c.trackId })}
							>
								Carry over
							</Button>
							<Button
								variant="ghost"
								size="sm"
								disabled={decide.isPending}
								onClick={() => decide.mutate({ oldFp: c.oldFp, trackId: null })}
							>
								Leave
							</Button>
						</div>
					</li>
				))}
			</ProblemList>
		</div>
	);
}

/** The side panel listing each group of songs with the same audio, and re-encoded songs. */
export function DuplicatesPanel() {
	const groups = useDuplicates().data ?? [];
	const carry = useCarryCandidates().data ?? [];
	return (
		<>
			<PanelBarTitle>Duplicates</PanelBarTitle>
			<div className="space-y-6 pb-5">
				{groups.length > 0 ? (
					<DuplicateList groups={groups} />
				) : (
					carry.length === 0 && (
						<ProblemsCleared title="No duplicates">
							Every recording in the library is stored once.
						</ProblemsCleared>
					)
				)}
				{carry.length > 0 && <CarryList items={carry} />}
			</div>
		</>
	);
}
