import { useNavigate } from "@tanstack/react-router";
import { Activity, ArrowRight, Clock, Disc3, KeyRound, Pause, Play, X } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, type ReactNode, useContext, useState } from "react";
import { AddToPlaylistMenu } from "#/components/add-to-playlist-menu.tsx";
import { AlbumArt } from "#/components/album-art.tsx";
import { ArtistLinks } from "#/components/artist-links.tsx";
import { InlineEdit, InlineInput } from "#/components/inline-edit.tsx";
import { LoadMore } from "#/components/load-more.tsx";
import { type MenuEntry, RowMenu } from "#/components/menu.tsx";
import { EmptyState } from "#/components/page.tsx";
import { SyncBadge } from "#/components/sync-badge.tsx";
import { PanelScopeContext, useDetail, useDetailNav } from "#/context/detail-context.ts";
import { usePlayer } from "#/context/player-context.ts";
import { TrackOrderContext } from "#/context/track-order.ts";
import { albumKey, syncState } from "#/lib/albums.ts";
import type { Track } from "#/lib/api.ts";
import { clock } from "#/lib/format.ts";
import { camelot, formatBpm, keyName, normalizeKey } from "#/lib/musical-key.ts";
import { WELL_ROWS } from "#/lib/page-layout.ts";
import { useTracks } from "#/lib/queries.ts";
import { parseBpm } from "#/lib/track-fields.ts";
import { useProgressive } from "#/lib/use-progressive.ts";
import type { InlineField } from "#/lib/use-track-edit.ts";
import type { TrackSelection } from "#/lib/use-track-selection.ts";
import { cn } from "#/lib/utils.ts";

interface Props {
	tracks: readonly Track[];
	targetCount: number;
	selection?: TrackSelection;
	onRemoveTag?: (track: Track, tag: string) => void;
	/** Saves an inline edit. Without it the BPM, key and title cells are read-only. */
	onEdit?: (track: Track, field: InlineField, value: string) => void;
	renderAction?: ((track: Track, index: number) => ReactNode) | undefined;
	/** Right-click items for where the list is, e.g. "Remove from playlist", for the songs it acts on. */
	menuExtra?: (tracks: readonly Track[]) => readonly MenuEntry[];
	/**
	 * Replaces the library's right-click menu with these items, for songs that are not library
	 * songs (e.g. on a USB drive). Gets the row's place in the list.
	 */
	rowMenu?: (track: Track, index: number) => readonly MenuEntry[];
	/** Row keys, when the same song can be listed twice; defaults to the track id. */
	rowKey?: (track: Track, index: number) => string | number;
	/** Hide the artwork column (e.g. inside an album view). */
	hideArt?: boolean;
	/** Hide the artist name under each title (e.g. inside an artist view). */
	hideArtist?: boolean;
	/** Hide the album column. */
	hideAlbum?: boolean;
	/** Shown when there are no tracks. */
	empty?: ReactNode;
}

const stop = (e: MouseEvent) => e.stopPropagation();

interface Layout {
	/** Room for tag chips: hidden in the narrow split and drawer. */
	tags: boolean;
}

/**
 * Columns: the song (art and three lines), tags when there is room, then sync and actions. Play
 * sits on the artwork, or without artwork, at the end of the playing song's row.
 */
function rowColumns(l: Layout): string {
	return cn(
		"grid-cols-[minmax(0,1fr)_auto]",
		l.tags && "@3xl/list:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto]",
	);
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
	const navigate = useNavigate();
	const { close } = useDetail();
	const player = usePlayer();
	const library = useTracks().data ?? [];
	const openTag = (tag: string) => {
		close();
		void navigate({ to: "/tags/$", params: { _splat: tag } });
	};
	// A tag also covers the tags under it, as the tag's page does.
	const tagged = (tag: string) =>
		library.filter((t) => t.tags.some((own) => own === tag || own.startsWith(`${tag}/`)));
	const menuFor = (tag: string): MenuEntry[] => [
		{ label: "Go to tag", icon: <ArrowRight />, onSelect: () => openTag(tag) },
		{ label: "Play songs tagged", icon: <Play />, onSelect: () => player.play(tagged(tag), 0) },
		"separator",
		onRemoveTag && {
			label: "Remove from this song",
			icon: <X />,
			destructive: true,
			onSelect: () => onRemoveTag(track, tag),
		},
	];
	return (
		<div className="flex min-w-0 flex-wrap gap-1">
			{track.tags.map((tag) => (
				// A right-click on a tag is about the tag, not the song's own menu.
				// biome-ignore lint/a11y/noStaticElementInteractions: only keeps the song's menu shut
				<span key={tag} className="contents" onContextMenu={(e) => e.stopPropagation()}>
					<RowMenu
						label={tag}
						items={menuFor(tag)}
						render={<span />}
						className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground text-xs"
					>
						<button
							type="button"
							className="truncate hover:text-foreground hover:underline"
							onClick={(e) => {
								e.stopPropagation();
								openTag(tag);
							}}
						>
							{tag}
						</button>
						{onRemoveTag && (
							<button
								type="button"
								aria-label={`Remove tag ${tag}`}
								className="hover:text-foreground"
								onClick={(e) => {
									e.stopPropagation();
									onRemoveTag(track, tag);
								}}
								onDoubleClick={stop}
							>
								×
							</button>
						)}
					</RowMenu>
				</span>
			))}
		</div>
	);
}

