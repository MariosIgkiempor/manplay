import { AudioWaveform, FileAudio, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { Drawer } from "#/components/drawer.tsx";
import { ProgressPill } from "#/components/progress-pill.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { closeAnalysisDrawer, useAnalysisDrawerOpen } from "#/lib/analysis-drawer.ts";
import {
	type AnalysisReport,
	type AnalysisSettings,
	cancelAnalysis,
	type FileFailure,
	type TagWriteReport,
	type Track,
} from "#/lib/api.ts";
import {
	useAnalysisFailures,
	useAnalysisSettings,
	useAnalyze,
	useLibraryRoot,
	useSaveAnalysisToFiles,
	useSetAnalysisSettings,
	useTracks,
} from "#/lib/queries.ts";
import { progressLabel, useAnalysisProgress } from "#/lib/use-analysis-progress.ts";
import { cn } from "#/lib/utils.ts";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface Counts {
	total: number;
	analyzed: number;
	pending: number;
	withBpm: number;
	withKey: number;
}

function count(tracks: readonly Track[]): Counts {
	const analyzed = tracks.filter((t) => t.analyzed);
	return {
		total: tracks.length,
		analyzed: analyzed.length,
		pending: tracks.length - analyzed.length,
		withBpm: analyzed.filter((t) => t.bpm !== null).length,
		withKey: analyzed.filter((t) => t.key !== null).length,
	};
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" }) {
	return (
		<div className="rounded-lg border bg-card/40 px-3 py-2">
			<div
				className={cn("font-semibold text-lg tabular-nums", tone === "warn" && "text-destructive")}
			>
				{value}
			</div>
			<div className="text-muted-foreground text-xs">{label}</div>
		</div>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="space-y-3">
			<h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{title}</h3>
			{children}
		</section>
	);
}

/** Where a file sits under the library folder, for compact lists. */
function relative(path: string, root: string): string {
	return root && path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]/, "") : path;
}

function tagLine(r: TagWriteReport): string {
	const parts = [`Saved to ${plural(r.written, "file", "files")}`];
	if (r.unchanged > 0) {
		parts.push(`${r.unchanged} already up to date`);
	}
	if (r.failed.length > 0) {
		parts.push(`${r.failed.length} failed`);
	}
	return parts.join(" · ");
}

type Outcome =
	| { kind: "analysis"; report: AnalysisReport }
	| { kind: "tags"; report: TagWriteReport }
	| { kind: "error"; message: string };

function OutcomeLine({ outcome, root }: { outcome: Outcome; root: string }) {
	if (outcome.kind === "error") {
		return <p className="text-destructive text-sm">{outcome.message}</p>;
	}
	const lines: string[] = [];
	let failed: FileFailure[] = [];
	if (outcome.kind === "analysis") {
		const r = outcome.report;
		lines.push(
			[
				`Analyzed ${plural(r.analyzed, "song", "songs")}`,
				r.failed > 0 && `${r.failed} failed`,
				r.cancelled > 0 && `${r.cancelled} skipped (stopped)`,
			]
				.filter(Boolean)
				.join(" · "),
		);
		if (r.tags) {
			lines.push(tagLine(r.tags));
			failed = r.tags.failed;
		}
	} else {
		lines.push(tagLine(outcome.report));
		failed = outcome.report.failed;
	}
	return (
		<div className="space-y-0.5 text-sm">
			{lines.map((l) => (
				<p key={l} className="text-success">
					{l}
				</p>
			))}
			{failed.slice(0, 3).map((f) => (
				<p key={f.path} className="truncate text-destructive text-xs" title={f.error}>
					{relative(f.path, root)}: {f.error}
				</p>
			))}
			{failed.length > 3 && (
				<p className="text-destructive text-xs">and {failed.length - 3} more</p>
			)}
		</div>
	);
}

