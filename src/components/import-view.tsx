import {
	CheckCircle2,
	FolderOpen,
	ListPlus,
	Loader2,
	RefreshCw,
	RotateCcw,
	Trash2,
	X,
} from "lucide-react";
import { useId } from "react";
import { BrowserHeader, ReleaseRows } from "#/components/import-browser.tsx";
import { ProgressPill } from "#/components/progress-pill.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	confirmTrash,
	type ImportProgress,
	type ImportReport,
	type ImportScan,
} from "#/lib/api.ts";
import {
	countNew,
	editOf,
	groupKey,
	placementOf,
	trashTargets,
	useLibraryIndex,
} from "#/lib/import-state.ts";
import { useTracks } from "#/lib/queries.ts";
import { type useImport, useImportProgress } from "#/lib/use-import.ts";
import { cn } from "#/lib/utils.ts";

const PHASE_LABEL = {
	listing: "Looking through files",
	library: "Fingerprinting your library",
	checking: "Comparing with your library",
	tags: "Reading tags",
} as const;

type Phase = keyof typeof PHASE_LABEL;

const phaseLabel = (p: ImportProgress) => PHASE_LABEL[p.phase as Phase] ?? "Scanning";

function ScanPill({ progress }: { progress: ImportProgress | null }) {
	if (progress === null) {
		return null;
	}
	return (
		<ProgressPill
			label={phaseLabel(progress)}
			done={progress.done}
			total={progress.phase === "listing" ? 0 : progress.total}
		/>
	);
}

/** A thin bar along the bottom of the toolbar while a scan runs; sweeps when the total is unknown. */
function ScanBar({ progress, scanning }: { progress: ImportProgress | null; scanning: boolean }) {
	if (!scanning) {
		return null;
	}
	const share = progress && progress.total > 0 ? Math.min(1, progress.done / progress.total) : null;
	return (
		<div
			aria-hidden="true"
			className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-primary/10"
		>
			{share === null ? (
				<div className="h-full w-1/3 animate-[import-sweep_1.2s_ease-in-out_infinite] bg-primary motion-reduce:animate-none" />
			) : (
				<div
					className="h-full bg-primary transition-[width] duration-300"
					style={{ width: `${share * 100}%` }}
				/>
			)}
		</div>
	);
}

interface ToolbarProps {
	s: ReturnType<typeof useImport>;
	total: number;
	groups: number;
	progress: ImportProgress | null;
	onTrash: () => void;
}

function ToolbarText({ s, total, groups, progress }: ToolbarProps) {
	const picked = s.selected.size;
	if (picked > 0) {
		return (
			<span className="flex items-center gap-2">
				<span className="font-medium tabular-nums">{picked.toLocaleString()} picked</span>
				<button
					type="button"
					onClick={s.clearSelection}
					className="flex items-center gap-1 rounded px-1 text-muted-foreground text-xs hover:bg-muted hover:text-foreground [&_svg]:size-3"
				>
					<X /> Clear
				</button>
			</span>
		);
	}
	if (s.find.isPending && progress) {
		return (
			<span className="text-muted-foreground tabular-nums">
				{phaseLabel(progress)}
				{progress.total > 0 &&
					` ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`}
				…
			</span>
		);
	}
	if (total === 0) {
		return <span className="text-muted-foreground">Nothing new</span>;
	}
	return (
		<span className="text-muted-foreground">
			<span className="font-medium text-foreground tabular-nums">{total.toLocaleString()}</span> new{" "}
			{total === 1 ? "track" : "tracks"} in {groups.toLocaleString()}{" "}
			{groups === 1 ? "release" : "releases"}
		</span>
	);
}