/**
 * The song in three lines: title; artist and album; length, BPM and key. BPM and key can be
 * edited in place when the list can save.
 */
function SongCell({
	track,
	isCurrent,
	isOpen,
	open,
	hideArt,
	hideArtist,
	hideAlbum,
	renaming,
	onRename,
	onRenameEnd,
	onEdit,
	playButton,
}: {
	track: Track;
	isCurrent: boolean;
	/** The song is the one the split shows. */
	isOpen: boolean;
	/** Opens the song; absent for songs that are not in the library. */
	open: (() => void) | undefined;
	hideArt?: boolean | undefined;
	hideArtist?: boolean | undefined;
	hideAlbum?: boolean | undefined;
	renaming: boolean;
	onRename: (title: string) => void;
	onRenameEnd: () => void;
	onEdit: Props["onEdit"];
	/** Laid over the artwork. */
	playButton: ReactNode;
}) {
	const go = useDetailNav();
	const showArtist = !hideArtist && track.artist !== "";
	const showAlbum = !hideAlbum && track.album !== "";
	let title: ReactNode = track.title;
	if (renaming) {
		title = (
			<InlineInput
				initial={track.title}
				label="Title"
				parse={(v) => (v.trim() === "" ? null : v.trim())}
				onCommit={(v) => {
					onRenameEnd();
					onRename(v);
				}}
				onCancel={onRenameEnd}
			/>
		);
	} else if (open) {
		title = (
			<button
				type="button"
				title={`Open ${track.title}`}
				className="max-w-full truncate text-left hover:underline"
				onClick={(e) => {
					e.stopPropagation();
					open();
				}}
			>
				{track.title}
			</button>
		);
	}
	return (
		<div className="flex min-w-0 items-center gap-3">
			{!hideArt && (
				<div className="relative size-12 shrink-0">
					<AlbumArt trackId={track.id} className="size-12 rounded-md" />
					{playButton}
				</div>
			)}
			<div className="min-w-0 flex-1 leading-tight">
				<div
					className={cn("truncate text-sm", (isCurrent || isOpen) && "font-medium text-primary")}
					title={track.title}
				>
					{title}
				</div>
				{(showArtist || showAlbum) && (
					<div className="mt-0.5 flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
						{showArtist && <ArtistLinks artist={track.artist} icon />}
						{showAlbum && (
							<span className="flex min-w-0 shrink items-center gap-1">
								<Disc3 aria-hidden="true" className="size-3 shrink-0 opacity-60" />
								<LinkButton
									title={`Open ${track.album}`}
									onClick={() => go({ kind: "album", key: albumKey(track.artist, track.album) })}
								>
									{track.album}
								</LinkButton>
							</span>
						)}
					</div>
				)}
				<div className="mt-0.5 flex h-5 items-center gap-3 text-muted-foreground text-xs tabular-nums">
					<span className="flex items-center gap-1" title="Length">
						<Clock aria-hidden="true" className="size-3 opacity-60" />
						{track.durationMs === null ? "–" : clock(track.durationMs / 1000)}
					</span>
					<FieldCell track={track} field="bpm" onEdit={onEdit} />
					<FieldCell track={track} field="key" onEdit={onEdit} />
				</div>
			</div>
		</div>
	);
}

const CAMELOT = Array.from({ length: 24 }, (_, i) => `${(i >> 1) + 1}${i % 2 === 0 ? "A" : "B"}`);

/** A typed key as its Camelot code, so "Am" and "8A" count as the same value. */
const parseKey = (raw: string): string | null => {
	if (raw.trim() === "") {
		return "";
	}
	const key = normalizeKey(raw);
	return key === null ? null : (camelot(key) ?? key);
};

