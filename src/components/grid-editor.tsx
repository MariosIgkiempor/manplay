import { Popover } from "@base-ui/react/popover";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AudioWaveform,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronsLeft,
	ChevronsRight,
	Crosshair,
	Drum,
	Keyboard,
	Magnet,
	Pause,
	PencilLine,
	Play,
	Redo2,
	RotateCcw,
	Undo2,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HotCuePads, MemoryCues } from "#/components/cue-pads.tsx";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { ButtonGroup, GroupButton, PropertyRow } from "#/components/property-row.tsx";
import { SaveState } from "#/components/save-state.tsx";
import { StatusButton, StatusPortal } from "#/components/status-action.tsx";
import { Button } from "#/components/ui/button.tsx";
import { WaveformDetail, WaveformSeek } from "#/components/waveform.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { usePlayer, usePlayerTime } from "#/context/player-context.ts";
import { setBeatGrid, setTrackCues, type Track, type TrackAnalysis, trackCues } from "#/lib/api.ts";
import {
	downbeatAt,
	type Grid,
	gridOf,
	nudge,
	roundBpm,
	sameGrid,
	setBpm,
	shiftBar,
	withGrid,
} from "#/lib/beat-grid.ts";
import {
	addMemory,
	barBeat,
	type Cue,
	clearStart,
	START_COLOR,
	sameCues,
	setHot,
	setStart,
	snap,
	stamp,
	startOf,
} from "#/lib/cues.ts";
import {
	canRedo,
	canUndo,
	type EditHistory,
	record,
	redo,
	replacePresent,
	startHistory,
	undo,
} from "#/lib/edit-history.ts";
import { GRID_SHORTCUTS, type GridAction, gridAction } from "#/lib/grid-shortcuts.ts";
import { formatBpm } from "#/lib/musical-key.ts";
import { keyLabel } from "#/lib/platform.ts";
import { useAnalyze, useTracks } from "#/lib/queries.ts";
import {
	addTap,
	type Milliseconds,
	TAP_RUN_GAP,
	type TapReading,
	tapTempo,
} from "#/lib/tap-tempo.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { useAutosave } from "#/lib/unsaved.tsx";
import { useAnalysisProgress } from "#/lib/use-analysis-progress.ts";
import { useMetronome } from "#/lib/use-metronome.ts";
import { useStoredFlag, useStoredNumber } from "#/lib/use-stored-preference.ts";
import { TRACK_ANALYSIS_KEY, useTrackAnalysis } from "#/lib/use-track-analysis.ts";
import { cn } from "#/lib/utils.ts";
import {
	nextPreset,
	stepZoom,
	ZOOM_DEFAULT,
	ZOOM_PRESETS,
	zoomLabel,
} from "#/lib/waveform-zoom.ts";

/** Nudge steps: arrows move 10 ms, with ⌥ 1 ms. */
const COARSE = 0.01;
const FINE = 0.001;

const cuesKey = (trackId: number) => ["track-cues", trackId] as const;

/** Beat grid and cues for one song, edited on the deck: waveform, transport, hot cue pads. */
export function GridEditor({ trackId }: { trackId: number }) {
	const tracks = useTracks();
	const analysis = useTrackAnalysis(trackId);
	const cues = useQuery({ queryKey: cuesKey(trackId), queryFn: () => trackCues(trackId) });
	const track = tracks.data?.find((t) => t.id === trackId);
	if (analysis.isPending || cues.isPending || !track) {
		return null;
	}
	return analysis.data ? (
		<Editor key={trackId} track={track} analysis={analysis.data} savedCues={cues.data ?? []} />
	) : (
		<NotAnalyzed trackId={trackId} />
	);
}

/** A key press while typing (fields keep their own keys) or with a dialog open. */
function typingKey(e: globalThis.KeyboardEvent): boolean {
	const typing =
		e.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);
	return typing || document.querySelector("[role=dialog]") !== null;
}

/** A key press meant for something else: typing, a shortcut with ⌘ or Ctrl, or an open dialog. */
export function busyKey(e: globalThis.KeyboardEvent): boolean {
	return typingKey(e) || e.metaKey || e.ctrlKey;
}

/** A song without a kept waveform yet: analyse just this one, then the editor opens. */
function NotAnalyzed({ trackId }: { trackId: number }) {
	const analyze = useAnalyze();
	const { running } = useAnalysisProgress();
	const failed = analyze.isError || (analyze.data !== undefined && analyze.data.failed > 0);
	return (
		<EmptyState
			icon={<AudioWaveform />}
			title="Not analyzed yet"
			action={
				<Button disabled={running} onClick={() => analyze.mutate([trackId])}>
					{analyze.isPending ? "Analyzing…" : running ? "Library analysis running…" : "Analyze now"}
				</Button>
			}
		>
			Analyze the song to get a beat grid and waveform to edit.
			{failed && (
				<ErrorLine>
					{analyze.isError ? String(analyze.error) : "The audio could not be analyzed."}
				</ErrorLine>
			)}
		</EmptyState>
	);
}