function Toolbar(p: ToolbarProps) {
	const { s } = p;
	const scanning = s.find.isPending;
	const picked = s.selected.size;
	const ready = s.importable.size;
	return (
		<div className="relative flex h-12 items-center gap-1.5 border-b bg-card pr-2 pl-4">
			<p className="min-w-0 flex-1 truncate text-sm">
				<ToolbarText {...p} />
			</p>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Full rescan"
				title="Full rescan: read every file again, ignoring what was learned last time"
				onClick={() => s.rescan(true)}
				disabled={s.folder === null || scanning}
			>
				<RotateCcw />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Rescan"
				title="Rescan (only files that changed)"
				onClick={() => s.rescan(false)}
				disabled={s.folder === null || scanning}
			>
				<RefreshCw className={scanning ? "animate-spin" : undefined} />
			</Button>
			{picked > 0 ? (
				<Button
					variant="ghost"
					size="sm"
					className="text-destructive hover:bg-destructive/10 hover:text-destructive"
					onClick={p.onTrash}
					disabled={s.trash.isPending}
				>
					<Trash2 /> Move to Trash
				</Button>
			) : (
				p.total > 0 && (
					<Button variant="ghost" size="sm" onClick={s.selectAll}>
						Pick all
					</Button>
				)
			)}
			<Button
				size="sm"
				onClick={() => s.add.mutate(s.importable)}
				disabled={s.add.isPending || ready === 0 || !s.canAdd}
			>
				{s.add.isPending ? <Loader2 className="animate-spin" /> : <ListPlus />}
				{s.add.isPending ? "Importing…" : `Import${ready > 0 ? ` ${ready.toLocaleString()}` : ""}`}
			</Button>
			<ScanBar progress={p.progress} scanning={scanning} />
		</div>
	);
}

function Summary({ scan, report }: { scan: ImportScan; report: ImportReport | null }) {
	if (!report && scan.errors === 0) {
		return null;
	}
	return (
		<div className="space-y-1 border-b px-4 py-2 text-sm">
			{report && (
				<p className="font-medium text-primary">
					Imported {report.imported} track{report.imported === 1 ? "" : "s"}
					{report.images > 0 && ` and ${report.images} image${report.images === 1 ? "" : "s"}`}.
				</p>
			)}
			{report?.failed.map((f) => (
				<p key={`${f.file}${f.error}`} className="break-all text-destructive text-xs">
					{f.file}: {f.error}
				</p>
			))}
			{scan.errors > 0 && (
				<p className="text-muted-foreground text-xs">
					{scan.errors} {scan.errors === 1 ? "file" : "files"} could not be read.
				</p>
			)}
		</div>
	);
}

/** Rows shaped like the list while the first scan runs, so the page does not jump when it lands. */
function Skeleton() {
	const widths = ["w-2/5", "w-1/3", "w-1/2", "w-2/5", "w-1/4", "w-1/3"];
	return (
		<div aria-hidden="true" className="space-y-1 p-2">
			{widths.map((w, i) => (
				<div key={w + String(i)} className="flex h-11 items-center gap-3 px-2">
					<div className="size-4 rounded bg-muted" />
					<div className="size-8 rounded bg-muted" />
					<div className="flex-1 space-y-1.5">
						<div
							className={cn("h-3 animate-pulse rounded bg-muted motion-reduce:animate-none", w)}
						/>
						<div className="h-2.5 w-24 animate-pulse rounded bg-muted/60 motion-reduce:animate-none" />
					</div>
				</div>
			))}
		</div>
	);
}

/** What the list shows with nothing in it: still looking, all caught up, or no folder yet. */
function EmptyList({ s }: { s: ReturnType<typeof useImport> }) {
	if (s.folder === null) {
		return (
			<Message icon={<FolderOpen />} title="Choose your Downloads folder">
				manplay looks there for new music, zips included.
				<Button className="mt-3" onClick={() => s.choose.mutate()} disabled={s.choose.isPending}>
					<FolderOpen /> Choose folder…
				</Button>
			</Message>
		);
	}
	if (s.scan === null) {
		return <Skeleton />;
	}
	return (
		<Message icon={<CheckCircle2 />} title="All caught up">
			{s.find.isPending
				? "Checking for anything new…"
				: "Everything in Downloads is already in your library."}
		</Message>
	);
}

