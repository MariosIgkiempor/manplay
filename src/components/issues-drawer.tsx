import { FolderInput, RefreshCw, Square, SquareCheck, TriangleAlert, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { fileMenuEntries } from "#/components/file-menu.tsx";
import type { FixNotice } from "#/components/library-health.tsx";
import { RowMenu } from "#/components/menu.tsx";
import { ErrorLine, LoadingLine } from "#/components/page.tsx";
import {
	ActionBar,
	DiffGroup,
	DiffLine,
	PROBLEM_ROW,
	ProblemList,
	ProblemsCleared,
	ProblemText,
	ReviewSheet,
} from "#/components/problem-panel.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ConfirmButton } from "#/components/ui/confirm-button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { PanelBarTitle } from "#/context/panel-bar.tsx";
import type { AuditIssue } from "#/lib/api.ts";
import {
	fixablePathsOfKind,
	fixSteps,
	type IssueKind,
	issueChip,
	issueSummary,
	nameAfterFix,
	type PlaceDefaults,
} from "#/lib/audit.ts";
import { baseName, relSegments } from "#/lib/fs-path.ts";
import { useAudit, useAuditFix, useAuditPlaceMany, useLibraryRoot } from "#/lib/queries.ts";
import { cn } from "#/lib/utils.ts";

/** Absolute path of a file with issues. */
type FilePath = string;

/** Issues grouped by file, in path order. */
interface FileIssues {
	path: FilePath;
	issues: AuditIssue[];
	/** At least one issue the app can fix on its own. */
	fixable: boolean;
	/** What is known when the file needs an artist and album typed before it can be filed. */
	place: PlaceDefaults | null;
}

/** Files of one folder, as the lists show them. */
interface FolderFiles {
	/** The folder below the library folder, `A / B`, or "Library folder". */
	label: string;
	files: FileIssues[];
}

function groupByFile(issues: readonly AuditIssue[]): FileIssues[] {
	const map = new Map<FilePath, FileIssues>();
	for (const i of issues) {
		const entry = map.get(i.path) ?? { path: i.path, issues: [], fixable: false, place: null };
		entry.issues.push(i);
		entry.fixable ||= i.fixable;
		entry.place ??= i.place;
		map.set(i.path, entry);
	}
	return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function folderLabel(root: string, path: FilePath): string {
	return relSegments(root, path).slice(0, -1).join(" / ") || "Library folder";
}

function groupByFolder(root: string, files: readonly FileIssues[]): FolderFiles[] {
	const map = new Map<string, FileIssues[]>();
	for (const f of files) {
		const label = folderLabel(root, f.path);
		map.set(label, [...(map.get(label) ?? []), f]);
	}
	return [...map].map(([label, list]) => ({ label, files: list }));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Status bar notice: files break the library conventions. Hidden when there are none. */
export function IssuesIndicator({ onClick }: { onClick: () => void }) {
	const issues = useAudit().data ?? [];
	if (issues.length === 0) {
		return null;
	}
	const files = new Set(issues.map((i) => i.path)).size;
	const full = `${plural(issues.length, "file issue", "file issues")} in ${plural(files, "file", "files")}`;
	return (
		<button
			type="button"
			onClick={onClick}
			data-hint={`${full}. Review and fix them.`}
			aria-label={full}
			className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-warning hover:bg-warning/15"
		>
			<TriangleAlert className="size-3.5" />
			{plural(issues.length, "issue", "issues")}
		</button>
	);
}

/** A set of ticked paths and the ways to change it. */
interface Ticks {
	picked: ReadonlySet<FilePath>;
	toggle: (path: FilePath) => void;
	/** Ticks every one of `paths`, or unticks them all when they already are. */
	toggleAll: (paths: readonly FilePath[]) => void;
	clear: () => void;
}

/** Ticked file paths; ticks for files that are fixed or gone after a recheck drop out. */
function useTicks(live: readonly FileIssues[]): Ticks {
	const [picked, setPicked] = useState<ReadonlySet<FilePath>>(new Set());
	useEffect(() => {
		setPicked((prev) => {
			const present = new Set(live.map((f) => f.path));
			const next = new Set([...prev].filter((p) => present.has(p)));
			return next.size === prev.size ? prev : next;
		});
	}, [live]);
	return {
		picked,
		toggle: (path) =>
			setPicked((prev) => {
				const next = new Set(prev);
				if (!next.delete(path)) {
					next.add(path);
				}
				return next;
			}),
		toggleAll: (paths) =>
			setPicked((prev) => {
				const next = new Set(prev);
				const all = paths.every((p) => next.has(p));
				for (const p of paths) {
					if (all) {
						next.delete(p);
					} else {
						next.add(p);
					}
				}
				return next;
			}),
		clear: () => setPicked(new Set()),
	};
}

/** How many of `paths` are ticked: none, some or all. */
function tickState(
	picked: ReadonlySet<FilePath>,
	paths: readonly FilePath[],
): "none" | "some" | "all" {
	const n = paths.filter((p) => picked.has(p)).length;
	return n === 0 ? "none" : n === paths.length ? "all" : "some";
}

/** A checkbox that can also show "some ticked". */
function TriCheckbox({
	state,
	disabled,
	label,
	onChange,
	id,
}: {
	state: "none" | "some" | "all";
	disabled: boolean;
	label: string;
	onChange: () => void;
	id?: string;
}) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (ref.current) {
			ref.current.indeterminate = state === "some";
		}
	}, [state]);
	return (
		<input
			ref={ref}
			id={id}
			type="checkbox"
			className="size-4 shrink-0 accent-primary"
			checked={state === "all"}
			disabled={disabled}
			onChange={onChange}
			aria-label={label}
		/>
	);
}

