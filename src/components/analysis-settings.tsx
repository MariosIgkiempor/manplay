import { AudioWaveform, FileAudio, RotateCcw, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { FrameSection } from "#/components/frame.tsx";
import { ErrorLine, Section } from "#/components/page.tsx";
import { SettingRow, SettingRows } from "#/components/setting-row.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ConfirmButton } from "#/components/ui/confirm-button.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import {
	type AnalysisProgress,
	type AnalysisReport,
	type AnalysisSettings as AnalysisSettingsValue,
	cancelAnalysis,
	type FileFailure,
	type TagWriteReport,
	type Track,
} from "#/lib/api.ts";
import { WELL_ROWS } from "#/lib/page-layout.ts";
import {
	useAnalysisFailures,
	useAnalysisSettings,
	useAnalyze,
	useLibraryRoot,
	useSaveAnalysisToFiles,
	useSetAnalysisSettings,
	useTracks,
} from "#/lib/queries.ts";
import { useAnalysisProgress } from "#/lib/use-analysis-progress.ts";
import { cn } from "#/lib/utils.ts";

const plural = (n: number, one: string, many: string) =>
	`${n.toLocaleString()} ${n === 1 ? one : many}`;

interface Counts {
	total: number;
	analyzed: number;
	pending: number;
	withBpm: number;
	withKey: number;
	/** Analyzed songs with a BPM or key to write into tags. */
	withResults: number;
	/** Songs with a BPM, key or beat grid set by hand. */
	edited: number;
}

function count(tracks: readonly Track[]): Counts {
	const analyzed = tracks.filter((t) => t.analyzed);
	return {
		total: tracks.length,
		analyzed: analyzed.length,
		pending: tracks.length - analyzed.length,
		withBpm: analyzed.filter((t) => t.bpm !== null).length,
		withKey: analyzed.filter((t) => t.key !== null).length,
		withResults: analyzed.filter((t) => t.bpm !== null || t.key !== null).length,
		edited: tracks.filter((t) => t.edited.bpm || t.edited.key || t.edited.grid).length,
	};
}

/** Where a file sits under the library folder, for compact lists. */
function relative(path: string, root: string): string {
	return root && path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]/, "") : path;
}

type Outcome =
	| { kind: "analysis"; report: AnalysisReport }
	| { kind: "tags"; report: TagWriteReport }
	| { kind: "error"; message: string };

function tagSummary(r: TagWriteReport): string {
	return [
		`Wrote ${plural(r.written, "file", "files")}`,
		r.unchanged > 0 && `${r.unchanged.toLocaleString()} already matched`,
		r.failed.length > 0 && `${r.failed.length.toLocaleString()} failed`,
	]
		.filter(Boolean)
		.join(", ");
}

function summary(outcome: Exclude<Outcome, { kind: "error" }>): string {
	if (outcome.kind === "tags") {
		return `${tagSummary(outcome.report)}.`;
	}
	const r = outcome.report;
	const parts = [
		`Analyzed ${plural(r.analyzed, "song", "songs")}`,
		r.failed > 0 && `${r.failed.toLocaleString()} failed`,
		r.cancelled > 0 && `${r.cancelled.toLocaleString()} left after stopping`,
	].filter(Boolean);
	return `${parts.join(", ")}.${r.tags ? ` ${tagSummary(r.tags)}.` : ""}`;
}

function OutcomeLine({ outcome }: { outcome: Outcome }) {
	if (outcome.kind === "error") {
		return <ErrorLine>{outcome.message}</ErrorLine>;
	}
	return <p className="text-muted-foreground text-sm">{summary(outcome)}</p>;
}

/** How much of the library has been analyzed, or how far the running analysis has got. */
function Meter({
	counts,
	running,
	progress,
}: {
	counts: Counts;
	running: boolean;
	progress: AnalysisProgress | null;
}) {
	const live = running && progress !== null && progress.total > 0;
	const done = live ? progress.done : counts.analyzed;
	const total = live ? progress.total : counts.total;
	const percent = total === 0 ? 0 : Math.min(100, (done / total) * 100);
	let label = `${done.toLocaleString()} of ${plural(total, "song", "songs")} analyzed`;
	if (running) {
		label = progress?.phase === "saving" ? "Writing tags" : "Analyzing";
		if (live) {
			label += ` ${done.toLocaleString()} of ${total.toLocaleString()}`;
		}
	}
	return (
		<div className="space-y-2">
			<p className="font-medium text-sm tabular-nums">{label}</p>
			<div
				role="progressbar"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(percent)}
				className="h-1.5 overflow-hidden rounded-full bg-muted"
			>
				<div
					className={cn(
						"h-full rounded-full bg-primary transition-[width] duration-300",
						running && !live && "w-full animate-pulse",
					)}
					style={running && !live ? undefined : { width: `${percent}%` }}
				/>
			</div>
		</div>
	);
}

