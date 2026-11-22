import { Popover } from "@base-ui/react/popover";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	ArrowLeft,
	ArrowRight,
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
	PencilLine,
	Redo2,
	RotateCcw,
	Undo2,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PadStrip } from "#/components/cue-pads.tsx";
import { ButtonGroup, GroupButton, PropertyRow } from "#/components/property-row.tsx";
import { SaveState } from "#/components/save-state.tsx";
import { StatusButton, StatusPortal } from "#/components/status-action.tsx";
import { Button } from "#/components/ui/button.tsx";
import { WaveformDetail } from "#/components/waveform.tsx";
import { usePlayer, usePlayerTime } from "#/context/player-context.ts";
import { setBeatGrid, setTrackCues, type Track, type TrackAnalysis } from "#/lib/api.ts";
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
import { keyTakenElsewhere, typingKey } from "#/lib/keyboard.ts";
import { formatBpm } from "#/lib/musical-key.ts";
import { DECK_COLUMNS } from "#/lib/page-layout.ts";
import { keyLabel } from "#/lib/platform.ts";
import { cuesKey, useAnalyze, useTrackCues } from "#/lib/queries.ts";
import { chordLabel, type FileShortcutId, SHORTCUTS, type ShortcutId } from "#/lib/shortcuts.ts";
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
import {
	isShortcut,
	keyHint,
	shortcutFor,
	useBindings,
	useMacLabels,
	useShortcutHint,
	useShortcutLabel,
} from "#/lib/use-shortcuts.ts";
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

/**
 * The loaded song's beat grid and cues, edited on the deck above the player bar: grid controls on
 * the left, under the sidebar; the waveform and hot cue pads on the right.
 */
export function DeckEditor({ track }: { track: Track }) {
	const analysis = useTrackAnalysis(track.id);
	const cues = useTrackCues(track.id);
	if (analysis.isPending || cues.isPending) {
		return null;
	}
	return analysis.data ? (
		<Editor key={track.id} track={track} analysis={analysis.data} savedCues={cues.data ?? []} />
	) : (
		<NotAnalyzed trackId={track.id} />
	);
}

/** A song without a kept waveform yet: analyse just this one, then the deck shows it. */
function NotAnalyzed({ trackId }: { trackId: number }) {
	const analyze = useAnalyze();
	const { running } = useAnalysisProgress();
	const failed = analyze.isError || (analyze.data !== undefined && analyze.data.failed > 0);
	return (
		<div className={cn(DECK_COLUMNS, "dark h-14 items-center bg-neutral-950 text-neutral-300")}>
			<div />
			<div className="flex min-w-0 items-center gap-3 pr-4 text-sm">
				<AudioWaveform className="size-4 shrink-0 text-neutral-500" />
				<span className="truncate">
					{failed
						? analyze.isError
							? String(analyze.error)
							: "The audio could not be analyzed."
						: "Analyze the song to see its waveform and edit its beat grid."}
				</span>
				<Button
					size="sm"
					variant="secondary"
					className="ml-auto shrink-0"
					disabled={running}
					onClick={() => analyze.mutate([trackId])}
				>
					{analyze.isPending ? "Analyzing…" : running ? "Library analysis running…" : "Analyze now"}
				</Button>
			</div>
		</div>
	);
}

