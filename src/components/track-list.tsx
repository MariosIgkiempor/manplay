import { Pause, Play } from "lucide-react";
import type { ReactNode } from "react";
import { AlbumArt } from "#/components/album-art.tsx";
import { SyncBadge } from "#/components/sync-badge.tsx";
import { usePlayer } from "#/context/player-context.ts";
import { syncState } from "#/lib/albums.ts";
import type { Track } from "#/lib/api.ts";
import { cn } from "#/lib/utils.ts";

interface Props {
	tracks: readonly Track[];
	targetCount: number;
	selected?: ReadonlySet<number>;
	onToggle?: (id: number) => void;
	onRemoveTag?: (track: Track, tag: string) => void;
	renderAction?: (track: Track) => ReactNode;
	/** Hide the artwork column (e.g. inside an album view). */
	hideArt?: boolean;
}

function columns(selectable: boolean, hasAction: boolean): string {
	return [
		selectable && "1.75rem",
		"2rem",
		"minmax(0,2.4fr)",
		"minmax(0,1.5fr)",
		"minmax(0,1.5fr)",
		"2rem",
		hasAction && "6rem",
	]
		.filter(Boolean)
		.join(" ");
}

function TagChips({
	track,
	onRemoveTag,
}: {
	track: Track;
	onRemoveTag: ((track: Track, tag: string) => void) | undefined;
}) {
	return (
		<div className="flex flex-wrap gap-1">
			{track.tags.map((tag) => (
				<span
					key={tag}
					className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
				>
					{tag}
					{onRemoveTag && (
						<button
							type="button"
							aria-label={`Remove tag ${tag}`}
							className="text-muted-foreground hover:text-foreground"
							onClick={() => onRemoveTag(track, tag)}
						>
							×
						</button>
					)}
				</span>
			))}
		</div>
	);
}

interface RowProps extends Omit<Props, "tracks"> {
	track: Track;
	onPlay: () => void;
}

function TrackRow({
	track,
	targetCount,
	selected,
	onToggle,
	onRemoveTag,
	renderAction,
	hideArt,
	onPlay,
}: RowProps) {
	const player = usePlayer();
	const isCurrent = player.current?.id === track.id;
	const selectable = selected !== undefined && onToggle !== undefined;
	const PlayIcon = isCurrent && player.playing ? Pause : Play;

	return (
		<div
			className={cn(
				"group grid items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60",
				isCurrent && "bg-muted",
			)}
			style={{ gridTemplateColumns: columns(selectable, renderAction !== undefined) }}
		>
			{selectable && (
				<input
					type="checkbox"
					aria-label={`Select ${track.title}`}
					checked={selected.has(track.id)}
					onChange={() => onToggle(track.id)}
				/>
			)}
			<button
				type="button"
				aria-label={isCurrent && player.playing ? `Pause ${track.title}` : `Play ${track.title}`}
				className={cn(
					"flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground",
					isCurrent
						? "text-primary"
						: "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
				)}
				onClick={isCurrent ? player.toggle : onPlay}
			>
				<PlayIcon className="size-4" />
			</button>
			<div className="flex min-w-0 items-center gap-3">
				{!hideArt && <AlbumArt trackId={track.id} className="size-10 shrink-0 rounded" />}
				<div className="min-w-0">
					<div
						className={cn("truncate", isCurrent && "font-medium text-primary")}
						title={track.title}
					>
						{track.title}
					</div>
					<div className="truncate text-muted-foreground text-xs" title={track.artist}>
						{track.artist}
					</div>
				</div>
			</div>
			<div className="truncate text-muted-foreground" title={track.album}>
				{track.album}
			</div>
			<TagChips track={track} onRemoveTag={onRemoveTag} />
			<SyncBadge state={syncState([track], targetCount)} />
			{renderAction?.(track)}
		</div>
	);
}

export function TrackList({ tracks, ...rest }: Props) {
	const player = usePlayer();
	if (tracks.length === 0) {
		return <p className="px-2 py-8 text-center text-muted-foreground text-sm">No tracks.</p>;
	}
	return (
		<div className="space-y-0.5">
			{tracks.map((track, i) => (
				<TrackRow key={track.id} track={track} {...rest} onPlay={() => player.play(tracks, i)} />
			))}
		</div>
	);
}
