import { CheckCircle2, FolderOpen, ListPlus, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useId } from "react";
import { GroupCard } from "#/components/import-group-card.tsx";
import { ProgressPill } from "#/components/progress-pill.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { Button } from "#/components/ui/button.tsx";
import type { ImportProgress, ImportReport, ImportScan } from "#/lib/api.ts";
import { countNew, editOf, groupKey, placementOf, useLibraryIndex } from "#/lib/import-state.ts";
import { useTracks } from "#/lib/queries.ts";
import { useImport, useImportProgress } from "#/lib/use-import.ts";

const PHASE_LABEL = {
	listing: "Looking through files",
	checking: "Checking files",
	tags: "Reading tags",
} as const;

function ScanPill({ progress }: { progress: ImportProgress | null }) {
	if (progress === null) {
		return null;
	}
	const indeterminate = progress.phase === "listing";
	return (
		<ProgressPill
			label={PHASE_LABEL[progress.phase]}
			done={progress.done}
			total={indeterminate ? 0 : progress.total}
		/>
	);
}

interface ToolbarProps {
	folder: string | null;
	scanning: boolean;
	choosing: boolean;
	adding: boolean;
	addingAll: boolean;
	canAdd: boolean;
	total: number;
	onChoose: () => void;
	onRescan: (fresh: boolean) => void;
	onAddAll: () => void;
}

function Toolbar(p: ToolbarProps) {
	return (
		<div className="sticky top-0 z-10 flex items-center gap-2 rounded-xl border bg-card/95 p-2 pl-3 shadow-xs backdrop-blur">
			<FolderOpen className="size-4 shrink-0 text-muted-foreground" />
			<p className="min-w-0 flex-1 truncate font-mono text-xs" title={p.folder ?? undefined}>
				{p.folder ?? "No folder chosen"}
			</p>
			<Button
				variant={p.folder === null ? "default" : "outline"}
				size="sm"
				onClick={p.onChoose}
				disabled={p.choosing}
			>
				{p.folder === null ? "Choose folder…" : "Change…"}
			</Button>
			{p.folder !== null && (
				<>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Full rescan"
						title="Full rescan: read every file again, ignoring what was learned last time"
						onClick={() => p.onRescan(true)}
						disabled={p.scanning}
					>
						<RotateCcw />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Rescan"
						title="Rescan (only files that changed)"
						onClick={() => p.onRescan(false)}
						disabled={p.scanning}
					>
						<RefreshCw className={p.scanning ? "animate-spin" : undefined} />
					</Button>
					<Button onClick={p.onAddAll} disabled={p.adding || p.total === 0 || !p.canAdd}>
						{p.addingAll ? <Loader2 className="animate-spin" /> : <ListPlus />}
						Add all ({p.total})
					</Button>
				</>
			)}
		</div>
	);
}

function Summary({ scan, report }: { scan: ImportScan; report: ImportReport | null }) {
	return (
		<div className="space-y-1 px-1 text-sm">
			{report && (
				<p className="font-medium text-primary">
					Added {report.imported} track{report.imported === 1 ? "" : "s"}
					{report.images > 0 && ` and ${report.images} image(s)`}.
				</p>
			)}
			{report?.failed.map((f) => (
				<p key={`${f.file}${f.error}`} className="break-all text-destructive text-xs">
					{f.file}: {f.error}
				</p>
			))}
			{scan.errors > 0 && (
				<p className="text-muted-foreground text-xs">{scan.errors} file(s) could not be read.</p>
			)}
		</div>
	);
}

function Placeholder({ scanning, hasScan }: { scanning: boolean; hasScan: boolean }) {
	if (scanning && !hasScan) {
		return (
			<div className="space-y-3">
				{[0, 1, 2].map((i) => (
					<div key={i} className="h-40 animate-pulse rounded-xl border bg-card/60" />
				))}
			</div>
		);
	}
	if (hasScan) {
		return (
			<div className="grid place-items-center gap-2 rounded-xl border border-dashed py-16 text-muted-foreground">
				<CheckCircle2 className="size-8" />
				<p className="text-sm">All caught up. Nothing new to import.</p>
			</div>
		);
	}
	return (
		<div className="grid place-items-center gap-2 rounded-xl border border-dashed py-16 text-muted-foreground">
			<FolderOpen className="size-8" />
			<p className="text-sm">Choose a folder to look for new music.</p>
		</div>
	);
}

export function ImportView() {
	const artistList = useId();
	const s = useImport();
	const tracks = useTracks();
	const { artists, albumsByArtist, existing } = useLibraryIndex(tracks.data);
	const scanning = s.find.isPending;
	const progress = useImportProgress(scanning);
	const groups = s.scan?.groups ?? [];
	const total = countNew(s.scan);
	const addingKey = s.add.isPending ? s.add.variables : undefined;
	const errors = [s.choose, s.find, s.add].flatMap((m) => (m.isError ? [String(m.error)] : []));

	return (
		<main className="max-w-4xl space-y-4 p-6">
			<header>
				<h1 className="font-bold text-2xl">Import</h1>
				<p className="text-muted-foreground text-sm">
					New music in this folder, newest first. Zips are searched too. Nothing is moved or
					deleted.
				</p>
			</header>

			{!s.hasRoot && (
				<p className="text-destructive text-sm">Choose your library folder first (Library page).</p>
			)}

			<Toolbar
				folder={s.folder}
				scanning={scanning}
				choosing={s.choose.isPending}
				adding={s.add.isPending}
				addingAll={addingKey === null}
				canAdd={s.canAdd}
				total={total}
				onChoose={() => s.choose.mutate()}
				onRescan={s.rescan}
				onAddAll={() => s.add.mutate(null)}
			/>
			{errors.map((e) => (
				<p key={e} className="text-destructive text-sm">
					{e}
				</p>
			))}
			{s.preview.error && <p className="text-destructive text-sm">{s.preview.error}</p>}

			{s.scan && <Summary scan={s.scan} report={s.report} />}
			{s.scan && s.fromCache && scanning && (
				<p className="px-1 text-muted-foreground text-xs">
					Showing the last scan while checking for changes…
				</p>
			)}

			<datalist id={artistList}>
				{artists.map((a) => (
					<option key={a} value={a} />
				))}
			</datalist>
			{groups.length === 0 && <Placeholder scanning={scanning} hasScan={s.scan !== null} />}
			<div className="space-y-3">
				{groups.map((g) => {
					const key = groupKey(g);
					const edit = editOf(s.edits, g);
					return (
						<GroupCard
							key={key}
							group={g}
							edit={edit}
							onEdit={(next) => s.edit(key, next)}
							unchecked={s.unchecked}
							onToggle={s.toggle}
							onAdd={() => s.add.mutate(key)}
							adding={addingKey === key}
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

			<StatusBar leading={<ScanPill progress={progress} />}>
				<Stat label="Groups" value={groups.length} />
				<Stat label="New tracks" value={total} />
				<Stat label="In library" value={s.scan?.alreadyInLibrary ?? 0} />
			</StatusBar>
		</main>
	);
}