const KIND_NAME: Record<IssueKind, string> = {
	notMp3: "Not MP3",
	tagVersion: "Old tags",
	misplaced: "Wrong folder",
};

const KIND_HINT: Record<IssueKind, string> = {
	notMp3: "Tick every file that can be converted to MP3",
	tagVersion: "Tick every file whose tags can be rewritten as ID3v2.3, which CDJs read",
	misplaced: "Tick every file that can be moved into its Artist/Album folder",
};

/** One chip per kind of issue: pressing it ticks every fixable file with that kind. */
function KindPicker({
	issues,
	ticks,
	disabled,
}: {
	issues: readonly AuditIssue[];
	ticks: Ticks;
	disabled: boolean;
}) {
	const kinds = (Object.keys(KIND_NAME) as IssueKind[])
		.map((kind) => ({ kind, paths: fixablePathsOfKind(issues, kind) }))
		.filter((k) => k.paths.length > 0);
	if (kinds.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{kinds.map(({ kind, paths }) => {
				const state = tickState(ticks.picked, paths);
				return (
					<button
						key={kind}
						type="button"
						aria-pressed={state === "all"}
						disabled={disabled}
						data-hint={KIND_HINT[kind]}
						onClick={() => ticks.toggleAll(paths)}
						className={cn(
							"inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 font-medium text-xs transition-colors motion-reduce:transition-none",
							"focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
							state === "all"
								? "border-primary bg-primary text-primary-foreground"
								: state === "some"
									? "border-primary/40 bg-primary/10 text-primary"
									: "border-border text-foreground hover:bg-muted",
						)}
					>
						{KIND_NAME[kind]}
						<span className="tabular-nums opacity-70">{paths.length}</span>
					</button>
				);
			})}
		</div>
	);
}

function FileRow({
	file,
	checked,
	disabled,
	showIssues,
	onToggle,
}: {
	file: FileIssues;
	checked: boolean;
	disabled: boolean;
	/** Off where every row has the same issue and the card's title already says it. */
	showIssues: boolean;
	onToggle: () => void;
}) {
	const name = baseName(file.path);
	return (
		<RowMenu
			label={name}
			render={<li />}
			items={[
				{
					label: checked ? "Untick" : "Tick",
					icon: checked ? <Square /> : <SquareCheck />,
					disabled,
					onSelect: onToggle,
				},
				"separator",
				...fileMenuEntries(file.path),
			]}
		>
			{/* The whole row ticks the file, as its checkbox does. */}
			<label
				className={cn(PROBLEM_ROW, "cursor-pointer py-2 pl-8")}
				data-hint={issueSummary(file.issues)}
			>
				<input
					type="checkbox"
					className="mt-0.5 size-4 shrink-0 accent-primary"
					checked={checked}
					disabled={disabled}
					onChange={onToggle}
					aria-label={`Tick ${name}`}
				/>
				<ProblemText
					name={name}
					hint={file.path}
					notes={
						showIssues
							? file.issues.map((i) => ({
									text: issueChip(i),
									tone: i.fixable ? "warning" : "muted",
								}))
							: []
					}
				/>
			</label>
		</RowMenu>
	);
}