function RunControls({
	counts,
	allIds,
	onOutcome,
}: {
	counts: Counts;
	/** Every track id, for "Re-analyze all". */
	allIds: number[];
	onOutcome: (o: Outcome) => void;
}) {
	const analyze = useAnalyze();
	const { running, progress } = useAnalysisProgress();
	const [stopping, setStopping] = useState(false);
	const [confirmAll, setConfirmAll] = useState(false);

	const run = (ids?: number[]) =>
		analyze.mutate(ids, {
			onSuccess: (report) => onOutcome({ kind: "analysis", report }),
			onError: (e) => onOutcome({ kind: "error", message: String(e) }),
			onSettled: () => setStopping(false),
		});

	if (running) {
		return (
			<div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs">
				<ProgressPill
					label={progressLabel(progress, stopping)}
					done={progress?.done ?? 0}
					total={progress?.total ?? 0}
				/>
				{progress?.phase !== "saving" && (
					<Button
						size="sm"
						variant="outline"
						disabled={stopping}
						onClick={() => {
							setStopping(true);
							void cancelAnalysis();
						}}
					>
						<Square />
						Stop
					</Button>
				)}
			</div>
		);
	}
	return (
		<div className="flex flex-wrap gap-2">
			<Button disabled={counts.pending === 0} onClick={() => run()}>
				<AudioWaveform />
				{counts.pending === 0
					? "Everything is analyzed"
					: `Analyze ${plural(counts.pending, "new song", "new songs")}`}
			</Button>
			<Button
				variant="outline"
				disabled={counts.analyzed === 0}
				onClick={() => setConfirmAll(true)}
			>
				Re-analyze all
			</Button>
			{confirmAll && (
				<ConfirmDialog
					title={`Re-analyze all ${plural(counts.total, "song", "songs")}?`}
					confirmLabel="Re-analyze"
					onCancel={() => setConfirmAll(false)}
					onConfirm={() => {
						setConfirmAll(false);
						run(allIds);
					}}
				>
					Replaces the BPM and key found earlier. Runs in the background; you can stop it at any
					time and keep what is done.
				</ConfirmDialog>
			)}
		</div>
	);
}