function Figures({ counts, failed }: { counts: Counts; failed: number }) {
	const items = [
		{ label: "with BPM", value: counts.withBpm },
		{ label: "with key", value: counts.withKey },
		{ label: "not analyzed", value: counts.pending },
	];
	return (
		<dl className="flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground text-xs tabular-nums">
			{items.map((i) => (
				<div key={i.label} className="flex gap-1">
					<dt className="sr-only">{i.label}</dt>
					<dd>
						<span className="text-foreground">{i.value.toLocaleString()}</span> {i.label}
					</dd>
				</div>
			))}
			{failed > 0 && (
				<div className="flex gap-1 text-destructive">
					<dt className="sr-only">failed</dt>
					<dd>{failed.toLocaleString()} failed</dd>
				</div>
			)}
		</dl>
	);
}

function RunControls({
	counts,
	running,
	stopping,
	saving,
	onRun,
	onStop,
	replaceEdits,
}: {
	counts: Counts;
	/** Whether re-analysis replaces values set by hand (the setting). */
	replaceEdits: boolean;
	running: boolean;
	stopping: boolean;
	saving: boolean;
	onRun: (all: boolean) => void;
	onStop: () => void;
}) {
	if (running) {
		return (
			<Button variant="outline" disabled={stopping || saving} onClick={onStop}>
				<Square />
				{stopping ? "Stopping…" : "Stop"}
			</Button>
		);
	}
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Button disabled={counts.pending === 0} onClick={() => onRun(false)}>
				<AudioWaveform />
				{counts.pending === 0 ? "All analyzed" : `Analyze ${counts.pending.toLocaleString()} new`}
			</Button>
			<ConfirmButton
				variant="ghost"
				disabled={counts.analyzed === 0}
				data-hint="Detect BPM and key again for every song, replacing earlier results"
				confirmLabel={`Re-analyze ${plural(counts.total, "song", "songs")}`}
				consequence={
					<>
						{counts.edited === 0 || replaceEdits
							? "Every BPM, key and beat grid is detected again"
							: "Detected BPM, keys and beat grids are replaced"}
						{counts.edited > 0 &&
							(replaceEdits
								? `, including the ${plural(counts.edited, "song", "songs")} you edited by hand.`
								: `; the ${plural(counts.edited, "song", "songs")} you edited by hand keep your values.`)}
						{counts.edited === 0 && "."} You can stop at any time and keep what is done.
					</>
				}
				onConfirm={() => onRun(true)}
			>
				<RotateCcw />
				Re-analyze all
			</ConfirmButton>
		</div>
	);
}

