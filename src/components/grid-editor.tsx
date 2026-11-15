import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	AudioWaveform,
	ChevronLeft,
	ChevronRight,
	ChevronsLeft,
	ChevronsRight,
	Pause,
	Play,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorLine, SectionHeading } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { WaveformDetail, WaveformSeek } from "#/components/waveform.tsx";
import { usePlayer } from "#/context/player-context.ts";
import { setBeatGrid, type Track, type TrackAnalysis } from "#/lib/api.ts";
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
import { formatBpm } from "#/lib/musical-key.ts";
import { useTracks } from "#/lib/queries.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { TRACK_ANALYSIS_KEY, useTrackAnalysis } from "#/lib/use-track-analysis.ts";
import { cn } from "#/lib/utils.ts";

const ZOOMS = [2, 4, 8] as const;
/** Nudge steps: arrows move 10 ms, with ⌥ 1 ms. */
const COARSE = 0.01;
const FINE = 0.001;

function stamp(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds - m * 60;
	return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

/** Edits one song's beat grid. Opens from the song's right-click menu or the player. */
export function GridEditorPanel({ trackId }: { trackId: number }) {
	const tracks = useTracks();
	const analysis = useTrackAnalysis(trackId);
	const track = tracks.data?.find((t) => t.id === trackId);
	if (analysis.isPending || !track) {
		return null;
	}
	if (!analysis.data) {
		return (
			<EmptyState icon={<AudioWaveform />} title="Not analyzed yet">
				Analyze the song to get a beat grid to edit.
			</EmptyState>
		);
	}
	return <GridEditor key={trackId} track={track} analysis={analysis.data} />;
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
		live,
		playing: live && player.playing,
		position,
		moveTo,
		revision: live ? player.time : cursor,
		toggle: () => (live ? player.toggle() : player.play([track], 0)),
	};
}

function useSaveGrid(trackId: number) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (grid: Grid) => setBeatGrid(trackId, grid),
		onSuccess: async (kept) => {
			queryClient.setQueryData([...TRACK_ANALYSIS_KEY, trackId], kept);
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["playlist-tracks"] });
		},
	});
}

function GridEditor({ track, analysis }: { track: Track; analysis: TrackAnalysis }) {
	const saved = gridOf(analysis);
	const [grid, setGrid] = useState<Grid>(saved);
	const [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(4);
	const [taps, setTaps] = useState<number[]>([]);
	const pos = usePosition(track);
	const save = useSaveGrid(track.id);
	const draft = withGrid(analysis, grid);
	const dirty = !sameGrid(grid, saved);
	const period = grid.bpm ? 60 / grid.bpm : 0.5;

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
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.target instanceof HTMLInputElement) {
			return;
		}
		const step = e.altKey ? FINE : COARSE;
		const keys = new Map<string, () => void>([
			["ArrowLeft", () => setGrid((g) => nudge(g, -step))],
			["ArrowRight", () => setGrid((g) => nudge(g, step))],
			[" ", pos.toggle],
			["d", () => setGrid((g) => downbeatAt(g, pos.position()))],
			["t", tap],
		]);
		const run = keys.get(e.key);
		if (run) {
			e.preventDefault();
			run();
		}
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: shortcuts for the whole editor; every one is also a button
		<div className="space-y-6 pb-6 outline-none" onKeyDown={onKeyDown}>
			<Header track={track} grid={grid} dirty={dirty}>
				<Button variant="ghost" disabled={!dirty || save.isPending} onClick={() => setGrid(saved)}>
					Revert
				</Button>
				<Button disabled={!dirty || save.isPending} onClick={() => save.mutate(grid)}>
					{save.isPending ? "Saving…" : "Save grid"}
				</Button>
			</Header>
			{save.isError && <ErrorLine>{String(save.error)}</ErrorLine>}

			<div className="space-y-2">
				<WaveformDetail
					analysis={draft}
					position={pos.position}
					running={pos.playing}
					revision={`${pos.revision}`}
					window={zoom}
					onScrub={pos.moveTo}
					className="h-40 rounded-md"
				/>
				<WaveformSeek
					analysis={draft}
					time={pos.position()}
					duration={analysis.duration}
					disabled={false}
					onSeek={pos.moveTo}
				/>
				<Transport
					playing={pos.playing}
					time={pos.position()}
					zoom={zoom}
					onZoom={setZoom}
					onToggle={pos.toggle}
					onStep={(beats) => pos.moveTo(Math.max(0, pos.position() + beats * period))}
				/>
			</div>

			<div className="grid gap-6 sm:grid-cols-2">
				<Tempo
					grid={grid}
					tapping={taps.length > 0}
					onBpm={(bpm) => setGrid((g) => setBpm(g, bpm, pos.position()))}
					onTap={tap}
				/>
				<Beats
					onNudge={(s) => setGrid((g) => nudge(g, s))}
					onDownbeat={() => setGrid((g) => downbeatAt(g, pos.position()))}
					onShiftBar={(n) => setGrid((g) => shiftBar(g, n))}
				/>
			</div>
		</div>
	);
}