/** The player's position: the deck always edits the loaded song. */
function useDeckPosition() {
	const player = usePlayer();
	const revision = usePlayerTime();
	return {
		playing: player.playing,
		position: player.getTime,
		moveTo: player.seek,
		revision,
		toggle: player.toggle,
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
	// Kept from song to song (and between launches), like the deck's settings on a CDJ.
	const [zoom, setZoom] = useStoredNumber("grid-editor.zoom", ZOOM_DEFAULT);
	const [snapOn, setSnapOn] = useStoredFlag("grid-editor.snap", true);
	const [metronomeOn, setMetronomeOn] = useStoredFlag("grid-editor.metronome", false);
	const [wholeTaps, setWholeTaps] = useStoredFlag("grid-editor.whole-bpm-taps", true);
	// Per device: the delay depends on what you listen on (Bluetooth headphones add a lot).
	const [clickEarlierMs, setClickEarlierMs] = useStoredNumber(
		"grid-editor.metronome-earlier-ms",
		0,
	);
	const taps = useTaps();
	const pos = useDeckPosition();
	const armed = useArmed();
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
	const actions: DeckActions = {
		start: () => setCues((cs) => setStart(cs, here())),
		downbeat: () => setGrid((g) => downbeatAt(g, pos.position())),
		tap,
		roundBpm: round,
		metronome: () => setMetronomeOn((on) => !on),
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
		...padKeys(pad, (slot) => setCues((cs) => cs.filter((c) => c.slot !== slot))),
	};
	useGridKeys(actions, undoing, armed);

	const padActions = {
		onSet: (slot: number) => setCues((cs) => setHot(cs, slot, here())),
		onJump: pos.moveTo,
		onChange: (slot: number, patch: Partial<Cue>) =>
			setCues((cs) => cs.map((c) => (c.slot === slot ? { ...c, ...patch } : c))),
		onDelete: (slot: number) => setCues((cs) => cs.filter((c) => c.slot !== slot)),
	};
	const setGridBpm = (bpm: number) => setGrid((g) => setBpm(g, bpm, pos.position()));

	return (
		<>
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
						title="Back to the grid and cues the song had when it was loaded. Undo brings the edits back."
						onClick={() => replace(opened)}
					>
						<RotateCcw /> Revert grid and cues
					</StatusButton>
				)}
			</StatusPortal>
			<section
				aria-label="Beat grid and cues"
				data-deck
				className={cn(
					DECK_COLUMNS,
					"dark relative bg-neutral-950 text-neutral-200",
					// Lit after a click in the deck, while ⌘Z undoes grid edits rather than file changes.
					"after:pointer-events-none after:absolute after:inset-0 after:ring-1 after:ring-inset after:transition-colors",
					armed ? "after:ring-primary/60" : "after:ring-transparent",
				)}
			>
				<DeckControls
					armed={armed}
					clock={
						<Clock
							grid={grid}
							position={pos.position}
							running={pos.playing}
							revision={pos.revision}
						/>
					}
					startAt={startOf(cues)?.start ?? null}
					help={<ShortcutHelp open={help} onOpenChange={setHelp} />}
					tempo={
						<>
							<BpmField grid={grid} onBpm={setGridBpm} />
							<TapButton
								tapping={taps.tapping}
								count={taps.count}
								reading={taps.reading}
								whole={wholeTaps}
								onTap={tap}
							/>
						</>
					}
					downbeat={
						<DownbeatButton onDownbeat={() => setGrid((g) => downbeatAt(g, pos.position()))}>
							<GridControls
								grid={grid}
								wholeTaps={wholeTaps}
								onWholeTaps={setWholeTaps}
								clickEarlierMs={clickEarlierMs}
								onClickEarlierMs={setClickEarlierMs}
								onBpm={setGridBpm}
								onRound={round}
								onShiftBar={(n) => setGrid((g) => shiftBar(g, n))}
							/>
						</DownbeatButton>
					}
					onNudge={(seconds) => setGrid((g) => nudge(g, seconds), "nudge")}
					onCue={() => setCues((cs) => (startOf(cs) ? clearStart(cs) : setStart(cs, here())))}
					onStep={step}
				/>
				<div className="min-w-0 space-y-2 pt-0 pr-4 pb-2.5">
					<div className="relative">
						<WaveformDetail
							analysis={draft}
							position={pos.position}
							running={pos.playing}
							window={zoom}
							onZoom={setZoom}
							cues={cues}
							onScrub={pos.moveTo}
							className="h-32 bg-transparent"
						/>
						<WaveformCorner
							zoom={zoom}
							onZoom={setZoom}
							snapOn={snapOn}
							onSnap={setSnapOn}
							metronomeOn={metronomeOn}
							onMetronome={setMetronomeOn}
						/>
					</div>
					<PadStrip cues={cues} actions={padActions} />
				</div>
			</section>
		</>
	);
}