/** A song's BPM or key as shown in its cell, and the hover text explaining it. */
function shown(track: Track, field: "bpm" | "key"): { value: string; hint: string } {
	const missing = track.analyzed ? "not detected" : "not analyzed yet";
	if (field === "bpm") {
		const value = track.bpm === null ? "" : formatBpm(track.bpm);
		return { value, hint: value === "" ? `BPM ${missing}` : `${value} BPM` };
	}
	if (track.key === null) {
		return { value: "", hint: `Key ${missing}` };
	}
	return { value: camelot(track.key) ?? track.key, hint: keyName(track.key) ?? track.key };
}

/**
 * Tempo and key as DJs read them: "128" and Camelot "8A", with the full key name and where the
 * value came from on hover. Editable when the list can save.
 */
function FieldCell({
	track,
	field,
	onEdit,
}: {
	track: Track;
	field: "bpm" | "key";
	onEdit: Props["onEdit"];
}) {
	const { value, hint: base } = shown(track, field);
	const edited = track.edited[field];
	const hint = edited ? `${base}, set by you` : base;
	const Icon = field === "bpm" ? Activity : KeyRound;
	// Values set by hand show the icon in the accent colour; re-analysis keeps them.
	const icon = (
		<Icon
			aria-hidden="true"
			className={cn("size-3 shrink-0", edited ? "text-primary" : "opacity-60")}
		/>
	);
	if (!onEdit) {
		return (
			<span title={hint} className={cn("flex items-center gap-1", value === "" && "opacity-50")}>
				{icon}
				{value || "–"}
			</span>
		);
	}
	return (
		<span className="flex min-w-0 items-center gap-0.5">
			{icon}
			<InlineEdit
				value={value}
				hint={`${hint}. Click to edit`}
				label={field === "bpm" ? "BPM" : "Key"}
				inputMode={field === "bpm" ? "numeric" : "text"}
				parse={field === "bpm" ? parseBpm : parseKey}
				suggestions={field === "key" ? CAMELOT : undefined}
				onCommit={(v) => onEdit(track, field, v)}
				className="mx-0 h-5 w-auto min-w-6 px-1 text-xs"
			/>
		</span>
	);
}

interface RowProps extends Omit<Props, "tracks" | "selection" | "empty"> {
	selection: TrackSelection | undefined;
	track: Track;
	layout: Layout;
	/** Tracks a right-click acts on: the whole selection when the row is part of it. */
	menuTracks: readonly Track[];
	index: number;
	onPlay: () => void;
}

/** The library's song menu, or the list's own `rowMenu` in its place. */
function RowMenuFor({
	track,
	index,
	menuTracks,
	rowMenu,
	menuExtra,
	onPlay,
	onRename,
	noGoTo,
	children,
}: {
	track: Track;
	index: number;
	menuTracks: readonly Track[];
	rowMenu: RowProps["rowMenu"];
	menuExtra: RowProps["menuExtra"];
	onPlay: () => void;
	onRename: (() => void) | undefined;
	noGoTo: boolean;
	children: ReactNode;
}) {
	if (rowMenu) {
		return (
			<RowMenu label={track.title} items={rowMenu(track, index)}>
				{children}
			</RowMenu>
		);
	}
	return (
		<AddToPlaylistMenu
			tracks={menuTracks}
			label={menuTracks.length === 1 ? track.title : `${menuTracks.length} songs`}
			onRename={onRename}
			onPlay={menuTracks.length === 1 ? onPlay : undefined}
			extra={menuExtra?.(menuTracks)}
			noGoTo={noGoTo}
		>
			{children}
		</AddToPlaylistMenu>
	);
}

function PlayButton({
	track,
	isCurrent,
	onPlay,
	onArt = false,
}: {
	track: Track;
	isCurrent: boolean;
	onPlay: () => void;
	/**
	 * Laid over the song's artwork: hidden until the row is hovered or focused, and kept showing,
	 * on a darkened cover, for the song that is playing.
	 */
	onArt?: boolean;
}) {
	const player = usePlayer();
	const pausing = isCurrent && player.playing;
	const Icon = pausing ? Pause : Play;
	return (
		<button
			type="button"
			aria-label={pausing ? `Pause ${track.title}` : `Play ${track.title}`}
			className={
				onArt
					? cn(
							"absolute inset-0 grid place-items-center rounded-md bg-black/50 text-white outline-none transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:fill-current",
							isCurrent
								? "text-primary"
								: "opacity-0 hover:bg-black/60 group-hover:opacity-100 group-focus-visible:opacity-100",
						)
					: cn(
							"flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground",
							isCurrent
								? "text-primary"
								: "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
						)
			}
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
			<Icon className={onArt ? "size-5" : "size-4"} />
		</button>
	);
}

/** Inline rename of a song's title, from F2 or the right-click menu. */
function useRename() {
	const [active, setActive] = useState(false);
	return { active, start: () => setActive(true), end: () => setActive(false) };
}