/** Where the editor looks: the player's position when it plays this song, else its own. */
function usePosition(track: Track) {
	const player = usePlayer();
	const playerTime = usePlayerTime();
	const live = player.current?.id === track.id;
	const [cursor, setCursor] = useState(0);
	const position = useCallback(
		() => (live ? player.getTime() : cursor),
		[live, player.getTime, cursor],
	);
	const moveTo = (seconds: number) => {
		if (live) {
			player.seek(seconds);
		} else {
			setCursor(seconds);
		}
	};
	return {
		playing: live && player.playing,
		position,
		moveTo,
		revision: live ? playerTime : cursor,
		toggle: () => (live ? player.toggle() : player.play([track], 0)),
	};
}

function useSave(trackId: number) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({ grid, cues }: { grid: Grid | null; cues: readonly Cue[] | null }) => {
			const kept = grid ? await setBeatGrid(trackId, grid) : undefined;
			if (cues) {
				await setTrackCues(trackId, cues);
			}
			return kept;
		},
		onSuccess: async (kept, { cues }) => {
			if (kept !== undefined) {
				queryClient.setQueryData([...TRACK_ANALYSIS_KEY, trackId], kept);
			}
			if (cues) {
				queryClient.setQueryData(cuesKey(trackId), cues);
			}
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["playlist-tracks"] });
		},
	});
}

/** What the editor edits, undone and redone as one. */
interface Draft {
	grid: Grid;
	cues: readonly Cue[];
}

const sameDraft = (a: Draft, b: Draft) => sameGrid(a.grid, b.grid) && sameCues(a.cues, b.cues);

/** Edits kept as undo steps; a burst of one `group` of edit (taps, arrow presses) is one step. */
function useDraft(saved: Draft) {
	const [history, setHistory] = useState<EditHistory<Draft>>(() => startHistory(saved));
	const edit = useCallback((change: (d: Draft) => Draft, group?: string) => {
		const step = group ? { group, at: performance.now() } : null;
		setHistory((h) => record(h, change(h.present), sameDraft, step));
	}, []);
	return {
		history,
		setHistory,
		setGrid: (change: (g: Grid) => Grid, group?: string) =>
			edit((d) => ({ ...d, grid: change(d.grid) }), group),
		setCues: (change: (cs: readonly Cue[]) => readonly Cue[]) =>
			edit((d) => ({ ...d, cues: change(d.cues) })),
		replace: (draft: Draft) => edit(() => draft),
	};
}

/** The taps of the current run; they clear once a pause would start a new one. */
function useTaps() {
	const [taps, setTaps] = useState<readonly Milliseconds[]>([]);
	useEffect(() => {
		if (taps.length === 0) {
			return;
		}
		const id = window.setTimeout(() => setTaps([]), TAP_RUN_GAP);
		return () => window.clearTimeout(id);
	}, [taps]);
	/** Adds a tap now and returns the run's reading. */
	const tap = (): TapReading | null => {
		const run = addTap(taps, performance.now());
		setTaps(run);
		return tapTempo(run);
	};
	return { tapping: taps.length > 0, reading: tapTempo(taps), count: taps.length, tap };
}

