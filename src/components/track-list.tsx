import { useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Pause, Play } from "lucide-react";
import {
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { AddToPlaylistMenu } from "#/components/add-to-playlist-menu.tsx";
import { AlbumArt } from "#/components/album-art.tsx";
import { ArtistLinks } from "#/components/artist-links.tsx";
import { InlineEdit, InlineInput } from "#/components/inline-edit.tsx";
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
import { parseBpm, type Sort, type SortKey } from "#/lib/track-fields.ts";
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
	sort?: Sort | null;
	/** Makes the column headers sort the list. */
	onSort?: (key: SortKey) => void;
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
	/** Show each song's length. */
	showDuration?: boolean;
	/** Shown when there are no tracks. */
	empty?: ReactNode;
}

const stop = (e: MouseEvent) => e.stopPropagation();

/** How long a second click on a selected title waits before it starts a rename (Finder-style). */
const RENAME_DELAY = 450;

interface Layout {
	album: boolean;
	tags: boolean;
	duration: boolean;
	action: boolean;
}

function columns(l: Layout): string {
	return [
		"2rem",
		"minmax(0,2.4fr)",
		l.album && "minmax(0,1.4fr)",
		"3.25rem",
		"3.25rem",
		l.tags && "minmax(0,1.2fr)",
		l.duration && "3rem",
		"1.25rem",
		l.action && "auto",
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
	const navigate = useNavigate();
	const { close } = useDetail();
	return (
		<div className="flex min-w-0 flex-wrap gap-1">
			{track.tags.map((tag) => (
				<span
					key={tag}
					className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground text-xs"
				>
					<button
						type="button"
						className="truncate hover:text-foreground hover:underline"
						onClick={(e) => {
							e.stopPropagation();
							close();
							void navigate({ to: "/tags/$", params: { _splat: tag } });
						}}
						onDoubleClick={stop}
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
				</span>
			))}
		</div>
	);
}

function TitleCell({
	track,
	isCurrent,
	hideArt,
	hideArtist,
	renaming,
	onRename,
	onRenameEnd,
}: {
	track: Track;
	isCurrent: boolean;
	hideArt?: boolean | undefined;
	hideArtist?: boolean | undefined;
	renaming: boolean;
	onRename: (title: string) => void;
	onRenameEnd: () => void;
}) {
	return (
		<div className="flex min-w-0 items-center gap-3">
			{!hideArt && <AlbumArt trackId={track.id} className="size-9 shrink-0 rounded" />}
			<div className="min-w-0 flex-1">
				{renaming ? (
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
				) : (
					<div
						data-title
						className={cn("truncate", isCurrent && "font-medium text-primary")}
						title={track.title}
					>
						{track.title}
					</div>
				)}
				{!hideArtist && (
					<div className="truncate text-muted-foreground text-xs">
						<ArtistLinks artist={track.artist} />
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
	// Values set by hand carry a dot, and re-analysis keeps them unless told otherwise.
	const mark =
		edited &&
		"relative before:absolute before:top-1/2 before:-left-2 before:size-1 before:-translate-y-1/2 before:rounded-full before:bg-primary";
	if (!onEdit) {
		return (
			<div
				title={hint}
				className={cn("tabular-nums", value === "" && "text-muted-foreground/50", mark)}
			>
				{value || "–"}
			</div>
		);
	}
	return (
		<div className={cn("min-w-0", mark)}>
			<InlineEdit
				value={value}
				hint={`${hint}. Click to edit`}
				label={field === "bpm" ? "BPM" : "Key"}
				inputMode={field === "bpm" ? "numeric" : "text"}
				parse={field === "bpm" ? parseBpm : parseKey}
				suggestions={field === "key" ? CAMELOT : undefined}
				onCommit={(v) => onEdit(track, field, v)}
			/>
		</div>
	);
}

function DurationCell({ ms }: { ms: number | null }) {
	return (
		<div className="text-right text-muted-foreground tabular-nums">
			{ms === null ? "–" : clock(ms / 1000)}
		</div>
	);
}

interface RowProps extends Omit<Props, "tracks" | "selection" | "sort" | "onSort" | "empty"> {
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
}: {
	track: Track;
	isCurrent: boolean;
	onPlay: () => void;
}) {
	const player = usePlayer();
	const pausing = isCurrent && player.playing;
	const Icon = pausing ? Pause : Play;
	return (
		<button
			type="button"
			aria-label={pausing ? `Pause ${track.title}` : `Play ${track.title}`}
			className={cn(
				"flex size-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground",
				isCurrent ? "text-primary" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
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
			<Icon className="size-4" />
		</button>
	);
}

/**
 * Finder-style rename: a second, slow click on the title of the only selected row starts it,
 * unless the click turns into a double-click (which plays).
 */
function useSlowClickRename(allowed: boolean) {
	const [active, setActive] = useState(false);
	const timer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	const cancelPending = () => window.clearTimeout(timer.current);
	const onClick = (e: MouseEvent) => {
		if (!allowed || e.shiftKey || e.metaKey || e.ctrlKey || e.detail > 1) {
			return;
		}
		cancelPending();
		timer.current = window.setTimeout(() => setActive(true), RENAME_DELAY);
	};
	return {
		active,
		onClick,
		cancelPending,
		start: () => setActive(true),
		end: () => setActive(false),
	};
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
	layout,
	menuTracks,
	menuExtra,
	rowMenu,
	index,
	onPlay,
}: RowProps) {
	const player = usePlayer();
	const isCurrent = player.current?.id === track.id;
	const isSelected = selection?.selected.has(track.id) ?? false;
	const canRename = onEdit !== undefined;
	const rename = useSlowClickRename(canRename && isSelected && selection?.selected.size === 1);

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
					"group grid h-12 cursor-default items-center gap-3 rounded-md px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
					isSelected ? "bg-primary/15" : "hover:bg-muted/60",
					isCurrent && !isSelected && "bg-muted/80",
				)}
				style={{ gridTemplateColumns: columns(layout) }}
				onClick={(e) => {
					if (e.target instanceof Element && e.target.closest("[data-title]")) {
						rename.onClick(e);
					}
					selection?.click(track.id, e);
				}}
				onDoubleClick={() => {
					rename.cancelPending();
					onPlay();
				}}
				onKeyDown={onKeyDown}
			>
				<PlayButton track={track} isCurrent={isCurrent} onPlay={onPlay} />
				<TitleCell
					track={track}
					isCurrent={isCurrent}
					hideArt={hideArt}
					hideArtist={hideArtist}
					renaming={rename.active}
					onRename={(title) => onEdit?.(track, "title", title)}
					onRenameEnd={rename.end}
				/>
				{layout.album && <AlbumCell track={track} />}
				<FieldCell track={track} field="bpm" onEdit={onEdit} />
				<FieldCell track={track} field="key" onEdit={onEdit} />
				{layout.tags && <TagChips track={track} onRemoveTag={onRemoveTag} />}
				{layout.duration && <DurationCell ms={track.durationMs} />}
				<SyncBadge state={syncState([track], targetCount)} />
				{renderAction?.(track, index)}
			</div>
		</RowMenuFor>
	);
}

function HeaderCell({
	label,
	sortKey,
	sort,
	onSort,
	align = "left",
}: {
	label: string;
	sortKey?: SortKey;
	sort: Sort | null | undefined;
	onSort: ((key: SortKey) => void) | undefined;
	align?: "left" | "right";
}) {
	if (!sortKey || !onSort) {
		return <div className={cn("truncate", align === "right" && "text-right")}>{label}</div>;
	}
	const active = sort?.key === sortKey;
	const Arrow = sort?.desc ? ArrowDown : ArrowUp;
	return (
		<button
			type="button"
			onClick={() => onSort(sortKey)}
			aria-label={`Sort by ${label.toLowerCase()}`}
			className={cn(
				"flex min-w-0 items-center gap-1 truncate hover:text-foreground",
				align === "right" && "justify-end",
				active && "text-foreground",
			)}
		>
			{label}
			{active && <Arrow className="size-3 shrink-0" />}
		</button>
	);
}

function HeaderRow({
	layout,
	sort,
	onSort,
}: {
	layout: Layout;
	sort: Sort | null | undefined;
	onSort: ((key: SortKey) => void) | undefined;
}) {
	const cell = { sort, onSort };
	return (
		<div
			className="grid h-8 items-center gap-3 border-b px-2 font-medium text-muted-foreground text-xs"
			style={{ gridTemplateColumns: columns(layout) }}
		>
			<span />
			<HeaderCell label="Title" sortKey="title" {...cell} />
			{layout.album && <HeaderCell label="Album" sortKey="album" {...cell} />}
			<HeaderCell label="BPM" sortKey="bpm" {...cell} />
			<HeaderCell label="Key" sortKey="key" {...cell} />
			{layout.tags && <HeaderCell label="Tags" {...cell} />}
			{layout.duration && <HeaderCell label="Time" sortKey="duration" align="right" {...cell} />}
			<span />
			{layout.action && <span />}
		</div>
	);
}

export function TrackList({ tracks, selection, sort, onSort, empty, rowKey, ...rest }: Props) {
	const player = usePlayer();
	const inPanel = useContext(PanelScopeContext);
	if (tracks.length === 0) {
		return empty ?? <EmptyState title="No songs" />;
	}
	const layout: Layout = {
		album: !rest.hideAlbum,
		// The slide-over is too narrow for tag chips; the right-click menu still manages tags.
		tags: !inPanel,
		duration: !!rest.showDuration,
		action: rest.renderAction !== undefined,
	};
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
			<div className="select-none">
				<HeaderRow layout={layout} sort={sort} onSort={onSort} />
				<div
					role="listbox"
					aria-multiselectable
					aria-label="Songs"
					tabIndex={-1}
					className="space-y-px pt-1 outline-none"
					onKeyDown={onKeyDown}
				>
					{tracks.map((track, i) => (
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
			</div>
		</TrackOrderContext.Provider>
	);
}