/**
 * Whether the deck takes the keyboard: from a click or focus in it (or a menu it opened) until a
 * click elsewhere or Escape. So Space,
 * arrows and letters still mean what they always do in the lists until you start editing.
 */
function useArmed(): boolean {
	const [armed, setArmed] = useState(false);
	useEffect(() => {
		const inside = (target: EventTarget | null) =>
			target instanceof Element && target.closest("[data-deck], [data-deck-popup]") !== null;
		const onPointer = (e: PointerEvent) => setArmed(inside(e.target));
		const onFocus = (e: FocusEvent) => {
			if (inside(e.target)) {
				setArmed(true);
			}
		};
		const onKey = (e: globalThis.KeyboardEvent) => {
			if (e.key === "Escape" && !typingKey(e)) {
				setArmed(false);
			}
		};
		window.addEventListener("pointerdown", onPointer, true);
		window.addEventListener("focusin", onFocus);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", onPointer, true);
			window.removeEventListener("focusin", onFocus);
			window.removeEventListener("keydown", onKey);
		};
	}, []);
	return armed;
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

/** The deck's bindable actions (see `SHORTCUTS`). */
type DeckShortcutId = Exclude<
	ShortcutId,
	| FileShortcutId
	| "undo"
	| "redo"
	| "save"
	| "play"
	| "palette"
	| "pageSearch"
	| "sidebar"
	| "prevSong"
	| "nextSong"
>;

/** What each deck key does; ⌥ held asks for a finer step. Save is ⌘S, fixed. */
type DeckActions = Record<DeckShortcutId, (alt: boolean) => void> & { save: () => void };

/** Undo and redo of the editor's own edits. */
interface Undoing {
	undo: () => void;
	redo: () => void;
	canUndo: boolean;
	canRedo: boolean;
}

/** The sixteen pad keys: 1–8 set or jump, ⇧1–8 clear (by default). */
function padKeys(
	press: (slot: number) => void,
	clear: (slot: number) => void,
): Pick<
	DeckActions,
	`pad${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}` | `clearPad${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`
> {
	return {
		pad1: () => press(0),
		pad2: () => press(1),
		pad3: () => press(2),
		pad4: () => press(3),
		pad5: () => press(4),
		pad6: () => press(5),
		pad7: () => press(6),
		pad8: () => press(7),
		clearPad1: () => clear(0),
		clearPad2: () => clear(1),
		clearPad3: () => clear(2),
		clearPad4: () => clear(3),
		clearPad5: () => clear(4),
		clearPad6: () => clear(5),
		clearPad7: () => clear(6),
		clearPad8: () => clear(7),
	};
}

/** Whether a key press is the undo or the redo shortcut. */
function undoOrRedo(e: KeyboardEvent): "undo" | "redo" | null {
	if (isShortcut(e, "undo")) {
		return "undo";
	}
	return isShortcut(e, "redo") ? "redo" : null;
}

/** The deck action a key press asks for, ready to run, or null. */
function deckShortcut(
	e: KeyboardEvent,
	actions: DeckActions,
): { run: (alt: boolean) => void; alt: boolean } | null {
	const found = shortcutFor(e, "deck");
	return found ? { run: actions[found.id as DeckShortcutId], alt: found.alt } : null;
}

/**
 * Runs the editor's keyboard shortcuts from anywhere in the app while the deck is shown, except
 * where the key is taken (typing, a dialog, a focused list). Undo and redo are the exception:
 * they go to the grid only after a click in the deck (see `useArmed`), else to the app's undo.
 */
