import { Pause, Play, SkipBack, SkipForward, Volume2 } from "lucide-react";
import { AlbumArt } from "#/components/album-art.tsx";
import { Button } from "#/components/ui/button.tsx";
import { WaveformDetail, WaveformSeek } from "#/components/waveform.tsx";
import { usePlayer } from "#/context/player-context.ts";
import type { TrackAnalysis } from "#/lib/api.ts";
import { clock } from "#/lib/format.ts";
import { useTrackAnalysis } from "#/lib/use-track-analysis.ts";

export function PlayerBar() {
	const p = usePlayer();
	const { current } = p;
	const PlayIcon = p.playing ? Pause : Play;
	const hasNext = p.index + 1 < p.queue.length;
	const analysis = useTrackAnalysis(current?.id ?? null).data ?? null;

	return (
		<footer className="shrink-0 border-t bg-card">
			{current && analysis && (
				<WaveformDetail analysis={analysis} time={p.time} playing={p.playing} />
			)}
			<div className="grid h-20 grid-cols-[1fr_2fr_1fr] items-center gap-4 px-4">
				<div className="flex min-w-0 items-center gap-3">
					{current ? (
						<>
							<AlbumArt trackId={current.id} className="size-12 shrink-0 rounded-md" />
							<div className="min-w-0">
								<div className="truncate font-medium text-sm">{current.title}</div>
								<div className="truncate text-muted-foreground text-xs">
									{p.error ?? current.artist}
								</div>
							</div>
						</>
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
						<span className="w-10 text-right">{clock(p.time)}</span>
						<SeekBar analysis={current ? analysis : null} disabled={current === null} />
						<span className="w-10">{clock(p.duration)}</span>
					</div>
				</div>

				<div className="flex items-center justify-end gap-2">
					<Volume2 className="size-4 text-muted-foreground" />
					<input
						type="range"
						aria-label="Volume"
						className="h-1 w-28 accent-primary"
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
	const duration = Number.isFinite(p.duration) && p.duration > 0 ? p.duration : 0;
	if (analysis) {
		return (
			<WaveformSeek
				analysis={analysis}
				time={p.time}
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
			className="h-1 flex-1 accent-primary"
			min={0}
			max={duration}
			step={0.1}
			value={Math.min(p.time, duration)}
			disabled={disabled}
			onChange={(e) => p.seek(Number(e.target.value))}
		/>
	);
}