function KeyFormatPicker({
	settings,
	onChange,
}: {
	settings: AnalysisSettings;
	onChange: (s: AnalysisSettings) => void;
}) {
	const options = [
		{ id: "musical", label: "Musical", example: "Am" },
		{ id: "camelot", label: "Camelot", example: "8A" },
	] as const;
	return (
		<div className="flex items-center justify-between gap-3 text-sm">
			<span>Key notation in tags</span>
			<div className="inline-flex rounded-md border p-0.5">
				{options.map((o) => (
					<button
						key={o.id}
						type="button"
						aria-pressed={settings.keyFormat === o.id}
						onClick={() => onChange({ ...settings, keyFormat: o.id })}
						className={cn(
							"rounded px-2.5 py-1 text-xs",
							settings.keyFormat === o.id
								? "bg-primary text-primary-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{o.label} <span className="opacity-70">({o.example})</span>
					</button>
				))}
			</div>
		</div>
	);
}

function SaveToFiles({
	withResults,
	onOutcome,
}: {
	withResults: number;
	onOutcome: (o: Outcome) => void;
}) {
	const settings = useAnalysisSettings();
	const setSettings = useSetAnalysisSettings();
	const save = useSaveAnalysisToFiles();
	const { running } = useAnalysisProgress();
	const [confirm, setConfirm] = useState(false);
	const current = settings.data;
	if (!current) {
		return null;
	}
	return (
		<div className="space-y-3">
			<div className="flex items-start justify-between gap-4">
				<div className="space-y-0.5">
					<div className="text-sm">Also save to file metadata</div>
					<p className="text-muted-foreground text-xs">
						After each analysis, write BPM and key into the songs' tags, so rekordbox, CDJs and
						other apps see them too. BPM is stored as a whole number. The audio is never changed.
					</p>
				</div>
				<Switch
					label="Also save to file metadata"
					checked={current.writeTags}
					onChange={(on) => setSettings.mutate({ ...current, writeTags: on })}
				/>
			</div>
			<KeyFormatPicker settings={current} onChange={(s) => setSettings.mutate(s)} />
			<Button
				variant="outline"
				size="sm"
				disabled={running || withResults === 0}
				onClick={() => setConfirm(true)}
			>
				<FileAudio />
				Save existing results to files now
			</Button>
			{confirm && (
				<ConfirmDialog
					title={`Write BPM and key into ${plural(withResults, "song", "songs")}?`}
					confirmLabel="Write tags"
					onCancel={() => setConfirm(false)}
					onConfirm={() => {
						setConfirm(false);
						save.mutate(undefined, {
							onSuccess: (report) => onOutcome({ kind: "tags", report }),
							onError: (e) => onOutcome({ kind: "error", message: String(e) }),
						});
					}}
				>
					Replaces the BPM and key tags these files hold now, in{" "}
					{current.keyFormat === "camelot" ? "Camelot (8A)" : "musical (Am)"} notation. Files that
					already match are left alone.
				</ConfirmDialog>
			)}
		</div>
	);
}

function Failures({ root }: { root: string }) {
	const failures = useAnalysisFailures(true).data ?? [];
	const [showAll, setShowAll] = useState(false);
	if (failures.length === 0) {
		return null;
	}
	const shown = showAll ? failures : failures.slice(0, 5);
	return (
		<Section title={`Could not analyze (${failures.length})`}>
			<ul className="divide-y rounded-lg border text-xs">
				{shown.map((f) => (
					<li key={f.path} className="space-y-0.5 px-3 py-2">
						<div className="truncate" title={f.path}>
							{relative(f.path, root)}
						</div>
						<div className="text-destructive">{f.error}</div>
					</li>
				))}
			</ul>
			{failures.length > shown.length && (
				<Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
					Show all {failures.length}
				</Button>
			)}
			<p className="text-muted-foreground text-xs">
				Right-click a song and choose “Analyze BPM &amp; key” to try it again.
			</p>
		</Section>
	);
}

function AnalysisBody() {
	const tracks = useTracks().data ?? [];
	const root = useLibraryRoot().data ?? "";
	const failures = useAnalysisFailures(true).data ?? [];
	const counts = useMemo(() => count(tracks), [tracks]);
	const withResults = tracks.filter((t) => t.analyzed && (t.bpm !== null || t.key !== null)).length;
	const [outcome, setOutcome] = useState<Outcome | null>(null);

	return (
		<div className="space-y-6">
			<p className="text-muted-foreground text-sm">
				Detects each song's tempo and musical key from its audio, like rekordbox's track analysis.
				Results show in the BPM and key columns and go into the rekordbox export.
			</p>
			<Section title="Library">
				<div className="grid grid-cols-2 gap-2">
					<Stat label={`of ${counts.total} songs analyzed`} value={counts.analyzed} />
					<Stat label="not analyzed yet" value={counts.pending} />
					<Stat label="with BPM" value={counts.withBpm} />
					<Stat label="with key" value={counts.withKey} />
				</div>
				{failures.length > 0 && (
					<p className="text-destructive text-xs">
						{plural(failures.length, "song", "songs")} could not be analyzed (see below).
					</p>
				)}
				<RunControls counts={counts} allIds={tracks.map((t) => t.id)} onOutcome={setOutcome} />
				{outcome && <OutcomeLine outcome={outcome} root={root} />}
			</Section>
			<Section title="File metadata">
				<SaveToFiles withResults={withResults} onOutcome={setOutcome} />
			</Section>
			<Failures root={root} />
		</div>
	);
}

/** Slide-over for BPM and key analysis: progress, results and saving them into file tags. */
export function AnalysisDrawer() {
	const open = useAnalysisDrawerOpen();
	return (
		<Drawer open={open} onClose={closeAnalysisDrawer} title="BPM & key analysis" width="w-[32rem]">
			<AnalysisBody />
		</Drawer>
	);
}