function Message({
	icon,
	title,
	children,
}: {
	icon: React.ReactNode;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col items-center px-6 py-14 text-center">
			<div className="mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
				{icon}
			</div>
			<p className="font-medium text-sm">{title}</p>
			<div className="mt-1 flex max-w-sm flex-col items-center text-muted-foreground text-sm">
				{children}
			</div>
		</div>
	);
}

export function ImportView({ s }: { s: ReturnType<typeof useImport> }) {
	const artistList = useId();
	const tracks = useTracks();
	const { artists, albumsByArtist, existing } = useLibraryIndex(tracks.data);
	const scanning = s.find.isPending;
	const progress = useImportProgress(scanning);
	const groups = s.scan?.groups ?? [];
	const total = countNew(s.scan);
	const errors = [s.choose, s.find, s.add, s.trash].flatMap((m) =>
		m.isError ? [String(m.error)] : [],
	);

	const trashKeys = async (keys: ReadonlySet<string>) => {
		// Tracks inside a zip go only with the whole zip, so a partly picked zip stays.
		const { paths } = trashTargets(s.scan, keys, s.folder);
		if (paths.length === 0) {
			return;
		}
		const names = paths.map((p) => p.split(/[\\/]/).pop() ?? p);
		if (await confirmTrash(names)) {
			s.trash.mutate(keys);
		}
	};

	return (
		<div className="space-y-3">
			{!s.hasRoot && (
				<p className="text-destructive text-sm">Choose your library folder first (Library page).</p>
			)}
			{errors.map((e) => (
				<p key={e} className="text-destructive text-sm">
					{e}
				</p>
			))}
			{s.preview.error && <p className="text-destructive text-sm">{s.preview.error}</p>}

			{/* Clips to its rounded corners; the toolbar and column names stick together at the top. */}
			<div className="overflow-clip rounded-xl border bg-card">
				<div className="sticky top-0 z-10 bg-card">
					<Toolbar
						s={s}
						total={total}
						groups={groups.length}
						progress={progress}
						onTrash={() => void trashKeys(s.selected)}
					/>
					{groups.length > 0 && <BrowserHeader />}
				</div>
				{s.scan && <Summary scan={s.scan} report={s.report} />}
				<datalist id={artistList}>
					{artists.map((a) => (
						<option key={a} value={a} />
					))}
				</datalist>
				{groups.length === 0 ? (
					<EmptyList s={s} />
				) : (
					<div
						role="listbox"
						aria-multiselectable
						aria-label="New music"
						className={cn("p-1", s.trash.isPending && "pointer-events-none opacity-60")}
					>
						{groups.map((g) => {
							const key = groupKey(g);
							const edit = editOf(s.edits, g);
							return (
								<ReleaseRows
									key={key}
									group={g}
									edit={edit}
									onEdit={(next) => s.edit(key, next)}
									selected={s.selected}
									onClick={s.click}
									onToggle={s.toggle}
									onSetMany={s.setMany}
									onImport={(keys) => s.add.mutate(new Set(keys))}
									onTrash={(keys) => void trashKeys(new Set(keys))}
									busy={s.add.isPending || !s.canAdd}
									artistList={artistList}
									albums={[...(albumsByArtist.get(edit.artist.trim()) ?? [])].sort((x, y) =>
										x.localeCompare(y),
									)}
									placement={placementOf(edit, artists, existing)}
									playback={{
										activeKey: s.preview.activeKey,
										isPlaying: s.preview.isPlaying,
										loading: s.preview.loading,
										onToggle: (t) => void s.preview.toggle(key, t),
									}}
								/>
							);
						})}
					</div>
				)}
			</div>

			<StatusBar leading={<ScanPill progress={progress} />}>
				<Stat label="Releases" value={groups.length} />
				<Stat label="New tracks" value={total} />
				{s.selected.size > 0 && <Stat label="Picked" value={s.selected.size} />}
				<Stat label="In library" value={s.scan?.alreadyInLibrary ?? 0} />
			</StatusBar>
		</div>
	);
}