function Editor({
	track,
	analysis,
	savedCues,
}: {
	track: Track;
	analysis: TrackAnalysis;
	savedCues: readonly Cue[];
}) {
	const savedGrid = gridOf(analysis);
	const { history, setHistory, setGrid, setCues, replace } = useDraft({
		grid: savedGrid,
		cues: savedCues,
	});
	const { grid, cues } = history.present;
	const [zoom, setZoom] = useState<number>(ZOOM_DEFAULT);
	const [snapOn, setSnapOn] = useState(true);
	const [metronomeOn, setMetronomeOn] = useState(false);
	const [wholeTaps, setWholeTaps] = useStoredFlag("grid-editor.whole-bpm-taps", true);
	// Per device: the delay depends on what you listen on (Bluetooth headphones add a lot).
	const [clickEarlierMs, setClickEarlierMs] = useStoredNumber(
		"grid-editor.metronome-earlier-ms",
		0,
	);
	const taps = useTaps();
	const pos = usePosition(track);
	const { volume } = usePlayer();
	useMetronome({
		grid,
		position: pos.position,
		playing: pos.playing,
		on: metronomeOn,
		volume,
		earlierMs: clickEarlierMs,
	});
	const save = useSave(track.id);
	// The same object until the grid is edited, so the waveforms are not set up again each render.
	const draft = useMemo(() => withGrid(analysis, grid), [analysis, grid]);
	// What the song had when the editor opened, for Revert.
	const [opened] = useState(() => ({ grid: savedGrid, cues: savedCues }));
	const changed = !sameGrid(grid, opened.grid) || !sameCues(cues, opened.cues);
	const autosave = useAutosave({
		label: `Grid and cues of "${track.title}"`,
		value: { grid, cues },
		saved: { grid: savedGrid, cues: savedCues },
		equal: (a, b) => sameGrid(a.grid, b.grid) && sameCues(a.cues, b.cues),
		save: async (v) => {
			const kept = await save.mutateAsync({
				grid: sameGrid(v.grid, savedGrid) ? null : v.grid,
				cues: sameCues(v.cues, savedCues) ? null : v.cues,
			});
			// The grid as kept (described from its first beat); adopt it unless edited since.
			if (kept) {
				setHistory((h) =>
					h.present.grid === v.grid ? replacePresent(h, { ...h.present, grid: gridOf(kept) }) : h,
				);
			}
		},
	});
	const period = grid.bpm ? 60 / grid.bpm : 0.5;
	const here = () => (snapOn ? snap(grid, pos.position()) : pos.position());

	const tap = () => {
		const reading = taps.tap();
		if (reading !== null) {
			const bpm = wholeTaps ? Math.round(reading.bpm) : reading.bpm;
			setGrid((g) => setBpm(g, bpm, pos.position()), "tap");
		}
	};
	const pad = (slot: number) => {
		const cue = cues.find((c) => c.slot === slot);
		if (cue) {
			pos.moveTo(cue.start);
		} else {
			setCues((cs) => setHot(cs, slot, here()));
		}
	};
	const [help, setHelp] = useState(false);
	const step = (beats: number) => pos.moveTo(Math.max(0, pos.position() + beats * period));
	const tempo = (by: number) =>
		setGrid(
			(g) => (g.bpm ? setBpm(g, Math.round((g.bpm + by) * 100) / 100, pos.position()) : g),
			"tempo",
		);
	const round = () => setGrid((g) => roundBpm(g, pos.position()));
	const undoing = {
		undo: () => setHistory(undo),
		redo: () => setHistory(redo),
		canUndo: canUndo(history),
		canRedo: canRedo(history),
	};
	const actions: Partial<Record<GridAction, (alt: boolean) => void>> = {
		play: () => pos.toggle(),
		start: () => setCues((cs) => setStart(cs, here())),
		downbeat: () => setGrid((g) => downbeatAt(g, pos.position())),
		tap,
		roundBpm: round,
		metronome: () => setMetronomeOn((on) => !on),
		undo: undoing.undo,
		redo: undoing.redo,
		memory: () => setCues((cs) => addMemory(cs, here())),
		snap: () => setSnapOn((on) => !on),
		zoom: () => setZoom(nextPreset),
		zoomIn: () => setZoom((z) => stepZoom(z, 1)),
		zoomOut: () => setZoom((z) => stepZoom(z, -1)),
		zoomReset: () => setZoom(ZOOM_DEFAULT),
		help: () => setHelp((h) => !h),
		save: () => void autosave.flush(),
		nudgeEarlier: (alt) => setGrid((g) => nudge(g, alt ? -FINE : -COARSE), "nudge"),
		nudgeLater: (alt) => setGrid((g) => nudge(g, alt ? FINE : COARSE), "nudge"),
		barEarlier: () => setGrid((g) => shiftBar(g, -1)),
		barLater: () => setGrid((g) => shiftBar(g, 1)),
		bpmUp: (alt) => tempo(alt ? 0.01 : 0.1),
		bpmDown: (alt) => tempo(alt ? -0.01 : -0.1),
		beatBack: () => step(-1),
		beatOn: () => step(1),
		barBack: () => step(-4),
		barOn: () => step(4),
		...Object.fromEntries(
			Array.from({ length: 8 }, (_, i) => [
				[`pad${i + 1}`, () => pad(i)],
				[`clearPad${i + 1}`, () => setCues((cs) => cs.filter((c) => c.slot !== i))],
			]).flat(),
		),
	};
	useGridKeys(actions, undoing);

	return (
		<div className="space-y-6 pb-8">
			<SaveState status={autosave.status} error={autosave.error} />
			<StatusPortal>
				{track.edited.grid && (
					<span
						className="flex shrink-0 items-center gap-1.5 text-primary"
						title="Re-analysis keeps this grid unless the BPM and key drawer says to replace edits"
					>
						<PencilLine className="size-3.5" /> Grid edited by you
					</span>
				)}
				{undoing.canUndo && (
					<StatusButton title={keyLabel("Undo the last edit (⌘Z)")} onClick={undoing.undo}>
						<Undo2 /> Undo
					</StatusButton>
				)}
				{undoing.canRedo && (
					<StatusButton title={keyLabel("Redo the edit undone (⇧⌘Z)")} onClick={undoing.redo}>
						<Redo2 /> Redo
					</StatusButton>
				)}
				{changed && (
					<StatusButton
						title="Back to the grid and cues the song had when you opened it. Undo brings the edits back."
						onClick={() => replace(opened)}
					>
						<RotateCcw /> Revert grid and cues
					</StatusButton>
				)}
			</StatusPortal>

			<Deck>
				<WaveformDetail
					analysis={draft}
					position={pos.position}
					running={pos.playing}
					window={zoom}
					onZoom={setZoom}
					cues={cues}
					onScrub={pos.moveTo}
					className="h-44 rounded-t-lg bg-transparent"
				/>
				<div className="border-white/5 border-t px-3 pt-2">
					<WaveformSeek
						analysis={draft}
						position={pos.position}
						running={pos.playing}
						duration={analysis.duration}
						disabled={false}
						cues={cues}
						onSeek={pos.moveTo}
						className="h-7"
					/>
				</div>
				<Transport
					playing={pos.playing}
					clock={
						<Clock
							grid={grid}
							position={pos.position}
							running={pos.playing}
							revision={pos.revision}
						/>
					}
					zoom={zoom}
					snapOn={snapOn}
					onSnap={setSnapOn}
					metronomeOn={metronomeOn}
					onMetronome={setMetronomeOn}
					startAt={startOf(cues)?.start ?? null}
					help={<ShortcutHelp open={help} onOpenChange={setHelp} />}
					tools={
						<>
							<BpmField
								grid={grid}
								onBpm={(bpm) => setGrid((g) => setBpm(g, bpm, pos.position()))}
							/>
							<TapButton
								tapping={taps.tapping}
								count={taps.count}
								reading={taps.reading}
								whole={wholeTaps}
								onTap={tap}
							/>
							<DownbeatButton onDownbeat={() => setGrid((g) => downbeatAt(g, pos.position()))}>
								<GridControls
									grid={grid}
									wholeTaps={wholeTaps}
									onWholeTaps={setWholeTaps}
									clickEarlierMs={clickEarlierMs}
									onClickEarlierMs={setClickEarlierMs}
									onBpm={(bpm) => setGrid((g) => setBpm(g, bpm, pos.position()))}
									onRound={round}
									onNudge={(s) => setGrid((g) => nudge(g, s), "nudge")}
									onShiftBar={(n) => setGrid((g) => shiftBar(g, n))}
								/>
							</DownbeatButton>
						</>
					}
					onZoom={setZoom}
					onToggle={pos.toggle}
					onCue={() => setCues((cs) => (startOf(cs) ? clearStart(cs) : setStart(cs, here())))}
					onStep={step}
				/>
			</Deck>

			<HotCuePads
				cues={cues}
				actions={{
					onSet: (slot) => setCues((cs) => setHot(cs, slot, here())),
					onJump: pos.moveTo,
					onChange: (slot, patch) =>
						setCues((cs) => cs.map((c) => (c.slot === slot ? { ...c, ...patch } : c))),
					onDelete: (slot) => setCues((cs) => cs.filter((c) => c.slot !== slot)),
				}}
			/>

			<MemoryCues
				cues={cues}
				onAdd={() => setCues((cs) => addMemory(cs, here()))}
				onJump={pos.moveTo}
				onRename={(cue, name) => setCues((cs) => cs.map((c) => (c === cue ? { ...c, name } : c)))}
				onDelete={(cue) => setCues((cs) => cs.filter((c) => c !== cue))}
			/>
		</div>
	);
}

