import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AudioWaveform,
	ChevronLeft,
	ChevronRight,
	ChevronsLeft,
	ChevronsRight,
	Crosshair,
	Magnet,
	Pause,
	Play,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { CuePoints, HotCuePads } from "#/components/cue-pads.tsx";
import { EmptyState, ErrorLine, Section } from "#/components/page.tsx";
import { SettingRow, SettingRows } from "#/components/setting-row.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { WaveformDetail, WaveformSeek } from "#/components/waveform.tsx";
import { usePlayer } from "#/context/player-context.ts";
import { setBeatGrid, setTrackCues, type Track, type TrackAnalysis, trackCues } from "#/lib/api.ts";
import {
	downbeatAt,
	type Grid,
	gridOf,
	nudge,
	sameGrid,
	setBpm,
	shiftBar,
	tapBpm,
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
} from "#/lib/cues.ts";
import { formatBpm } from "#/lib/musical-key.ts";
import { useTracks } from "#/lib/queries.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { TRACK_ANALYSIS_KEY, useTrackAnalysis } from "#/lib/use-track-analysis.ts";
import { cn } from "#/lib/utils.ts";

/** Seconds either side of the playhead, as on a CDJ's zoom. */
const ZOOMS = [2, 4, 8] as const;
/** Nudge steps: arrows move 10 ms, with ⌥ 1 ms. */
const COARSE = 0.01;
const FINE = 0.001;

const cuesKey = (trackId: number) => ["track-cues", trackId] as const;

/** Beat grid and cues for one song. Opens from the song's right-click menu or the player. */
export function GridEditorPanel({ trackId }: { trackId: number }) {
	const tracks = useTracks();
	const analysis = useTrackAnalysis(trackId);
	const cues = useQuery({ queryKey: cuesKey(trackId), queryFn: () => trackCues(trackId) });
	const track = tracks.data?.find((t) => t.id === trackId);
	if (analysis.isPending || cues.isPending || !track) {
		return null;
	}
	if (!analysis.data) {
		return (
			<EmptyState icon={<AudioWaveform />} title="Not analyzed yet">
				Analyze the song to get a beat grid and waveform to edit.
			</EmptyState>
		);
	}
	return (
		<Editor key={trackId} track={track} analysis={analysis.data} savedCues={cues.data ?? []} />
	);
}