function useGridKeys(actions: DeckActions, undoing: Undoing, armed: boolean) {
	const latest = useRef(actions);
	latest.current = actions;
	const latestUndoing = useRef(undoing);
	latestUndoing.current = undoing;
	const showing = useRef(false);
	showing.current = armed;
	useEffect(() => {
		const onKey = (e: globalThis.KeyboardEvent) => {
			// ⌘S saves even from a field; everything else is the whole app's, unless typing or the
			// focused list uses the key itself.
			if (isShortcut(e, "save")) {
				e.preventDefault();
				latest.current.save();
				return;
			}
			const found = keyTakenElsewhere(e) ? null : deckShortcut(e, latest.current);
			if (found) {
				e.preventDefault();
				found.run(found.alt);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	// ⌘Z undoes the editor's edits before the app-wide undo (of file changes) sees it; with no
	// edit to undo here it is left to that.
	useEffect(() => {
		const onKey = (e: globalThis.KeyboardEvent) => {
			const name = undoOrRedo(e);
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

/** The keyboard button, and the cheat sheet it opens (also on its key, ? at first). */
function ShortcutHelp({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const bindings = useBindings();
	const mac = useMacLabels();
	const navigate = useNavigate();
	const title = useShortcutHint("help", "Keyboard shortcuts");
	const deck = SHORTCUTS.filter((d) => d.scope === "deck" && !/^(clear)?[pP]ad\d$/.test(d.id));
	const groups = [...new Set(deck.map((d) => d.group))];
	const keysOf = (id: ShortcutId) =>
		(bindings.get(id) ?? []).map((k) => chordLabel(k, mac)).join(" ") || "–";
	const pads = (prefix: "pad" | "clearPad") =>
		[1, 2, 3, 4, 5, 6, 7, 8]
			.map((n) => (bindings.get(`${prefix}${n}` as ShortcutId) ?? [])[0])
			.map((k) => (k ? chordLabel(k, mac) : "–"))
			.join(" ");
	return (
		<Popover.Root open={open} onOpenChange={onOpenChange}>
			<Popover.Trigger
				aria-label="Keyboard shortcuts"
				title={title}
				className="grid size-7 place-items-center rounded-md text-neutral-400 outline-none transition-colors hover:bg-white/10 hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-ring/60 data-[popup-open]:bg-white/10 data-[popup-open]:text-neutral-50 [&_svg]:size-4"
			>
				<Keyboard />
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner sideOffset={6} align="end" className="z-50">
					<Popover.Popup
						data-deck-popup
						className="w-[34rem] rounded-lg border bg-popover p-4 text-popover-foreground text-sm shadow-lg outline-none"
					>
						<div className="grid grid-cols-2 gap-x-6 gap-y-4">
							{groups.map((group) => (
								<section key={group} className="space-y-1.5">
									<h3 className="font-medium text-muted-foreground text-xs">{group}</h3>
									<dl className="space-y-1">
										{deck
											.filter((d) => d.group === group)
											.map((d) => (
												<HelpRow key={d.id} what={d.label} keys={keysOf(d.id)} />
											))}
										{group === "Cues" && (
											<>
												<HelpRow what="Hot cues A–H" keys={pads("pad")} />
												<HelpRow what="Clear hot cues A–H" keys={pads("clearPad")} />
											</>
										)}
									</dl>
								</section>
							))}
						</div>
						<div className="mt-4 flex items-center justify-between border-t pt-3 text-muted-foreground text-xs">
							<span>{keyLabel("⌥ with the arrows takes finer steps.")}</span>
							<Button
								size="xs"
								variant="outline"
								onClick={() => {
									onOpenChange(false);
									void navigate({ to: "/settings", search: { section: "shortcuts" } });
								}}
							>
								Change keys
							</Button>
						</div>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

function HelpRow({ what, keys }: { what: string; keys: string }) {
	return (
		<div className="flex items-baseline justify-between gap-3">
			<dt className="text-xs">{what}</dt>
			<dd>
				<kbd className="whitespace-nowrap rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
					{keys}
				</kbd>
			</dd>
		</div>
	);
}

/** Makes the playhead beat 1 of a bar; its other half opens the rest of the beat grid settings. */
function DownbeatButton({ onDownbeat, children }: { onDownbeat: () => void; children: ReactNode }) {
	const title = useShortcutHint("downbeat", "Make the playhead beat 1 of a bar");
	const half =
		"flex h-7 items-center gap-1.5 whitespace-nowrap text-neutral-300 text-xs outline-none transition-colors hover:bg-white/10 hover:text-neutral-50 focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5";
	return (
		<div className="flex items-center rounded-md bg-white/5">
			<button
				type="button"
				title={title}
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
						<Popover.Popup
							data-deck-popup
							className="w-80 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg outline-none"
						>
							{children}
						</Popover.Popup>
					</Popover.Positioner>
				</Popover.Portal>
			</Popover.Root>
		</div>
	);
}

/** A round button on the deck, lit when `on`. */
const DECK_TOGGLE =
	"grid size-7 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5";
const deckToggle = (on: boolean) =>
	cn(
		DECK_TOGGLE,
		on ? "bg-primary/20 text-primary" : "text-neutral-400 hover:bg-white/10 hover:text-neutral-100",
	);

/**
 * The grid editor's controls, in the column under the sidebar: setting the start and stepping
 * by beats, where the playhead is, the tempo, and beat 1 with the grid's nudge. Play is the
 * player bar's, right below.
 */
function DeckControls({
	armed,
	clock,
	startAt,
	help,
	tempo,
	downbeat,
	onNudge,
	onCue,
	onStep,
}: {
	armed: boolean;
	/** Where the playhead is, as a time and a bar and beat. */
	clock: ReactNode;
	/** Where the song starts (rekordbox's main cue), or null for its first beat. */
	startAt: number | null;
	/** The keyboard shortcuts button. */
	help: ReactNode;
	/** The BPM field and tap button. */
	tempo: ReactNode;
	/** Beat 1 at the playhead, and the rest of the grid's settings. */
	downbeat: ReactNode;
	/** Moves the whole grid by `seconds` (negative: earlier). */
	onNudge: (seconds: number) => void;
	/** Sets the start (main) cue at the playhead, or clears it when set. */
	onCue: () => void;
	onStep: (beats: number) => void;
}) {
	const cueKey = keyHint(useShortcutLabel("start"));
	return (
		<div className="flex min-w-0 flex-col gap-2 py-2.5 pr-3 pl-3">
			<div className="flex items-center gap-0.5">
				{/* The CDJ's CUE button: where the song starts. Lit while set; pressing it then clears it. */}
				<button
					type="button"
					onClick={onCue}
					aria-pressed={startAt !== null}
					title={
						startAt === null
							? `The song starts at its first beat. Click to start it at the playhead${cueKey}.`
							: `The song starts at ${stamp(startAt)}. Click to start it at its first beat again.`
					}
					aria-label={startAt === null ? "Set the start at the playhead" : "Clear the start"}
					className="mr-1.5 grid size-8 shrink-0 place-items-center rounded-full border-2 font-semibold text-[9px] tracking-wide outline-none transition-colors hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring/60"
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
				<DeckButton label="On one beat" onClick={() => onStep(1)}>
					<ChevronRight />
				</DeckButton>
				<DeckButton label="On one bar" onClick={() => onStep(4)}>
					<ChevronsRight />
				</DeckButton>
			</div>
			{clock}
			<div className="flex min-w-0 items-center gap-1.5">{tempo}</div>
			<div className="flex min-w-0 items-center gap-1.5">
				{downbeat}
				<NudgeButtons onNudge={onNudge} />
				<div
					className={cn("ml-auto rounded-md", armed && "[&_button]:text-primary")}
					title={
						armed
							? keyLabel("⌘Z undoes grid edits until you click elsewhere or press Esc.")
							: undefined
					}
				>
					{help}
				</div>
			</div>
		</div>
	);
}

/** Moves the whole grid earlier or later: 10 ms a press, 1 ms with ⌥, as ← and → do. */
function NudgeButtons({ onNudge }: { onNudge: (seconds: number) => void }) {
	const half =
		"grid h-7 w-7 place-items-center text-neutral-300 outline-none transition-colors hover:bg-white/10 hover:text-neutral-50 focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5";
	return (
		<fieldset className="flex items-center rounded-md bg-white/5" aria-label="Move the grid">
			<button
				type="button"
				aria-label="Move the grid earlier"
				title={keyLabel("Move the grid 10 ms earlier (←; ⌥ for 1 ms)")}
				onClick={(e) => onNudge(e.altKey ? -FINE : -COARSE)}
				className={cn(half, "rounded-l-md")}
			>
				<ArrowLeft />
			</button>
			<button
				type="button"
				aria-label="Move the grid later"
				title={keyLabel("Move the grid 10 ms later (→; ⌥ for 1 ms)")}
				onClick={(e) => onNudge(e.altKey ? FINE : COARSE)}
				className={cn(half, "rounded-r-md border-white/10 border-l")}
			>
				<ArrowRight />
			</button>
		</fieldset>
	);
}

/** Snap and the metronome, then the zoom presets, small in the waveform's top corner. */
function WaveformCorner({
	zoom,
	onZoom,
	snapOn,
	onSnap,
	metronomeOn,
	onMetronome,
}: {
	zoom: number;
	onZoom: (z: number) => void;
	snapOn: boolean;
	onSnap: (on: boolean) => void;
	metronomeOn: boolean;
	onMetronome: (on: boolean) => void;
}) {
	const snapKey = keyHint(useShortcutLabel("snap"));
	const metronomeKey = keyHint(useShortcutLabel("metronome"));
	return (
		<div className="absolute top-1.5 right-1.5 flex items-center gap-1 rounded-md bg-neutral-950/80 p-0.5 backdrop-blur-sm">
			<button
				type="button"
				aria-pressed={snapOn}
				aria-label="Snap to beat"
				title={`Snap to beat: ${snapOn ? "on" : "off"}${snapKey}`}
				onClick={() => onSnap(!snapOn)}
				className={deckToggle(snapOn)}
			>
				<Magnet />
			</button>
			<button
				type="button"
				aria-pressed={metronomeOn}
				aria-label="Metronome"
				title={
					metronomeOn
						? `Metronome: on. Clicks on every beat of the grid while the song plays${metronomeKey}.`
						: `Metronome: off. Click to hear the grid's beats while the song plays${metronomeKey}.`
				}
				onClick={() => onMetronome(!metronomeOn)}
				className={deckToggle(metronomeOn)}
			>
				<Drum />
			</button>
			<span aria-hidden="true" className="h-4 w-px bg-white/10" />
			<ZoomPresets zoom={zoom} onZoom={onZoom} />
		</div>
	);
}

/** The zoom presets; pinching the waveform and + − zoom too. */
function ZoomPresets({ zoom, onZoom }: { zoom: number; onZoom: (z: number) => void }) {
	return (
		<fieldset
			className="flex"
			aria-label="Zoom"
			title={`Showing ${zoomLabel(zoom)}. Pinch the waveform or press + and − to zoom, 0 to reset.`}
		>
			{!ZOOM_PRESETS.some((z) => Math.abs(z - zoom) < 1e-6) && (
				<span className="rounded bg-white/15 px-1.5 py-0.5 text-[11px] text-neutral-50 tabular-nums">
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
						"rounded px-1.5 py-0.5 text-[11px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
						Math.abs(z - zoom) < 1e-6
							? "bg-white/15 text-neutral-50"
							: "text-neutral-400 hover:text-neutral-100",
					)}
				>
					{z * 2}s
				</button>
			))}
		</fieldset>
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
	const tapKey = keyHint(useShortcutLabel("tap"));
	const shown = reading && (whole ? String(Math.round(reading.bpm)) : formatBpm(reading.bpm));
	return (
		<button
			type="button"
			onClick={onTap}
			aria-pressed={tapping}
			title={`Tap along to the beat${tapKey}. The grid follows from the fourth tap${whole ? ", rounded to a whole BPM" : ""}; stop for two seconds to start over.`}
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
	onShiftBar,
}: {
	grid: Grid;
	wholeTaps: boolean;
	onWholeTaps: (on: boolean) => void;
	clickEarlierMs: number;
	onClickEarlierMs: (ms: number) => void;
	onBpm: (bpm: number) => void;
	onRound: () => void;
	onShiftBar: (beats: number) => void;
}) {
	const roundTitle = useShortcutHint(
		"roundBpm",
		"Round the tempo to a whole BPM, keeping the beat at the playhead",
	);
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
							title={roundTitle}
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
		</div>
	);
}