function TrackRow({
	track,
	targetCount,
	selection,
	onRemoveTag,
	onEdit,
	renderAction,
	hideArt,
	hideArtist,
	hideAlbum,
	layout,
	menuTracks,
	menuExtra,
	rowMenu,
	index,
	onPlay,
}: RowProps) {
	const player = usePlayer();
	const go = useDetailNav();
	const order = useContext(TrackOrderContext);
	const splitView = useDetail().view;
	const isOpen = splitView?.kind === "song" && splitView.trackId === track.id;
	const isCurrent = player.current?.id === track.id;
	const isSelected = selection?.selected.has(track.id) ?? false;
	const canRename = onEdit !== undefined;
	const rename = useRename();

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter") {
			onPlay();
		} else if (e.key === " ") {
			e.preventDefault();
			selection?.toggle(track.id);
		} else if (e.key === "F2" && canRename) {
			e.preventDefault();
			rename.start();
		}
	};

	return (
		<RowMenuFor
			track={track}
			index={index}
			menuTracks={menuTracks}
			rowMenu={rowMenu}
			menuExtra={menuExtra}
			onPlay={onPlay}
			onRename={canRename && menuTracks.length === 1 ? rename.start : undefined}
			noGoTo={hideArt ?? false}
		>
			<div
				role="option"
				aria-selected={isSelected}
				tabIndex={0}
				className={cn(
					"group grid min-h-16 cursor-default items-center gap-3 px-3 py-1.5 text-sm outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-ring/70 focus-visible:ring-inset",
					rowColumns(layout),
					// Like a highlighted line in a code listing: chosen rows take a cue tint, and the
					// playing song a cue rule down its left edge.
					isSelected ? "bg-primary/[0.09]" : "hover:bg-white/[0.03]",
					(isCurrent || isSelected) && "shadow-[inset_2px_0_0_0_var(--primary)]",
				)}
				onClick={(e) => selection?.click(track.id, e)}
				onDoubleClick={onPlay}
				onKeyDown={onKeyDown}
			>
				<SongCell
					track={track}
					isCurrent={isCurrent}
					isOpen={isOpen}
					open={
						rowMenu
							? undefined
							: () => go({ kind: "song", trackId: track.id, list: order ?? undefined })
					}
					hideArt={hideArt}
					hideArtist={hideArtist}
					hideAlbum={hideAlbum}
					renaming={rename.active}
					onRename={(title) => onEdit?.(track, "title", title)}
					onRenameEnd={rename.end}
					onEdit={onEdit}
					playButton={<PlayButton track={track} isCurrent={isCurrent} onPlay={onPlay} onArt />}
				/>
				{layout.tags && (
					<div className="hidden min-w-0 @3xl/list:block">
						<TagChips track={track} onRemoveTag={onRemoveTag} />
					</div>
				)}
				<div className="flex items-center gap-2">
					<SyncBadge state={syncState([track], targetCount)} />
					{hideArt && isCurrent && (
						<PlayButton track={track} isCurrent={isCurrent} onPlay={onPlay} />
					)}
					{renderAction?.(track, index)}
				</div>
			</div>
		</RowMenuFor>
	);
}

export function TrackList({ tracks, selection, empty, rowKey, ...rest }: Props) {
	const player = usePlayer();
	const inPanel = useContext(PanelScopeContext);
	// Rows are added a page at a time as the list scrolls; play and select still use every track.
	const page = useProgressive(tracks, (t) => t.id);
	if (tracks.length === 0) {
		return empty ?? <EmptyState title="No songs" />;
	}
	// The side panel is too narrow for tag chips; the right-click menu still manages tags.
	const layout: Layout = { tags: !inPanel };
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
		<TrackOrderContext.Provider value={tracks.map((t) => t.id)}>
			<div className="@container/list select-none">
				<div
					role="listbox"
					aria-multiselectable
					aria-label="Songs"
					tabIndex={-1}
					// On a page the rows sit in a well; a side panel is already its own surface.
					className={cn("divide-y divide-hairline outline-none", !inPanel && WELL_ROWS)}
					onKeyDown={onKeyDown}
				>
					{page.shown.map((track, i) => (
						<TrackRow
							key={rowKey ? rowKey(track, i) : track.id}
							track={track}
							index={i}
							selection={selection}
							{...rest}
							layout={layout}
							menuTracks={menuTracksFor(track)}
							onPlay={() => player.play(tracks, i)}
						/>
					))}
				</div>
				<LoadMore more={page.more} onMore={page.loadMore} />
			</div>
		</TrackOrderContext.Provider>
	);
}
