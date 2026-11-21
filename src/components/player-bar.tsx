import {
	AudioWaveform,
	Grid3x3,
	Pause,
	Play,
	SkipBack,
	SkipForward,
	TextCursorInput,
	Volume2,
} from "lucide-react";
import { type CSSProperties, useState } from "react";
import { AddToPlaylistMenu } from "#/components/add-to-playlist-menu.tsx";
import { AlbumArt } from "#/components/album-art.tsx";
import { ArtistLinks } from "#/components/artist-links.tsx";
import { Button } from "#/components/ui/button.tsx";
import { WaveformDetail, WaveformSeek } from "#/components/waveform.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { usePlayer, usePlayerTime } from "#/context/player-context.ts";
import { TrackOrderContext } from "#/context/track-order.ts";
import type { Track, TrackAnalysis } from "#/lib/api.ts";
import { clock } from "#/lib/format.ts";
import { camelot, formatBpm, keyName } from "#/lib/musical-key.ts";
import { useTracks } from "#/lib/queries.ts";
import { useTrackAnalysis } from "#/lib/use-track-analysis.ts";
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
				<span title="Tempo">
					<span className="font-semibold text-foreground text-sm">{bpm}</span>{" "}
					<span className="text-muted-foreground">BPM</span>
				</span>
			)}
			{key !== "" && (
				<span
					title={keyName(track.key ?? "") ?? "Key"}
					className="font-semibold text-primary text-sm"
				>
					{key}
				</span>
			)}
		</div>
	);
}

const WAVEFORM_KEY = "manplay.player-waveform";

/** Whether the big waveform above the player bar is shown; remembered on this computer. */
function useWaveformShown(): [boolean, (on: boolean) => void] {
	const [on, setOn] = useState(() => {
		try {
			return localStorage.getItem(WAVEFORM_KEY) !== "0";
		} catch {
			return true;
		}
	});
	const set = (next: boolean) => {
		setOn(next);
		try {
			localStorage.setItem(WAVEFORM_KEY, next ? "1" : "0");
		} catch {
			// Not remembered; the toggle still works for now.
		}
	};
	return [on, set];
}

/**
 * Cover, title and artist of the playing song. The title opens the song and the artist the
 * artist; a right-click offers the same menu as a song in any list, stepping through the queue.
 */
function NowPlaying({ track, error }: { track: Track; error: string | null }) {
	const detail = useDetail();
	const p = usePlayer();
	return (
		<TrackOrderContext.Provider value={p.queue.map((t) => t.id)}>
			<AddToPlaylistMenu tracks={[track]} label={track.title}>
				<div className="flex min-w-0 items-center gap-3">
					<AlbumArt trackId={track.id} className="size-12 shrink-0 rounded-md" />
					<div className="min-w-0">
						<button
							type="button"
							title={`${track.title} · open song`}
							onClick={() =>
								detail.open({
									kind: "song",
									trackId: track.id,
									list: p.queue.map((t) => t.id),
								})
							}
							className={cn(
								"block max-w-full truncate text-left font-medium text-sm hover:underline",
							)}
						>
							{track.title}
						</button>
						<div className="flex min-w-0 text-muted-foreground text-xs">
							{error ?? <ArtistLinks artist={track.artist} />}
						</div>
					</div>
				</div>
			</AddToPlaylistMenu>
		</TrackOrderContext.Provider>
	);
}

/** Open the playing song in the grid editor (stepping through the queue) or the tag editor. */
function SongActions({ track }: { track: Track }) {
	const detail = useDetail();
	const p = usePlayer();
	return (
		<>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Edit grid and cues"
				title="Edit grid and cues"
				onClick={() =>
					detail.open({
						kind: "song",
						trackId: track.id,
						tab: "grid",
						list: p.queue.map((t) => t.id),
					})
				}
			>
				<Grid3x3 />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Edit metadata"
				title="Edit metadata"
				onClick={() =>
					detail.open({
						kind: "song",
						trackId: track.id,
						tab: "metadata",
						list: p.queue.map((t) => t.id),
					})
				}
			>
				<TextCursorInput />
			</Button>
		</>
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

export function PlayerBar() {
	const p = usePlayer();
	const time = usePlayerTime();
	const current = useCurrentTrack();
	const PlayIcon = p.playing ? Pause : Play;
	const hasNext = p.index + 1 < p.queue.length;
	const analysis = useTrackAnalysis(current?.id ?? null).data ?? null;
	const [waveform, setWaveform] = useWaveformShown();

	return (
		<footer className="shrink-0 border-t bg-card">
			{waveform && current && analysis && (
				<WaveformDetail analysis={analysis} position={p.getTime} running={p.playing} />
			)}
			<div className="grid h-20 grid-cols-[1fr_2fr_1fr] items-center gap-4 px-4">
				<div className="flex min-w-0 items-center gap-3">
					{current ? (
						<NowPlaying track={current} error={p.error} />
					) : (
						<span className="text-muted-foreground text-sm">Nothing playing</span>
					)}
				</div>

				<div className="space-y-1">
					<div className="flex items-center justify-center gap-2">
						<Button
							variant="ghost"
							size="icon"
							aria-label="Previous"
							disabled={current === null}
							onClick={p.prev}
						>
							<SkipBack />
						</Button>
						<Button
							size="icon"
							aria-label={p.playing ? "Pause" : "Play"}
							disabled={current === null}
							onClick={p.toggle}
						>
							<PlayIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon"
							aria-label="Next"
							disabled={!hasNext}
							onClick={p.next}
						>
							<SkipForward />
						</Button>
					</div>
					<div className="flex items-center gap-2 text-muted-foreground text-xs tabular-nums">
						<span className="w-10 text-right">{clock(time)}</span>
						<SeekBar analysis={current ? analysis : null} disabled={current === null} />
						<span className="w-10">{clock(p.duration)}</span>
					</div>
				</div>

				<div className="flex items-center justify-end gap-2">
					{current && <TempoKey track={current} />}
					{current && <SongActions track={current} />}
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Show the waveform"
						aria-pressed={waveform}
						title={waveform ? "Hide the waveform" : "Show the waveform"}
						className={waveform ? "text-primary" : "text-muted-foreground"}
						onClick={() => setWaveform(!waveform)}
					>
						<AudioWaveform />
					</Button>
					<Volume2 className="size-4 text-muted-foreground" />
					<input
						type="range"
						aria-label="Volume"
						className="slider w-28"
						style={{ "--fill": p.volume } as CSSProperties}
						min={0}
						max={1}
						step={0.01}
						value={p.volume}
						onChange={(e) => p.setVolume(Number(e.target.value))}
					/>
				</div>
			</div>
		</footer>
	);
}

/** The track's waveform when it has been analysed, else a plain slider. */
function SeekBar({ analysis, disabled }: { analysis: TrackAnalysis | null; disabled: boolean }) {
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
				disabled={disabled}
				onSeek={p.seek}
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
			disabled={disabled}
			onChange={(e) => p.seek(Number(e.target.value))}
		/>
	);
}
