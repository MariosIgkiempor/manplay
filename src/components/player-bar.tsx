import { AudioWaveform, Pause, Play, SkipBack, SkipForward, Volume2 } from "lucide-react";
import { type CSSProperties, useRef } from "react";
import { AddToPlaylistMenu } from "#/components/add-to-playlist-menu.tsx";
import { AlbumArt } from "#/components/album-art.tsx";
import { ArtistLinks } from "#/components/artist-links.tsx";
import { DeckEditor } from "#/components/grid-editor.tsx";
import { Marquee } from "#/components/marquee.tsx";
import { Button } from "#/components/ui/button.tsx";
import { WaveformSeek } from "#/components/waveform.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { usePlayer, usePlayerTime } from "#/context/player-context.ts";
import { TrackOrderContext } from "#/context/track-order.ts";
import type { Track, TrackAnalysis } from "#/lib/api.ts";
import { type Cue, START_COLOR } from "#/lib/cues.ts";
import { clock } from "#/lib/format.ts";
import { camelot, formatBpm, keyName } from "#/lib/musical-key.ts";
import { DECK_COLUMNS } from "#/lib/page-layout.ts";
import { useTrackCues, useTracks } from "#/lib/queries.ts";
import { useShortcut } from "#/lib/use-shortcuts.ts";
import { useTrackAnalysis } from "#/lib/use-track-analysis.ts";
import { setWaveformShown, useWaveformShown } from "#/lib/use-waveform-shown.ts";
import { cn } from "#/lib/utils.ts";

/** BPM and key of the playing song, the two figures a DJ checks before mixing it. */
function TempoKey({ track }: { track: Track }) {
	const bpm = track.bpm === null ? "" : formatBpm(track.bpm);
	const key = track.key === null ? "" : (camelot(track.key) ?? track.key);
	if (bpm === "" && key === "") {
		return null;
	}
	return (
		<div className="mr-3 flex items-baseline gap-3 text-xs tabular-nums">
			{bpm !== "" && (
				<span data-hint="Tempo">
					<span className="font-semibold text-foreground text-sm">{bpm}</span>{" "}
					<span className="text-muted-foreground">BPM</span>
				</span>
			)}
			{key !== "" && (
				<span
					data-hint={keyName(track.key ?? "") ?? "Key"}
					className="font-semibold text-primary text-sm"
				>
					{key}
				</span>
			)}
		</div>
	);
}

const NO_CUES: readonly Cue[] = [];

/**
 * Cover, title and artist of the playing song, as wide as the sidebar above it. Names too long for
 * it scroll round. The title opens the song and the artist the artist; a right-click offers the
 * same menu as a song in any list, stepping through the queue.
 */
function NowPlaying({ track, error }: { track: Track; error: string | null }) {
	const detail = useDetail();
	const p = usePlayer();
	return (
		<TrackOrderContext.Provider value={p.queue.map((t) => t.id)}>
			<AddToPlaylistMenu tracks={[track]} label={track.title}>
				<div className="flex min-w-0 items-center gap-3">
					<AlbumArt trackId={track.id} className="size-10 shrink-0 rounded-md" />
					<div className="min-w-0 flex-1">
						<Marquee>
							<button
								type="button"
								data-hint={`${track.title} · open song`}
								onClick={() =>
									detail.open({
										kind: "song",
										trackId: track.id,
										list: p.queue.map((t) => t.id),
									})
								}
								className="text-left font-medium text-sm hover:underline"
							>
								{track.title}
							</button>
						</Marquee>
						<Marquee className="text-muted-foreground text-xs">
							{error ?? <ArtistLinks artist={track.artist} />}
						</Marquee>
					</div>
				</div>
			</AddToPlaylistMenu>
		</TrackOrderContext.Provider>
	);
}

/** The playing song as the library has it now, so edits (title, BPM, grid) show at once. */
function useCurrentTrack(): Track | null {
	const { current } = usePlayer();
	const tracks = useTracks();
	if (!current) {
		return null;
	}
	return tracks.data?.find((t) => t.id === current.id) ?? current;
}

/**
 * The song the bar shows: the playing one, or after the queue runs out the one that was playing,
 * so the bar keeps its contents while it slides away.
 */
function useShownTrack(current: Track | null): Track | null {
	const last = useRef<Track | null>(current);
	if (current) {
		last.current = current;
	}
	return current ?? last.current;
}

/**
 * Back to the song's main cue (rekordbox's orange one) and stopped there, as the CUE button on a
 * CDJ does while it plays. Shown only for songs that have one.
 */
function CueButton({ cue }: { cue: Cue }) {
	const p = usePlayer();
	return (
		<button
			type="button"
			aria-label="Back to the cue"
			data-hint="Back to the cue and pause"
			// Round and orange like the CUE button on the deck above and on a CDJ.
			className="mx-0.5 grid size-8 shrink-0 place-items-center rounded-full border-2 font-semibold text-[9px] tracking-wide outline-none transition-colors hover:bg-[color-mix(in_oklch,var(--cue)_15%,transparent)] focus-visible:ring-2 focus-visible:ring-ring/60"
			style={
				{ borderColor: START_COLOR, color: START_COLOR, "--cue": START_COLOR } as CSSProperties
			}
			onClick={() => {
				if (p.playing) {
					p.toggle();
				}
				p.seek(cue.start);
			}}
		>
			CUE
		</button>
	);
}