/** A folder's heading row in a list: its name, and a box ticking every file listed under it. */
function FolderRow({
	folder,
	ticks,
	disabled,
}: {
	folder: FolderFiles;
	ticks: Ticks;
	disabled: boolean;
}) {
	const paths = folder.files.map((f) => f.path);
	const id = useId();
	return (
		<li className="bg-muted/40">
			<label
				htmlFor={id}
				className={cn(PROBLEM_ROW, "cursor-pointer items-center py-1.5 hover:bg-muted/60")}
			>
				<TriCheckbox
					id={id}
					state={tickState(ticks.picked, paths)}
					disabled={disabled}
					label={`Tick every file in ${folder.label}`}
					onChange={() => ticks.toggleAll(paths)}
				/>
				<span className="min-w-0 flex-1 truncate font-medium text-muted-foreground text-xs">
					{folder.label}
				</span>
				<span className="text-muted-foreground text-xs tabular-nums">{folder.files.length}</span>
			</label>
		</li>
	);
}

/** Files under folder headings, each heading ticking its folder. */
function FolderedRows({
	folders,
	ticks,
	disabled,
	showIssues = true,
}: {
	folders: readonly FolderFiles[];
	ticks: Ticks;
	disabled: boolean;
	showIssues?: boolean;
}) {
	return folders.map((folder) => [
		<FolderRow key={`folder:${folder.label}`} folder={folder} ticks={ticks} disabled={disabled} />,
		...folder.files.map((f) => (
			<FileRow
				key={f.path}
				file={f}
				checked={ticks.picked.has(f.path)}
				disabled={disabled}
				showIssues={showIssues}
				onToggle={() => ticks.toggle(f.path)}
			/>
		)),
	]);
}

/** The card of files the app can fix: tick them by kind, folder or one by one. */
function FixableList({
	files,
	root,
	ticks,
	disabled,
}: {
	files: readonly FileIssues[];
	root: string;
	ticks: Ticks;
	disabled: boolean;
}) {
	const paths = files.map((f) => f.path);
	return (
		<ProblemList
			title="Fixable"
			description={files.length}
			action={
				<Button
					variant="ghost"
					size="xs"
					className="text-muted-foreground"
					disabled={disabled}
					onClick={() => ticks.toggleAll(paths)}
				>
					{tickState(ticks.picked, paths) === "all" ? "Untick all" : "Tick all"}
				</Button>
			}
		>
			<FolderedRows folders={groupByFolder(root, files)} ticks={ticks} disabled={disabled} />
		</ProblemList>
	);
}

/**
 * The card of files that cannot be filed without an artist and album: tick several, type the
 * artist and album once, and they all go into that folder.
 */
function PlaceList({ files, root }: { files: readonly FileIssues[]; root: string }) {
	const place = useAuditPlaceMany();
	const ticks = useTicks(files);
	const ticked = files.filter((f) => ticks.picked.has(f.path));
	// What the ticked files agree on is filled in; the user types the rest.
	const known = (pick: (p: PlaceDefaults) => string | null) => {
		const values = new Set(ticked.map((f) => (f.place ? pick(f.place) : null)));
		const [only] = values;
		return values.size === 1 && only ? only : "";
	};
	const [artist, setArtist] = useState("");
	const [album, setAlbum] = useState("");
	const [notice, setNotice] = useState<FixNotice | null>(null);
	const tickedKey = ticked.map((f) => f.path).join("\n");
	// biome-ignore lint/correctness/useExhaustiveDependencies: refill only when the ticked files change
	useEffect(() => {
		setArtist(known((p) => p.artist));
		setAlbum(known((p) => p.album));
	}, [tickedKey]);
	const ready = ticked.length > 0 && artist.trim() !== "" && album.trim() !== "";
	return (
		<ProblemList title="Needs an artist and album" description={files.length}>
			<FolderedRows
				folders={groupByFolder(root, files)}
				ticks={ticks}
				disabled={place.isPending}
				showIssues={false}
			/>
			<li>
				<form
					className="space-y-2 bg-muted/30 px-3 py-3"
					onSubmit={(ev) => {
						ev.preventDefault();
						setNotice(null);
						place.mutate(
							{ paths: ticked.map((f) => f.path), artist: artist.trim(), album: album.trim() },
							{
								onSuccess: (report) => {
									setNotice({ kind: "report", report, verb: "Filed" });
									ticks.clear();
								},
								onError: (e) => setNotice({ kind: "error", message: String(e) }),
							},
						);
					}}
				>
					<div className="grid grid-cols-2 gap-2">
						<Input
							value={artist}
							placeholder="Artist"
							aria-label="Artist"
							disabled={ticked.length === 0}
							onChange={(ev) => setArtist(ev.target.value)}
						/>
						<Input
							value={album}
							placeholder="Album"
							aria-label="Album"
							disabled={ticked.length === 0}
							onChange={(ev) => setAlbum(ev.target.value)}
						/>
					</div>
					<Button type="submit" size="sm" className="w-full" disabled={!ready || place.isPending}>
						<FolderInput />
						{place.isPending
							? "Moving…"
							: ticked.length === 0
								? "Move to folder"
								: `Move ${ticked.length} to ${artist.trim() || "Artist"} / ${album.trim() || "Album"}`}
					</Button>
					{notice && <ResultLine notice={notice} />}
				</form>
			</li>
		</ProblemList>
	);
}