/** Where the editor looks: the player's position when it plays this song, else its own. */
function usePosition(track: Track) {
	const player = usePlayer();
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
		revision: live ? player.time : cursor,
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

/**
 * The shortcut a key press means: `pad1`–`pad8` for the number keys, else the key itself
 * (M drops a memory cue, D a downbeat, T taps, arrows move the grid). `null` while typing.
 */
function shortcut(e: KeyboardEvent): string | null {
	if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) {
		return null;
	}
	const pad = /^Digit([1-8])$/.exec(e.code);
	return pad ? `pad${pad[1]}` : e.key.toLowerCase();
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
	const [grid, setGrid] = useState<Grid>(savedGrid);
	const [cues, setCues] = useState<readonly Cue[]>(savedCues);
	const [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(4);
	const [snapOn, setSnapOn] = useState(true);
	const [taps, setTaps] = useState<number[]>([]);
	const pos = usePosition(track);
	const save = useSave(track.id);
	const draft = withGrid(analysis, grid);
	const gridDirty = !sameGrid(grid, savedGrid);
	const cuesDirty = !sameCues(cues, savedCues);
	const period = grid.bpm ? 60 / grid.bpm : 0.5;
	const here = () => (snapOn ? snap(grid, pos.position()) : pos.position());

	const tap = () => {
		const now = performance.now();
		// A pause of two seconds starts a new run of taps.
		const run = taps.length > 0 && now - (taps.at(-1) ?? 0) < 2000 ? [...taps, now] : [now];
		setTaps(run);
		const bpm = tapBpm(run);
		if (bpm !== null) {
			setGrid((g) => setBpm(g, bpm, pos.position()));
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
	const keys: Record<string, (alt: boolean) => void> = {
		arrowleft: (alt) => setGrid((g) => nudge(g, alt ? -FINE : -COARSE)),
		arrowright: (alt) => setGrid((g) => nudge(g, alt ? FINE : COARSE)),
		" ": () => pos.toggle(),
		d: () => setGrid((g) => downbeatAt(g, pos.position())),
		t: tap,
		m: () => setCues((cs) => addMemory(cs, here())),
		c: () => setCues((cs) => setStart(cs, here())),
		...Object.fromEntries(
			Array.from({ length: 8 }, (_, i) => [`pad${i + 1}`, () => pad(i)] as const),
		),
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: shortcuts for the whole editor; every one is also a button
		<div
			className="space-y-6 pb-8"
			onKeyDown={(e) => {
				const k = shortcut(e);
				const run = k === null ? undefined : keys[k];
				if (run) {
					e.preventDefault();
					run(e.altKey);
				}
			}}
		>
			<Header track={track} grid={grid} cues={cues} dirty={gridDirty || cuesDirty}>
				<Button
					variant="ghost"
					disabled={!(gridDirty || cuesDirty) || save.isPending}
					onClick={() => {
						setGrid(savedGrid);
						setCues(savedCues);
					}}
				>
					Revert
				</Button>
				<Button
					disabled={!(gridDirty || cuesDirty) || save.isPending}
					onClick={() =>
						save.mutate({ grid: gridDirty ? grid : null, cues: cuesDirty ? cues : null })
					}
				>
					{save.isPending ? "Saving…" : "Save"}
				</Button>
			</Header>
			{save.isError && <ErrorLine>{String(save.error)}</ErrorLine>}

			<Deck>
				<WaveformDetail
					analysis={draft}
					position={pos.position}
					running={pos.playing}
					revision={`${pos.revision}`}
					window={zoom}
					cues={cues}
					onScrub={pos.moveTo}
					className="h-44 rounded-t-lg bg-transparent"
				/>
				<div className="border-white/5 border-t px-3 pt-2">
					<WaveformSeek
						analysis={draft}
						time={pos.position()}
						duration={analysis.duration}
						disabled={false}
						cues={cues}
						onSeek={pos.moveTo}
						className="h-7"
					/>
				</div>
				<Transport
					grid={grid}
					playing={pos.playing}
					time={pos.position()}
					zoom={zoom}
					snapOn={snapOn}
					onSnap={setSnapOn}
					onZoom={setZoom}
					onToggle={pos.toggle}
					onCue={() => setCues((cs) => setStart(cs, here()))}
					onStep={(beats) => pos.moveTo(Math.max(0, pos.position() + beats * period))}
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

			<div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<GridControls
					grid={grid}
					tapping={taps.length > 0}
					onBpm={(bpm) => setGrid((g) => setBpm(g, bpm, pos.position()))}
					onTap={tap}
					onNudge={(s) => setGrid((g) => nudge(g, s))}
					onDownbeat={() => setGrid((g) => downbeatAt(g, pos.position()))}
					onShiftBar={(n) => setGrid((g) => shiftBar(g, n))}
				/>
				<CuePoints
					cues={cues}
					onSetStart={() => setCues((cs) => setStart(cs, here()))}
					onClearStart={() => setCues(clearStart)}
					onAdd={() => setCues((cs) => addMemory(cs, here()))}
					onJump={pos.moveTo}
					onRename={(cue, name) => setCues((cs) => cs.map((c) => (c === cue ? { ...c, name } : c)))}
					onDelete={(cue) => setCues((cs) => cs.filter((c) => c !== cue))}
				/>
			</div>
		</div>
	);
}

function Header({
	track,
	grid,
	cues,
	dirty,
	children,
}: {
	track: Track;
	grid: Grid;
	cues: readonly Cue[];
	dirty: boolean;
	children: ReactNode;
}) {
	const hot = cues.filter((c) => c.slot !== null).length;
	const memory = cues.length - hot;
	let state: ReactNode = null;
	if (dirty) {
		state = <span className="text-warning">Not saved</span>;
	} else if (track.edited.grid) {
		state = (
			<span
				className="text-primary"
				title="Re-analysis keeps this grid unless the BPM and key drawer says to replace edits"
			>
				Grid edited by you
			</span>
		);
	}
	return (
		<div className="flex items-end justify-between gap-4">
			<div className="min-w-0 space-y-1">
				<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
					<AudioWaveform className="size-3.5" /> Grid and cues
				</div>
				<h2 className={cn("truncate", typeScale.panelTitle)}>{track.title}</h2>
				<p className="flex flex-wrap gap-x-3 text-muted-foreground text-xs tabular-nums">
					<span>{track.artist}</span>
					<span>{grid.bpm ? `${formatBpm(grid.bpm)} BPM` : "No tempo"}</span>
					<span>
						{hot} hot, {memory} memory
					</span>
					{state}
				</p>
			</div>
			<div className="flex shrink-0 gap-2">{children}</div>
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

function Transport({
	grid,
	playing,
	time,
	zoom,
	snapOn,
	onSnap,
	onZoom,
	onToggle,
	onCue,
	onStep,
}: {
	grid: Grid;
	playing: boolean;
	time: number;
	zoom: number;
	snapOn: boolean;
	onSnap: (on: boolean) => void;
	onZoom: (z: (typeof ZOOMS)[number]) => void;
	onToggle: () => void;
	/** Sets the start (main) cue at the playhead. */
	onCue: () => void;
	onStep: (beats: number) => void;
}) {
	const at = barBeat(grid, time);
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
			<div className="flex items-center gap-0.5">
				{/* The CDJ's CUE button: sets where the song starts. */}
				<button
					type="button"
					onClick={onCue}
					title="Start the song here (C)"
					aria-label="Set the start cue at the playhead"
					className="mr-2 grid size-9 place-items-center rounded-full border-2 font-semibold text-[10px] tracking-wide outline-none transition-colors hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-ring/60"
					style={{ borderColor: START_COLOR, color: START_COLOR }}
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
			<div className="flex items-baseline gap-3 tabular-nums">
				<span className="font-medium text-lg text-neutral-50 tracking-tight">{stamp(time)}</span>
				<span className="text-neutral-400 text-xs" title="Bar and beat by the grid">
					{at ? `Bar ${at.bar}, beat ${at.beat}` : "Before the grid"}
				</span>
			</div>
			<div className="ml-auto flex items-center gap-3">
				<button
					type="button"
					aria-pressed={snapOn}
					title="Snap new cues to the nearest beat"
					onClick={() => onSnap(!snapOn)}
					className={cn(
						"flex items-center gap-1.5 rounded-md px-2 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5",
						snapOn ? "bg-primary/20 text-primary" : "text-neutral-400 hover:text-neutral-100",
					)}
				>
					<Magnet /> Snap to beat
				</button>
				<fieldset className="flex rounded-md bg-white/5 p-0.5" aria-label="Zoom">
					{ZOOMS.map((z) => (
						<button
							key={z}
							type="button"
							aria-pressed={z === zoom}
							title={`Show ${z * 2} seconds`}
							onClick={() => onZoom(z)}
							className={cn(
								"rounded px-2 py-0.5 text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
								z === zoom
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
		<div className="flex items-baseline gap-1.5">
			<Input
				value={text}
				inputMode="decimal"
				aria-label="BPM"
				className="h-7 w-20 text-right font-medium tabular-nums"
				onChange={(e) => setText(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => e.key === "Enter" && commit()}
			/>
			<span className="text-muted-foreground text-xs">BPM</span>
		</div>
	);
}

function GridControls({
	grid,
	tapping,
	onBpm,
	onTap,
	onNudge,
	onDownbeat,
	onShiftBar,
}: {
	grid: Grid;
	tapping: boolean;
	onBpm: (bpm: number) => void;
	onTap: () => void;
	onNudge: (seconds: number) => void;
	onDownbeat: () => void;
	onShiftBar: (beats: number) => void;
}) {
	return (
		<Section title="Beat grid">
			<SettingRows>
				<SettingRow label="Tempo">
					<BpmField grid={grid} onBpm={onBpm} />
					<Button
						size="sm"
						variant="outline"
						disabled={!grid.bpm}
						title="Half the tempo"
						onClick={() => grid.bpm && onBpm(grid.bpm / 2)}
					>
						½×
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={!grid.bpm}
						title="Double the tempo"
						onClick={() => grid.bpm && onBpm(grid.bpm * 2)}
					>
						2×
					</Button>
					<Button
						size="sm"
						variant={tapping ? "secondary" : "outline"}
						title="Tap along to the beat (T)"
						onClick={onTap}
					>
						Tap
					</Button>
				</SettingRow>
				<SettingRow label="Move" title="10 ms a press, 1 ms with ⌥. Arrow keys do the same.">
					<Button size="sm" variant="outline" onClick={(e) => onNudge(e.altKey ? -FINE : -COARSE)}>
						<ChevronLeft /> Earlier
					</Button>
					<Button size="sm" variant="outline" onClick={(e) => onNudge(e.altKey ? FINE : COARSE)}>
						Later <ChevronRight />
					</Button>
				</SettingRow>
				<SettingRow label="Downbeat">
					<Button
						size="sm"
						variant="outline"
						title="Put the first beat of a bar at the playhead (D)"
						onClick={onDownbeat}
					>
						<Crosshair /> Set here
					</Button>
					<Button
						size="icon-sm"
						variant="outline"
						aria-label="Downbeat a beat earlier"
						title="A beat earlier"
						onClick={() => onShiftBar(-1)}
					>
						<ChevronLeft />
					</Button>
					<Button
						size="icon-sm"
						variant="outline"
						aria-label="Downbeat a beat later"
						title="A beat later"
						onClick={() => onShiftBar(1)}
					>
						<ChevronRight />
					</Button>
				</SettingRow>
			</SettingRows>
		</Section>
	);
}