/** Time left, a little quieter, then the song's length: what a DJ reads to time the next mix. */
function TimeLeft() {
	const p = usePlayer();
	const time = usePlayerTime();
	const duration = Number.isFinite(p.duration) && p.duration > 0 ? p.duration : 0;
	const left = Math.max(0, duration - time);
	return (
		<span className="shrink-0 text-xs tabular-nums" data-hint="Time left / length">
			<span className="text-muted-foreground">−{clock(left)}</span>
			<span className="text-muted-foreground/60"> / </span>
			<span className="text-foreground">{clock(duration)}</span>
		</span>
	);
}

/** Previous, play, the main cue when the song has one, next, and the big waveform's switch. */
function Transport({
	mainCue,
	waveform,
	onWaveform,
}: {
	mainCue: Cue | null;
	waveform: boolean;
	onWaveform: (on: boolean) => void;
}) {
	const p = usePlayer();
	const PlayIcon = p.playing ? Pause : Play;
	const hasNext = p.index + 1 < p.queue.length;
	return (
		<div className="flex shrink-0 items-center gap-1">
			<Button variant="ghost" size="icon" aria-label="Previous" onClick={p.prev}>
				<SkipBack />
			</Button>
			<Button size="icon" aria-label={p.playing ? "Pause" : "Play"} onClick={p.toggle}>
				<PlayIcon />
			</Button>
			{mainCue && <CueButton cue={mainCue} />}
			<Button variant="ghost" size="icon" aria-label="Next" disabled={!hasNext} onClick={p.next}>
				<SkipForward />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				aria-label="Show the waveform"
				aria-pressed={waveform}
				data-hint={waveform ? "Hide the waveform" : "Show the waveform"}
				className={waveform ? "text-primary" : "text-muted-foreground"}
				onClick={() => onWaveform(!waveform)}
			>
				<AudioWaveform />
			</Button>
		</div>
	);
}

/**
 * The player, below the pages. It slides up when a song starts and away when the queue runs out;
 * pausing keeps it. The song column lines up with the sidebar, the buttons follow it on the left,
 * and the song's waveform takes the rest of the width.
 */
export function PlayerBar() {
	const p = usePlayer();
	// Space by default, from anywhere unless typing or a focused list uses the key.
	useShortcut("play", p.toggle);
	const current = useCurrentTrack();
	const shown = useShownTrack(current);
	const open = current !== null;
	const analysis = useTrackAnalysis(shown?.id ?? null).data ?? null;
	const cues = useTrackCues(shown?.id ?? null).data ?? NO_CUES;
	const mainCue = cues?.find((c) => c.main) ?? null;
	const waveform = useWaveformShown();

	return (
		<div
			inert={!open}
			className={cn(
				"grid shrink-0 transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.3,0,0.2,1)] motion-reduce:transition-none",
				open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
			)}
		>
			<footer className="min-h-0 overflow-hidden bg-canvas">
				{shown && waveform && <DeckEditor track={shown} />}
				{/* Under the big waveform the bar is a strip: the deck above already takes the room. */}
				<div className={cn(DECK_COLUMNS, "items-center", waveform ? "h-12" : "h-16")}>
					<div className="min-w-0 pr-4 pl-3">
						{shown && <NowPlaying track={shown} error={p.error} />}
					</div>

					{/* The transport, then the song's timeline: its waveform once analysed. */}
					<div className="flex min-w-0 items-center gap-3 pr-4">
						<Transport mainCue={mainCue} waveform={waveform} onWaveform={setWaveformShown} />
						<SeekBar analysis={analysis} cues={cues} />
						<TimeLeft />
						<VolumeAndTempo track={shown} />
					</div>
				</div>
			</footer>
		</div>
	);
}

/** The song's BPM and key, then the volume, at the bar's right end. */
function VolumeAndTempo({ track }: { track: Track | null }) {
	const p = usePlayer();
	return (
		<div className="flex shrink-0 items-center justify-end gap-2 pl-3">
			{track && <TempoKey track={track} />}
			<Volume2 className="size-4 text-muted-foreground" />
			<input
				type="range"
				aria-label="Volume"
				className="slider w-24"
				style={{ "--fill": p.volume } as CSSProperties}
				min={0}
				max={1}
				step={0.01}
				value={p.volume}
				onChange={(e) => p.setVolume(Number(e.target.value))}
			/>
		</div>
	);
}

/** The track's waveform when it has been analysed, else a plain slider. */
function SeekBar({ analysis, cues }: { analysis: TrackAnalysis | null; cues: readonly Cue[] }) {
	const p = usePlayer();
	const time = usePlayerTime();
	const duration = Number.isFinite(p.duration) && p.duration > 0 ? p.duration : 0;
	if (analysis) {
		return (
			<WaveformSeek
				analysis={analysis}
				position={p.getTime}
				running={p.playing}
				duration={duration}
				disabled={false}
				onSeek={p.seek}
				cues={cues}
				quiet
				className="h-7 min-w-0"
			/>
		);
	}
	return (
		<input
			type="range"
			aria-label="Seek"
			className="slider flex-1"
			style={
				{ "--fill": duration === 0 ? 0 : Math.min(time, duration) / duration } as CSSProperties
			}
			min={0}
			max={duration}
			step={0.1}
			value={Math.min(time, duration)}
			onChange={(e) => p.seek(Number(e.target.value))}
		/>
	);
}