/** The card of files only the user can sort out, in Files. */
function ManualList({ files, root }: { files: readonly FileIssues[]; root: string }) {
	return (
		<ProblemList title="Fix by hand" description={files.length}>
			{files.map((f) => (
				<RowMenu
					key={f.path}
					label={baseName(f.path)}
					render={<li />}
					items={fileMenuEntries(f.path)}
				>
					<div className={cn(PROBLEM_ROW, "opacity-80")}>
						<ProblemText
							name={baseName(f.path)}
							where={folderLabel(root, f.path)}
							hint={f.path}
							notes={f.issues.map((i) => ({ text: issueChip(i), tone: "muted" }))}
						/>
					</div>
				</RowMenu>
			))}
		</ProblemList>
	);
}

/** Every ticked file, its name before and after, and the fixes that will run on it. */
function FixReview({
	files,
	root,
	pending,
	onBack,
	onConfirm,
}: {
	files: readonly FileIssues[];
	root: string;
	pending: boolean;
	onBack: () => void;
	onConfirm: () => void;
}) {
	const count = files.length;
	return (
		<ReviewSheet
			title={`Fix ${plural(count, "file", "files")}`}
			summary="A file that fails is left as it was; the rest carry on."
			onBack={onBack}
			confirm={
				<ConfirmButton
					size="sm"
					disabled={pending || count === 0}
					confirmLabel={`Fix ${count} now`}
					onConfirm={onConfirm}
				>
					<Wrench />
					{pending ? "Fixing…" : `Fix ${count}`}
				</ConfirmButton>
			}
		>
			{groupByFolder(root, files).map((folder) => (
				<DiffGroup key={folder.label} title={folder.label}>
					{folder.files.map((f) => {
						const before = baseName(f.path);
						const after = nameAfterFix(before, f.issues);
						return (
							<DiffLine key={f.path} side="change" label="Fixed">
								<div className="truncate text-sm" data-hint={f.path}>
									{after === before ? (
										before
									) : (
										<>
											<span className="text-muted-foreground line-through decoration-1">
												{before}
											</span>
											{" → "}
											{after}
										</>
									)}
								</div>
								{fixSteps(f.issues).map((step) => (
									<div key={step} className="truncate text-muted-foreground text-xs">
										{step}
									</div>
								))}
							</DiffLine>
						);
					})}
				</DiffGroup>
			))}
		</ReviewSheet>
	);
}

/** Every ticked file's fixes, then the fix itself; back to the lists when it is done. */
function useFixFlow(ticked: readonly FileIssues[], clearTicks: () => void) {
	const fixer = useAuditFix();
	const [reviewing, setReviewing] = useState(false);
	const [notice, setNotice] = useState<FixNotice | null>(null);
	const run = () => {
		setNotice(null);
		fixer.mutate(
			ticked.map((f) => f.path),
			{
				onSuccess: (report) => {
					setNotice({ kind: "report", report });
					clearTicks();
				},
				onError: (e) => setNotice({ kind: "error", message: String(e) }),
				onSettled: () => setReviewing(false),
			},
		);
	};
	return { fixing: fixer.isPending, reviewing, setReviewing, notice, run };
}