function KeyFormatPicker({
	settings,
	onChange,
}: {
	settings: AnalysisSettingsValue;
	onChange: (s: AnalysisSettingsValue) => void;
}) {
	const options = [
		{ id: "musical", label: "Am", title: "Musical (Am, F#)" },
		{ id: "camelot", label: "8A", title: "Camelot (8A, 2B)" },
	] as const;
	return (
		<div
			role="radiogroup"
			aria-label="Key notation"
			className="inline-flex rounded-md border p-0.5"
		>
			{options.map((o) => (
				<button
					key={o.id}
					type="button"
					aria-pressed={settings.keyFormat === o.id}
					data-hint={o.title}
					onClick={() => onChange({ ...settings, keyFormat: o.id })}
					className={cn(
						"rounded px-2.5 py-0.5 text-xs tabular-nums",
						settings.keyFormat === o.id
							? "bg-muted font-medium text-foreground"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}

function FileTags({
	withResults,
	running,
	onOutcome,
}: {
	withResults: number;
	running: boolean;
	onOutcome: (o: Outcome) => void;
}) {
	const settings = useAnalysisSettings();
	const setSettings = useSetAnalysisSettings();
	const save = useSaveAnalysisToFiles();
	const current = settings.data;
	if (!current) {
		return null;
	}
	const notation = current.keyFormat === "camelot" ? "Camelot (8A)" : "musical (Am)";
	return (
		<Section
			title="File tags"
			action={
				<ConfirmButton
					variant="ghost"
					size="sm"
					disabled={running || withResults === 0}
					data-hint={`Write the saved BPM and key of ${plural(withResults, "song", "songs")} into their files, e.g. songs analysed before results were always written`}
					confirmLabel={`Write tags into ${plural(withResults, "song", "songs")}`}
					consequence={`Their BPM and key tags are replaced, with keys in ${notation} notation. Files that already match are left alone.`}
					onConfirm={() =>
						save.mutate(undefined, {
							onSuccess: (report) => onOutcome({ kind: "tags", report }),
							onError: (e) => onOutcome({ kind: "error", message: String(e) }),
						})
					}
				>
					<FileAudio />
					Write now
				</ConfirmButton>
			}
		>
			<SettingRows>
				<SettingRow label="Key notation">
					<KeyFormatPicker settings={current} onChange={(s) => setSettings.mutate(s)} />
				</SettingRow>
			</SettingRows>
		</Section>
	);
}

/** Whether re-analysis may replace BPM, keys and grids set by hand. Off unless chosen. */
function HandEdits({ edited }: { edited: number }) {
	const settings = useAnalysisSettings();
	const setSettings = useSetAnalysisSettings();
	const current = settings.data;
	if (!current) {
		return null;
	}
	return (
		<Section title="Your edits" count={edited}>
			<SettingRows>
				<SettingRow
					label="Re-analysis replaces my edits"
					title="Off: a BPM, key or beat grid you set by hand stays when songs are analyzed again. Right-click a song to discard its edits."
				>
					<Switch
						label="Re-analysis replaces BPM, keys and beat grids set by hand"
						checked={current.replaceEdits}
						onChange={(on) => setSettings.mutate({ ...current, replaceEdits: on })}
					/>
				</SettingRow>
			</SettingRows>
		</Section>
	);
}

function Failures({
	failures,
	root,
	idOf,
	running,
	onRetry,
}: {
	failures: readonly FileFailure[];
	root: string;
	idOf: (path: string) => number | undefined;
	running: boolean;
	onRetry: (ids: number[]) => void;
}) {
	const [showAll, setShowAll] = useState(false);
	if (failures.length === 0) {
		return null;
	}
	const shown = showAll ? failures : failures.slice(0, 5);
	const ids = failures.map((f) => idOf(f.path)).filter((id) => id !== undefined);
	return (
		<Section
			title="Could not analyze"
			count={failures.length}
			action={
				<Button variant="ghost" size="sm" disabled={running} onClick={() => onRetry(ids)}>
					<RotateCcw />
					Retry all
				</Button>
			}
		>
			<ul className={WELL_ROWS}>
				{shown.map((f) => {
					const id = idOf(f.path);
					return (
						<li key={f.path} className="flex items-center gap-3 px-3 py-2">
							<div className="min-w-0 flex-1 text-xs">
								<div className="truncate" data-hint={f.path}>
									{relative(f.path, root)}
								</div>
								<div className="truncate text-destructive" data-hint={f.error}>
									{f.error}
								</div>
							</div>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`Retry ${relative(f.path, root)}`}
								data-hint="Retry"
								disabled={running || id === undefined}
								onClick={() => id !== undefined && onRetry([id])}
							>
								<RotateCcw />
							</Button>
						</li>
					);
				})}
			</ul>
			{failures.length > shown.length && (
				<Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
					Show all {failures.length.toLocaleString()}
				</Button>
			)}
		</Section>
	);
}

function AnalysisBody() {
	const tracks = useTracks().data ?? [];
	const root = useLibraryRoot().data ?? "";
	const failures = useAnalysisFailures(true).data ?? [];
	const counts = useMemo(() => count(tracks), [tracks]);
	const idByPath = useMemo(() => new Map(tracks.map((t) => [t.path, t.id])), [tracks]);
	const analyze = useAnalyze();
	const replaceEdits = useAnalysisSettings().data?.replaceEdits ?? false;
	const { running, progress } = useAnalysisProgress();
	const [stopping, setStopping] = useState(false);
	const [outcome, setOutcome] = useState<Outcome | null>(null);

	const run = (ids?: number[]) => {
		setOutcome(null);
		analyze.mutate(ids, {
			onSuccess: (report) => setOutcome({ kind: "analysis", report }),
			onError: (e) => setOutcome({ kind: "error", message: String(e) }),
			onSettled: () => setStopping(false),
		});
	};

	return (
		<div className="space-y-8">
			<section className="space-y-3">
				<Meter counts={counts} running={running} progress={progress} />
				<Figures counts={counts} failed={failures.length} />
				<RunControls
					counts={counts}
					replaceEdits={replaceEdits}
					running={running}
					stopping={stopping}
					saving={progress?.phase === "saving"}
					onRun={(all) => run(all ? tracks.map((t) => t.id) : undefined)}
					onStop={() => {
						setStopping(true);
						void cancelAnalysis();
					}}
				/>
				{outcome && !running && <OutcomeLine outcome={outcome} />}
			</section>
			<FileTags withResults={counts.withResults} running={running} onOutcome={setOutcome} />
			<HandEdits edited={counts.edited} />
			<Failures
				failures={failures}
				root={root}
				idOf={(path) => idByPath.get(path)}
				running={running}
				onRetry={(ids) => run(ids)}
			/>
		</div>
	);
}

/**
 * BPM and key analysis in Settings: how much of the library is analysed, running it again, the
 * key notation written into files, hand edits and failures. New songs are analysed on their own.
 */
export function AnalysisSettings() {
	return (
		<FrameSection
			title="BPM & key"
			description="Songs are analysed as they come into the library, and their BPM and key are written into the files so other apps and players see them. A BPM or key you set by hand is never replaced."
			wellClassName="p-4"
		>
			<AnalysisBody />
		</FrameSection>
	);
}
