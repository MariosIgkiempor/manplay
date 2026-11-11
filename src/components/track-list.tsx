import { Pause, Play } from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { AddToPlaylistMenu } from "#/components/add-to-playlist-menu.tsx";
import { AlbumArt } from "#/components/album-art.tsx";
import { SyncBadge } from "#/components/sync-badge.tsx";
import { useDetailNav } from "#/context/detail-context.ts";
import { usePlayer } from "#/context/player-context.ts";
import { albumKey, syncState } from "#/lib/albums.ts";
import type { Track } from "#/lib/api.ts";
import { clock } from "#/lib/format.ts";
import type { TrackSelection } from "#/lib/use-track-selection.ts";
import { cn } from "#/lib/utils.ts";

interface Props {
	tracks: readonly Track[];
	targetCount: number;
	selection?: TrackSelection;
	onRemoveTag?: (track: Track, tag: string) => void;
	renderAction?: (track: Track) => ReactNode;
	/** Hide the artwork column (e.g. inside an album view). */
	hideArt?: boolean;
	/** Hide the artist name under each title (e.g. inside an artist view). */
	hideArtist?: boolean;
	/** Hide the album column. */
	hideAlbum?: boolean;
	/** Show each song's length. */
	showDuration?: boolean;
}

const stop = (e: MouseEvent) => e.stopPropagation();

function columns(opts: { action: boolean; album: boolean; duration: boolean }): string {
	return [
		"2rem",
		"minmax(0,2.4fr)",
		opts.album && "minmax(0,1.5fr)",
		"minmax(0,1.5fr)",
		opts.duration && "3rem",
		"2rem",
		opts.action && "6rem",
	]
		.filter(Boolean)
		.join(" ");
}

/** Inline link that opens a detail panel without touching row selection. */
function LinkButton({
	onClick,
	children,
	title,
}: {
	onClick: () => void;
	children: ReactNode;
	title: string;
}) {
	return (
		<button
			type="button"
			title={title}
			className="max-w-full truncate text-left hover:text-foreground hover:underline"
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			onDoubleClick={stop}
		>
			{children}
		</button>
	);
}

function TagChips({
	track,
	onRemoveTag,
}: {
	track: Track;
	onRemoveTag: ((track: Track, tag: string) => void) | undefined;
}) {
	const go = useDetailNav();
	return (
		<div className="flex flex-wrap gap-1">
			{track.tags.map((tag) => (
				<span
					key={tag}
					className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
				>
					<button
						type="button"
						className="hover:underline"
						onClick={(e) => {
							e.stopPropagation();
							go({ kind: "tag", name: tag });
						}}
						onDoubleClick={stop}
					>
						{tag}
					</button>
					{onRemoveTag && (
						<button
							type="button"
							aria-label={`Remove tag ${tag}`}
							className="text-muted-foreground hover:text-foreground"
							onClick={(e) => {
								e.stopPropagation();
								onRemoveTag(track, tag);
							}}
							onDoubleClick={stop}
						>
							×
						</button>
					)}
				</span>
			))}
		</div>
	);
}

interface RowProps extends Omit<Props, "tracks" | "selection"> {
	selection: TrackSelection | undefined;
	track: Track;
	/** Tracks a right-click acts on: the whole selection when the row is part of it. */
	menuTracks: readonly Track[];
	onPlay: () => void;
}

function TitleCell({
	track,
	isCurrent,
	hideArt,
	hideArtist,
}: {
	track: Track;
	isCurrent: boolean;
	hideArt?: boolean | undefined;
	hideArtist?: boolean | undefined;
}) {
	const go = useDetailNav();
	return (
		<div className="flex min-w-0 items-center gap-3">
			{!hideArt && <AlbumArt trackId={track.id} className="size-10 shrink-0 rounded" />}
			<div className="min-w-0">
				<div
					className={cn("truncate", isCurrent && "font-medium text-primary")}
					title={track.title}
				>
					{track.title}
				</div>
				{!hideArtist && (
					<div className="truncate text-muted-foreground text-xs">
						<LinkButton
							title={track.artist}
							onClick={() => go({ kind: "artist", name: track.artist })}
						>
							{track.artist}
						</LinkButton>
					</div>
				)}
			</div>
		</div>
	);
}