/** The dark player surface the waveforms and transport sit on, like a CDJ's screen. */
function Deck({ children }: { children: ReactNode }) {
	return (
		<div className="overflow-hidden rounded-lg bg-neutral-950 text-neutral-200 shadow-inner ring-1 ring-white/10">
			{children}
		</div>
	);
}

function DeckButton({
	label,
	onClick,
	children,
	primary = false,
}: {
	label: string;
	onClick: () => void;
	children: ReactNode;
	primary?: boolean;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={onClick}
			className={cn(
				"grid size-8 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-4",
				primary
					? "bg-primary text-primary-foreground hover:bg-primary/90"
					: "text-neutral-400 hover:bg-white/10 hover:text-neutral-100",
			)}
		>
			{children}
		</button>
	);
}

/** Undo and redo of the editor's own edits. */
interface Undoing {
	undo: () => void;
	redo: () => void;
	canUndo: boolean;
	canRedo: boolean;
}

/**
 * Runs the editor's keyboard shortcuts from anywhere in the open editor, not only once something
 * in it has focus. Ignored while typing, with a dialog open, or once the panel shows something else.
 */
function useGridKeys(
	actions: Partial<Record<GridAction, (alt: boolean) => void>>,
	undoing: Undoing,
) {
	const detail = useDetail();
	const latest = useRef(actions);
	latest.current = actions;
	const latestUndoing = useRef(undoing);
	latestUndoing.current = undoing;
	// Only while the panel still shows a song.
	const showing = useRef(false);
	showing.current = detail.view?.kind === "song";
	useEffect(() => {
		const onKey = (e: globalThis.KeyboardEvent) => {
			const name = gridAction(e);
			// ⌘S saves even from a field; everything else waits until you stop typing.
			if (!showing.current || (busyKey(e) && name !== "save")) {
				return;
			}
			const run = name === null ? undefined : latest.current[name];
			if (run) {
				e.preventDefault();
				run(e.altKey);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	// ⌘Z undoes the editor's edits before the app-wide undo (of file changes) sees it; with no
	// edit to undo here it is left to that.
	useEffect(() => {
		const onKey = (e: globalThis.KeyboardEvent) => {
			const name = gridAction(e);
			if (!showing.current || typingKey(e) || (name !== "undo" && name !== "redo")) {
				return;
			}
			const edits = latestUndoing.current;
			if (name === "undo" ? edits.canUndo : edits.canRedo) {
				e.preventDefault();
				e.stopImmediatePropagation();
				edits[name]();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);
}

/** The keyboard button in the header, and the cheat sheet it opens (also on ?). */
function ShortcutHelp({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Popover.Root open={open} onOpenChange={onOpenChange}>
			<Popover.Trigger
				aria-label="Keyboard shortcuts"
				title="Keyboard shortcuts (?)"
				className="grid size-7 place-items-center rounded-md text-neutral-400 outline-none transition-colors hover:bg-white/10 hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-ring/60 data-[popup-open]:bg-white/10 data-[popup-open]:text-neutral-50 [&_svg]:size-4"
			>
				<Keyboard />
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner sideOffset={6} align="end" className="z-50">
					<Popover.Popup className="w-[34rem] rounded-lg border bg-popover p-4 text-popover-foreground text-sm shadow-lg outline-none">
						<div className="grid grid-cols-2 gap-x-6 gap-y-4">
							{GRID_SHORTCUTS.map((g) => (
								<section key={g.group} className="space-y-1.5">
									<h3 className="font-medium text-muted-foreground text-xs">{g.group}</h3>
									<dl className="space-y-1">
										{g.items.map(([keys, what]) => (
											<div key={keys} className="flex items-baseline justify-between gap-3">
												<dt className="text-xs">{keyLabel(what)}</dt>
												<dd>
													<kbd className="whitespace-nowrap rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
														{keyLabel(keys)}
													</kbd>
												</dd>
											</div>
										))}
									</dl>
								</section>
							))}
						</div>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

/** Makes the playhead beat 1 of a bar; its other half opens the rest of the beat grid settings. */
function DownbeatButton({ onDownbeat, children }: { onDownbeat: () => void; children: ReactNode }) {
	const half =
		"flex h-7 items-center gap-1.5 whitespace-nowrap text-neutral-300 text-xs outline-none transition-colors hover:bg-white/10 hover:text-neutral-50 focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5";
	return (
		<div className="flex items-center rounded-md bg-white/5">
			<button
				type="button"
				title="Make the playhead beat 1 of a bar (D)"
				onClick={onDownbeat}
				className={cn(half, "rounded-l-md px-2")}
			>
				<Crosshair /> Set 1
			</button>
			<Popover.Root>
				<Popover.Trigger
					aria-label="Beat grid settings"
					title="Beat grid settings"
					className={cn(
						half,
						"rounded-r-md border-white/10 border-l px-1.5 data-[popup-open]:bg-white/10 data-[popup-open]:text-neutral-50 [&_svg]:size-3",
					)}
				>
					<ChevronDown />
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Positioner sideOffset={6} align="end" className="z-50">
						<Popover.Popup className="w-80 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg outline-none">
							{children}
						</Popover.Popup>
					</Popover.Positioner>
				</Popover.Portal>
			</Popover.Root>
		</div>
	);
}

function Transport({
	playing,
	clock,
	zoom,
	snapOn,
	onSnap,
	metronomeOn,
	onMetronome,
	startAt,
	help,
	tools,
	onZoom,
	onToggle,
	onCue,
	onStep,
}: {
	playing: boolean;
	/** Where the playhead is, as a time and a bar and beat. */
	clock: ReactNode;
	zoom: number;
	snapOn: boolean;
	onSnap: (on: boolean) => void;
	metronomeOn: boolean;
	onMetronome: (on: boolean) => void;
	/** Where the song starts (rekordbox's main cue), or null for its first beat. */
	startAt: number | null;
	/** The keyboard shortcuts button, at the end. */
	help: ReactNode;
	/** BPM and beat grid controls, shown beside snap. */
	tools: ReactNode;
	onZoom: (z: number) => void;
	onToggle: () => void;
	/** Sets the start (main) cue at the playhead, or clears it when set. */
	onCue: () => void;
	onStep: (beats: number) => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-3 py-2.5">
			{/* Playing and where you are first; grid tools and zoom after, all from the left. */}
			<div className="flex items-center gap-0.5">
				{/* The CDJ's CUE button: where the song starts. Lit while set; pressing it then clears it. */}
				<button
					type="button"
					onClick={onCue}
					aria-pressed={startAt !== null}
					title={
						startAt === null
							? "The song starts at its first beat. Click to start it at the playhead (C)."
							: `The song starts at ${stamp(startAt)}. Click to start it at its first beat again.`
					}
					aria-label={startAt === null ? "Set the start at the playhead" : "Clear the start"}
					className="mr-2 grid size-9 place-items-center rounded-full border-2 font-semibold text-[10px] tracking-wide outline-none transition-colors hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring/60"
					style={
						startAt === null
							? { borderColor: START_COLOR, color: START_COLOR }
							: { borderColor: START_COLOR, background: START_COLOR, color: "#1a1206" }
					}
				>
					CUE
				</button>
				<DeckButton label="Back one bar" onClick={() => onStep(-4)}>
					<ChevronsLeft />
				</DeckButton>
				<DeckButton label="Back one beat" onClick={() => onStep(-1)}>
					<ChevronLeft />
				</DeckButton>
				<DeckButton label={playing ? "Pause (Space)" : "Play (Space)"} onClick={onToggle} primary>
					{playing ? <Pause /> : <Play />}
				</DeckButton>
				<DeckButton label="On one beat" onClick={() => onStep(1)}>
					<ChevronRight />
				</DeckButton>
				<DeckButton label="On one bar" onClick={() => onStep(4)}>
					<ChevronsRight />
				</DeckButton>
			</div>
			{clock}
			<div className="ml-auto">{help}</div>
			<div className="flex basis-full flex-wrap items-center gap-2 border-white/5 border-t pt-2.5">
				<div className="flex items-center gap-2">
					{tools}
					<button
						type="button"
						aria-pressed={snapOn}
						aria-label="Snap to beat"
						title={snapOn ? "Snap to beat: on" : "Snap to beat: off"}
						onClick={() => onSnap(!snapOn)}
						className={cn(
							"grid size-7 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5",
							snapOn
								? "bg-primary/20 text-primary"
								: "text-neutral-400 hover:bg-white/10 hover:text-neutral-100",
						)}
					>
						<Magnet />
					</button>
					<button
						type="button"
						aria-pressed={metronomeOn}
						aria-label="Metronome"
						title={
							metronomeOn
								? "Metronome: on. Clicks on every beat of the grid while the song plays (K)."
								: "Metronome: off. Click to hear the grid's beats while the song plays (K)."
						}
						onClick={() => onMetronome(!metronomeOn)}
						className={cn(
							"grid size-7 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5",
							metronomeOn
								? "bg-primary/20 text-primary"
								: "text-neutral-400 hover:bg-white/10 hover:text-neutral-100",
						)}
					>
						<Drum />
					</button>
				</div>
				<fieldset
					className="flex rounded-md bg-white/5 p-0.5"
					aria-label="Zoom"
					title={`Showing ${zoomLabel(zoom)}. Pinch the waveform or press + and − to zoom, 0 to reset.`}
				>
					{!ZOOM_PRESETS.some((z) => Math.abs(z - zoom) < 1e-6) && (
						<span className="rounded bg-white/15 px-2 py-0.5 text-neutral-50 text-xs tabular-nums">
							{zoomLabel(zoom)}
						</span>
					)}
					{ZOOM_PRESETS.map((z) => (
						<button
							key={z}
							type="button"
							aria-pressed={Math.abs(z - zoom) < 1e-6}
							title={`Show ${z * 2} seconds`}
							onClick={() => onZoom(z)}
							className={cn(
								"rounded px-2 py-0.5 text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
								Math.abs(z - zoom) < 1e-6
									? "bg-white/15 text-neutral-50"
									: "text-neutral-400 hover:text-neutral-100",
							)}
						>
							{z * 2}s
						</button>
					))}
				</fieldset>
			</div>
		</div>
	);
}

/**
 * The playhead as a time and as a bar and beat. While the song plays it follows the audio every
 * frame on its own, so the editor around it is not drawn again sixty times a second.
 */
function Clock({
	grid,
	position,
	running,
	revision,
}: {
	grid: Grid;
	position: () => number;
	running: boolean;
	/** Changes when the position moved while paused. */
	revision: unknown;
}) {
	const [time, setTime] = useState(position);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `revision` only asks to read again
	useEffect(() => {
		setTime(position());
		if (!running) {
			return;
		}
		let id = requestAnimationFrame(function loop() {
			setTime(position());
			id = requestAnimationFrame(loop);
		});
		return () => cancelAnimationFrame(id);
	}, [position, running, revision]);
	const at = barBeat(grid, time);
	return (
		<div className="flex min-w-0 items-baseline gap-3 tabular-nums">
			<span className="font-medium text-lg text-neutral-50 tracking-tight">{stamp(time)}</span>
			<span className="truncate text-neutral-400 text-xs" title="Bar and beat by the grid">
				{at ? `Bar ${at.bar}, beat ${at.beat}` : "Before the grid"}
			</span>
		</div>
	);
}

function BpmField({ grid, onBpm }: { grid: Grid; onBpm: (bpm: number) => void }) {
	const shown = grid.bpm ? grid.bpm.toFixed(2) : "";
	const [text, setText] = useState(shown);
	useEffect(() => setText(shown), [shown]);
	const commit = () => {
		const bpm = Number(text.replace(",", "."));
		if (bpm >= 40 && bpm <= 300) {
			onBpm(Math.round(bpm * 100) / 100);
		} else {
			setText(shown);
		}
	};
	return (
		<label className="flex h-7 items-baseline gap-1 rounded-md bg-white/5 px-2 focus-within:ring-2 focus-within:ring-ring/60">
			<input
				value={text}
				inputMode="decimal"
				aria-label="BPM"
				placeholder="–"
				title="Tempo of the grid. Type a new one and press Enter."
				className="h-7 w-14 bg-transparent text-right font-medium text-neutral-50 text-sm tabular-nums outline-none placeholder:text-neutral-500"
				onChange={(e) => setText(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						commit();
						e.currentTarget.blur();
					}
				}}
			/>
			<span className="text-neutral-400 text-xs">BPM</span>
		</label>
	);
}

/**
 * Tap along to set the tempo. While tapping it shows the tempo the taps give and how many there
 * have been; the grid follows from the fourth tap.
 */
function TapButton({
	tapping,
	count,
	reading,
	whole,
	onTap,
}: {
	tapping: boolean;
	count: number;
	reading: TapReading | null;
	whole: boolean;
	onTap: () => void;
}) {
	const shown = reading && (whole ? String(Math.round(reading.bpm)) : formatBpm(reading.bpm));
	return (
		<button
			type="button"
			onClick={onTap}
			aria-pressed={tapping}
			title={`Tap along to the beat (T). The grid follows from the fourth tap${whole ? ", rounded to a whole BPM" : ""}; stop for two seconds to start over.`}
			className={cn(
				"flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
				tapping
					? "bg-primary/20 text-primary"
					: "bg-white/5 text-neutral-300 hover:bg-white/10 hover:text-neutral-50",
			)}
		>
			<span className="font-medium">Tap</span>
			{tapping && (
				<span aria-live="polite">
					{shown ?? "…"}
					<span className="text-primary/70"> · {count}</span>
				</span>
			)}
		</button>
	);
}

/** Metronome timing steps: 10 ms a press, 50 ms with ⇧. */
const CLICK_STEP_MS = 10;
const CLICK_BIG_STEP_MS = 50;
const CLICK_LIMIT_MS = 500;

/**
 * Moves the metronome's clicks earlier or later, for listening devices that delay sound more
 * than they report, such as Bluetooth headphones. The grid does not move.
 */
function MetronomeTiming({
	earlierMs,
	onChange,
}: {
	earlierMs: number;
	onChange: (ms: number) => void;
}) {
	const step = (e: React.MouseEvent, direction: 1 | -1) => {
		const by = (e.shiftKey ? CLICK_BIG_STEP_MS : CLICK_STEP_MS) * direction;
		onChange(Math.max(-CLICK_LIMIT_MS, Math.min(CLICK_LIMIT_MS, earlierMs + by)));
	};
	const shown =
		earlierMs === 0
			? "On time"
			: `${Math.abs(earlierMs)} ms ${earlierMs > 0 ? "earlier" : "later"}`;
	return (
		<PropertyRow
			label={<span className="truncate text-muted-foreground text-xs">Metronome</span>}
			title={keyLabel(
				"If the clicks sound late or early, move them until they land on the beat. Remembered on this device. 10 ms a press, 50 ms with ⇧.",
			)}
		>
			<ButtonGroup>
				<GroupButton label="Clicks earlier" onClick={(e) => step(e, 1)}>
					<ChevronLeft />
				</GroupButton>
				<GroupButton
					label="Clicks on time"
					title="Play the clicks on the grid again"
					disabled={earlierMs === 0}
					onClick={() => onChange(0)}
				>
					<span className="min-w-20 text-center">{shown}</span>
				</GroupButton>
				<GroupButton label="Clicks later" onClick={(e) => step(e, -1)}>
					<ChevronRight />
				</GroupButton>
			</ButtonGroup>
		</PropertyRow>
	);
}

function GridControls({
	grid,
	wholeTaps,
	onWholeTaps,
	clickEarlierMs,
	onClickEarlierMs,
	onBpm,
	onRound,
	onNudge,
	onShiftBar,
}: {
	grid: Grid;
	wholeTaps: boolean;
	onWholeTaps: (on: boolean) => void;
	clickEarlierMs: number;
	onClickEarlierMs: (ms: number) => void;
	onBpm: (bpm: number) => void;
	onRound: () => void;
	onNudge: (seconds: number) => void;
	onShiftBar: (beats: number) => void;
}) {
	const label = (text: string) => (
		<span className="truncate text-muted-foreground text-xs">{text}</span>
	);
	return (
		<div className="space-y-2">
			<div className="flex items-baseline justify-between gap-3">
				<h3 className={typeScale.sectionTitle}>Beat grid</h3>
				<span className="text-muted-foreground text-xs tabular-nums">
					{grid.bpm ? `${formatBpm(grid.bpm)} BPM` : "No tempo"}
				</span>
			</div>
			<div className="space-y-0.5">
				<PropertyRow label={label("Tempo")}>
					<ButtonGroup>
						<GroupButton
							disabled={!grid.bpm}
							title="Half the tempo"
							onClick={() => grid.bpm && onBpm(grid.bpm / 2)}
						>
							½×
						</GroupButton>
						<GroupButton
							disabled={!grid.bpm}
							title="Double the tempo"
							onClick={() => grid.bpm && onBpm(grid.bpm * 2)}
						>
							2×
						</GroupButton>
						<GroupButton
							disabled={!grid.bpm || Number.isInteger(grid.bpm)}
							title="Round the tempo to a whole BPM, keeping the beat at the playhead (R)"
							onClick={onRound}
						>
							Round
						</GroupButton>
					</ButtonGroup>
				</PropertyRow>
				<PropertyRow label={label("Tap")} title="How the tempo you tap is used">
					<ButtonGroup>
						<GroupButton
							active={wholeTaps}
							title="Round the tapped tempo to a whole BPM, as most dance music is"
							onClick={() => onWholeTaps(!wholeTaps)}
						>
							Whole BPM
						</GroupButton>
					</ButtonGroup>
				</PropertyRow>
				<MetronomeTiming earlierMs={clickEarlierMs} onChange={onClickEarlierMs} />
				<PropertyRow
					label={label("Move grid")}
					title={keyLabel("10 ms a press, 1 ms with ⌥. Arrow keys do the same.")}
				>
					<ButtonGroup>
						<GroupButton onClick={(e) => onNudge(e.altKey ? -FINE : -COARSE)}>
							<ChevronLeft /> Earlier
						</GroupButton>
						<GroupButton onClick={(e) => onNudge(e.altKey ? FINE : COARSE)}>
							Later <ChevronRight />
						</GroupButton>
					</ButtonGroup>
				</PropertyRow>
				<PropertyRow
					label={label("Beat 1")}
					title={keyLabel("Which beat of the bar is beat 1. ⇧← and ⇧→ do the same.")}
				>
					<ButtonGroup>
						<GroupButton label="Beat 1 a beat earlier" onClick={() => onShiftBar(-1)}>
							<ChevronLeft /> Earlier
						</GroupButton>
						<GroupButton label="Beat 1 a beat later" onClick={() => onShiftBar(1)}>
							Later <ChevronRight />
						</GroupButton>
					</ButtonGroup>
				</PropertyRow>
			</div>
			<p className="text-muted-foreground text-xs">
				{keyLabel("Hold ⌥ to move the grid 1 ms at a time.")}
			</p>
		</div>
	);
}