function Header({
	track,
	grid,
	dirty,
	children,
}: {
	track: Track;
	grid: Grid;
	dirty: boolean;
	children: ReactNode;
}) {
	return (
		<div className="flex items-end justify-between gap-4">
			<div className="min-w-0 space-y-1">
				<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
					<AudioWaveform className="size-3.5" /> Beat grid
				</div>
				<h2 className={cn("truncate", typeScale.panelTitle)}>{track.title}</h2>
				<p className="flex flex-wrap gap-x-3 text-muted-foreground text-xs tabular-nums">
					<span>{track.artist}</span>
					<span>{grid.bpm ? `${formatBpm(grid.bpm)} BPM` : "No tempo"}</span>
					{dirty && <span className="text-warning">Not saved</span>}
				</p>
			</div>
			<div className="flex shrink-0 gap-2">{children}</div>
		</div>
	);
}

function Transport({
	playing,
	time,
	zoom,
	onZoom,
	onToggle,
	onStep,
}: {
	playing: boolean;
	time: number;
	zoom: number;
	onZoom: (z: (typeof ZOOMS)[number]) => void;
	onToggle: () => void;
	onStep: (beats: number) => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Button
				size="icon-sm"
				variant="ghost"
				aria-label="Back one bar"
				title="Back one bar"
				onClick={() => onStep(-4)}
			>
				<ChevronsLeft />
			</Button>
			<Button
				size="icon-sm"
				variant="ghost"
				aria-label="Back one beat"
				title="Back one beat"
				onClick={() => onStep(-1)}
			>
				<ChevronLeft />
			</Button>
			<Button
				size="icon-sm"
				aria-label={playing ? "Pause" : "Play"}
				title="Play or pause (Space)"
				onClick={onToggle}
			>
				{playing ? <Pause /> : <Play />}
			</Button>
			<Button
				size="icon-sm"
				variant="ghost"
				aria-label="On one beat"
				title="On one beat"
				onClick={() => onStep(1)}
			>
				<ChevronRight />
			</Button>
			<Button
				size="icon-sm"
				variant="ghost"
				aria-label="On one bar"
				title="On one bar"
				onClick={() => onStep(4)}
			>
				<ChevronsRight />
			</Button>
			<span className="ml-1 font-medium text-sm tabular-nums">{stamp(time)}</span>
			<fieldset className="ml-auto flex items-center gap-1" aria-label="Zoom">
				{ZOOMS.map((z) => (
					<Button
						key={z}
						size="xs"
						variant={z === zoom ? "secondary" : "ghost"}
						aria-pressed={z === zoom}
						onClick={() => onZoom(z)}
					>
						{z * 2} s
					</Button>
				))}
			</fieldset>
		</div>
	);
}

function Tempo({
	grid,
	tapping,
	onBpm,
	onTap,
}: {
	grid: Grid;
	tapping: boolean;
	onBpm: (bpm: number) => void;
	onTap: () => void;
}) {
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
		<section className="space-y-3">
			<SectionHeading title="Tempo" />
			<div className="flex flex-wrap items-center gap-2">
				<div className="flex items-center gap-1.5">
					<Input
						value={text}
						inputMode="decimal"
						aria-label="BPM"
						className="h-8 w-24 text-right tabular-nums"
						onChange={(e) => setText(e.target.value)}
						onBlur={commit}
						onKeyDown={(e) => e.key === "Enter" && commit()}
					/>
					<span className="text-muted-foreground text-xs">BPM</span>
				</div>
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
			</div>
		</section>
	);
}

function Beats({
	onNudge,
	onDownbeat,
	onShiftBar,
}: {
	onNudge: (seconds: number) => void;
	onDownbeat: () => void;
	onShiftBar: (beats: number) => void;
}) {
	return (
		<section className="space-y-3">
			<SectionHeading title="Grid" />
			<div className="flex flex-wrap items-center gap-2">
				<Row label="Move">
					<Button
						size="sm"
						variant="outline"
						title="Earlier by 10 ms (←, with ⌥ 1 ms)"
						onClick={(e) => onNudge(e.altKey ? -FINE : -COARSE)}
					>
						<ChevronLeft /> Earlier
					</Button>
					<Button
						size="sm"
						variant="outline"
						title="Later by 10 ms (→, with ⌥ 1 ms)"
						onClick={(e) => onNudge(e.altKey ? FINE : COARSE)}
					>
						Later <ChevronRight />
					</Button>
				</Row>
				<Row label="Bar start">
					<Button
						size="sm"
						variant="outline"
						aria-label="Bar starts a beat earlier"
						title="Bar starts a beat earlier"
						onClick={() => onShiftBar(-1)}
					>
						<ChevronLeft />
					</Button>
					<Button
						size="sm"
						variant="outline"
						aria-label="Bar starts a beat later"
						title="Bar starts a beat later"
						onClick={() => onShiftBar(1)}
					>
						<ChevronRight />
					</Button>
				</Row>
				<Button
					size="sm"
					variant="outline"
					title="Put the first beat of a bar at the playhead (D)"
					onClick={onDownbeat}
				>
					Downbeat at playhead
				</Button>
			</div>
		</section>
	);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-center gap-1.5">
			<span className="w-16 text-muted-foreground text-xs">{label}</span>
			{children}
		</div>
	);
}