function IssueLists({
	files,
	issues,
	root,
	ticks,
	fixing,
	checking,
	notice,
	onReview,
	onRecheck,
}: {
	files: readonly FileIssues[];
	issues: readonly AuditIssue[];
	root: string;
	ticks: Ticks;
	fixing: boolean;
	checking: boolean;
	notice: FixNotice | null;
	onReview: () => void;
	onRecheck: () => void;
}) {
	const fixable = files.filter((f) => f.fixable);
	const needsPlace = files.filter((f) => !f.fixable && f.place !== null);
	const manual = files.filter((f) => !f.fixable && f.place === null);
	const tickedCount = fixable.filter((f) => ticks.picked.has(f.path)).length;
	const noFfmpeg = issues.some((i) => i.kind === "notMp3" && !i.fixable);
	return (
		<div className="space-y-3 pb-5">
			<ActionBar
				summary={
					tickedCount === 0 ? "Tick files to fix" : `${plural(tickedCount, "file", "files")} ticked`
				}
				detail={
					fixable.length > 0 ? (
						<KindPicker issues={issues} ticks={ticks} disabled={fixing} />
					) : undefined
				}
			>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Check again"
					data-hint="Check the library again"
					disabled={checking || fixing}
					onClick={onRecheck}
				>
					<RefreshCw className={checking ? "animate-spin motion-reduce:animate-none" : undefined} />
				</Button>
				<Button size="sm" disabled={tickedCount === 0 || fixing} onClick={onReview}>
					Review
				</Button>
			</ActionBar>
			{noFfmpeg && (
				<ErrorLine>
					ffmpeg is missing, so files can't be converted to MP3. Reinstall manplay.
				</ErrorLine>
			)}
			{notice && <ResultLine notice={notice} />}
			{fixable.length > 0 && (
				<FixableList files={fixable} root={root} ticks={ticks} disabled={fixing} />
			)}
			{needsPlace.length > 0 && <PlaceList files={needsPlace} root={root} />}
			{manual.length > 0 && <ManualList files={manual} root={root} />}
		</div>
	);
}

function IssuesBody() {
	const audit = useAudit();
	const root = useLibraryRoot().data ?? "";
	const files = useMemo(() => groupByFile(audit.data ?? []), [audit.data]);
	const fixable = useMemo(() => files.filter((f) => f.fixable), [files]);
	const ticks = useTicks(fixable);
	const ticked = fixable.filter((f) => ticks.picked.has(f.path));
	const flow = useFixFlow(ticked, ticks.clear);

	if (audit.isError) {
		return <ErrorLine>{String(audit.error)}</ErrorLine>;
	}
	if (files.length === 0) {
		return audit.isPending ? (
			<LoadingLine>Checking the library…</LoadingLine>
		) : (
			<ProblemsCleared title="No file issues">
				Every file follows the library's conventions.
			</ProblemsCleared>
		);
	}
	return flow.reviewing ? (
		<FixReview
			files={ticked}
			root={root}
			pending={flow.fixing}
			onBack={() => flow.setReviewing(false)}
			onConfirm={flow.run}
		/>
	) : (
		<IssueLists
			files={files}
			issues={audit.data ?? []}
			root={root}
			ticks={ticks}
			fixing={flow.fixing}
			checking={audit.isFetching}
			notice={flow.notice}
			onReview={() => flow.setReviewing(true)}
			onRecheck={() => void audit.refetch()}
		/>
	);
}

function ResultLine({ notice }: { notice: FixNotice }): ReactNode {
	if (notice.kind === "error") {
		return <ErrorLine>{notice.message}</ErrorLine>;
	}
	const failed = notice.report.failed;
	return (
		<div
			className={cn("space-y-0.5 text-sm", failed.length > 0 ? "text-destructive" : "text-success")}
		>
			<p>
				{notice.verb ?? "Fixed"} {plural(notice.report.fixed, "file", "files")}
				{failed.length > 0 && `, ${failed.length} failed and left as they were:`}
			</p>
			{failed.slice(0, 3).map((f) => (
				<p key={f.path} className="truncate text-xs" data-hint={f.error}>
					{baseName(f.path)}: {f.error}
				</p>
			))}
			{failed.length > 3 && <p className="text-xs">and {failed.length - 3} more</p>}
		</div>
	);
}

/** The side panel listing every file issue, with ways to tick many files and fix them at once. */
export function IssuesPanel() {
	return (
		<>
			<PanelBarTitle>File issues</PanelBarTitle>
			<IssuesBody />
		</>
	);
}