function AlbumCell({ track }: { track: Track }) {
	const go = useDetailNav();
	return (
		<div className="truncate text-muted-foreground">
			<LinkButton
				title={track.album}
				onClick={() => go({ kind: "album", key: albumKey(track.artist, track.album) })}
			>
				{track.album}
			</LinkButton>
		</div>
	);
}

function DurationCell({ ms }: { ms: number | null }) {
	return (
		<div className="text-right text-muted-foreground text-xs tabular-nums">
			{ms === null ? "–" : clock(ms / 1000)}
		</div>
	);
}

function TrackRow({
	track,
	targetCount,
	selection,
	onRemoveTag,
	renderAction,
	hideArt,
	hideArtist,
	hideAlbum,
	showDuration,
	menuTracks,
	onPlay,
}: RowProps) {
	const player = usePlayer();
	const isCurrent = player.current?.id === track.id;
	const isSelected = selection?.selected.has(track.id) ?? false;
	const PlayIcon = isCurrent && player.playing ? Pause : Play;

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter") {
			onPlay();
		} else if (e.key === " ") {
			e.preventDefault();
			selection?.toggle(track.id);
		}
	};

	return (
		<AddToPlaylistMenu
			tracks={menuTracks}
			label={menuTracks.length === 1 ? track.title : `${menuTracks.length} songs`}
		>
			<div
				role="option"
				aria-selected={isSelected}
				tabIndex={0}
				className={cn(
					"group grid cursor-default items-center gap-3 rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
					isSelected ? "bg-primary/20" : "hover:bg-muted/60",
					isCurrent && !isSelected && "bg-muted",
				)}
				style={{
					gridTemplateColumns: columns({
						action: renderAction !== undefined,
						album: !hideAlbum,
						duration: !!showDuration,
					}),
				}}
				onClick={(e) => selection?.click(track.id, e)}
				onDoubleClick={onPlay}
				onKeyDown={onKeyDown}
			>
				<button
					type="button"
					aria-label={isCurrent && player.playing ? `Pause ${track.title}` : `Play ${track.title}`}
					className={cn(
						"flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground",
						isCurrent
							? "text-primary"
							: "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
					)}
					onClick={(e) => {
						e.stopPropagation();
						if (isCurrent) {
							player.toggle();
						} else {
							onPlay();
						}
					}}
					onDoubleClick={stop}
				>
					<PlayIcon className="size-4" />
				</button>
				<TitleCell track={track} isCurrent={isCurrent} hideArt={hideArt} hideArtist={hideArtist} />
				{!hideAlbum && <AlbumCell track={track} />}
				<TagChips track={track} onRemoveTag={onRemoveTag} />
				{showDuration && <DurationCell ms={track.durationMs} />}
				<SyncBadge state={syncState([track], targetCount)} />
				{renderAction?.(track)}
			</div>
		</AddToPlaylistMenu>
	);
}

export function TrackList({ tracks, selection, ...rest }: Props) {
	const player = usePlayer();
	if (tracks.length === 0) {
		return <p className="px-2 py-8 text-center text-muted-foreground text-sm">No tracks.</p>;
	}
	const menuTracksFor = (track: Track): readonly Track[] =>
		selection?.selected.has(track.id) && selection.selected.size > 1
			? tracks.filter((t) => selection.selected.has(t.id))
			: [track];
	const onKeyDown = (e: KeyboardEvent) => {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && selection) {
			e.preventDefault();
			selection.selectAll();
		}
	};
	return (
		<div
			role="listbox"
			aria-multiselectable
			aria-label="Tracks"
			tabIndex={-1}
			className="select-none space-y-0.5 outline-none"
			onKeyDown={onKeyDown}
		>
			{tracks.map((track, i) => (
				<TrackRow
					key={track.id}
					track={track}
					selection={selection}
					{...rest}
					menuTracks={menuTracksFor(track)}
					onPlay={() => player.play(tracks, i)}
				/>
			))}
		</div>
	);
}
