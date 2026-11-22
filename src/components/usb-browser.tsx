import { Menu } from "@base-ui/react/menu";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	Folder,
	FolderInput,
	FolderPlus,
	ListMusic,
	ListPlus,
	ListX,
	Music,
	PencilLine,
	Plus,
	Trash2,
	X,
} from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { InlineInput } from "#/components/inline-edit.tsx";
import { type MenuEntry, RowMenu } from "#/components/menu.tsx";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { Cover } from "#/components/page-header.tsx";
import { PanelHeader } from "#/components/panel-header.tsx";
import { TrackList } from "#/components/track-list.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	type Track,
	type UsbEdit,
	type UsbLibrary,
	type UsbPlaylist,
	type UsbTrack,
	usbEditPlaylists,
} from "#/lib/api.ts";
import { duration } from "#/lib/format.ts";
import { useTracks } from "#/lib/queries.ts";
import { freeName, moveTargets, playlistTree, usbAsTracks, within } from "#/lib/usb-library.ts";
import { cn } from "#/lib/utils.ts";

type View = { kind: "all" } | { kind: "playlist"; id: number };

const plural = (n: number, one: string, many: string) =>
	`${n.toLocaleString()} ${n === 1 ? one : many}`;
const nonBlank = (v: string) => (v.trim() === "" ? null : v.trim());

/** The height of an element, kept up to date as it wraps or changes; 0 while it is not there. */
function useHeight(ref: RefObject<HTMLElement | null>): number {
	const [height, setHeight] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) {
			setHeight(0);
			return;
		}
		const measure = () => setHeight(el.offsetHeight);
		measure();
		const watch = new ResizeObserver(measure);
		watch.observe(el);
		return () => watch.disconnect();
	});
	return height;
}

/** Sends one edit to the drive and shows the library it returns straight away. */
function useUsbEdit(mount: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (edit: UsbEdit) => usbEditPlaylists(mount, edit),
		onSuccess: async () => {
			// Every library on the drive follows the edit, so all of them are read again.
			for (const key of ["usb-library", "usb-formats", "usb-drives"]) {
				await queryClient.invalidateQueries({ queryKey: [key] });
			}
		},
	});
}

/**
 * A drive's rekordbox library: playlists on the left, their songs on the right. With `editable`,
 * playlists and folders can be created, renamed, moved and deleted, and songs taken out of a
 * playlist; right-click for everything, double-click a name to rename it.
 */
export function UsbBrowser({
	mount,
	library,
	editable,
	query,
	filter,
}: {
	mount: string;
	library: UsbLibrary;
	editable: boolean;
	/** Filters the songs shown by title, artist or album; typed in the page's tab row. */
	query: string;
	/** Which of the drive's libraries is shown, as a row above the columns. */
	filter?: ReactNode;
}) {
	const [view, setView] = useState<View>({ kind: "all" });
	const [renaming, setRenaming] = useState<number | null>(null);
	const [deleting, setDeleting] = useState<UsbPlaylist | null>(null);
	const edit = useUsbEdit(mount);
	const filterRef = useRef<HTMLDivElement>(null);
	const filterHeight = useHeight(filterRef);
	const byId = useMemo(() => new Map(library.tracks.map((t) => [t.id, t])), [library.tracks]);
	const playlist =
		view.kind === "playlist" ? library.playlists.find((p) => p.id === view.id) : undefined;
	const tracks = playlist ? playlist.trackIds.flatMap((id) => byId.get(id) ?? []) : library.tracks;

	const create = (parentId: number, folder: boolean) => {
		const name = freeName(library.playlists, parentId, folder ? "New folder" : "New playlist");
		edit.mutate(
			{ kind: "create", parentId, name, folder },
			{
				onSuccess: ({ created }) => {
					if (created !== null) {
						setRenaming(created);
						if (!folder) {
							setView({ kind: "playlist", id: created });
						}
					}
				},
			},
		);
	};
	const actions: PlaylistActions = {
		editable: editable && !edit.isPending,
		library,
		create,
		rename: (p) => setRenaming(p.id),
		move: (p, parentId) => edit.mutate({ kind: "move", id: p.id, parentId }),
		remove: setDeleting,
	};

	return (
		<div
			className="flex flex-col"
			style={{ "--filter-height": `${filterHeight}px` } as CSSProperties}
		>
			{edit.isError && (
				<div className="shrink-0 px-6 pt-3">
					<ErrorLine>{String(edit.error)}</ErrorLine>
				</div>
			)}
			{filter && (
				// Pinned under the tabs too; the playlists pin under it (`--filter-height`).
				<div
					ref={filterRef}
					className="sticky top-[var(--pinned-header,0px)] z-10 border-hairline border-b bg-background px-6 py-2.5"
				>
					{filter}
				</div>
			)}
			{/* The songs scroll with the page; the playlists stay pinned beside them, under the tabs,
			    and scroll on their own when there are many. */}
			<div className="flex items-start">
				<div className="sticky top-[calc(var(--pinned-header,0px)+var(--filter-height,0px))] flex h-[calc(var(--page-height,100vh)-var(--pinned-header,0px)-var(--filter-height,0px))] w-60 shrink-0 flex-col border-hairline border-r">
					<div className="flex shrink-0 items-center justify-between pt-3 pr-3 pb-1 pl-5">
						<span className="font-medium text-muted-foreground/70 text-xs">Playlists</span>
						{editable && <NewMenu disabled={edit.isPending} onCreate={(f) => create(0, f)} />}
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
						<PlaylistNav
							library={library}
							view={view}
							onView={setView}
							renaming={renaming}
							onRenamed={(p, name) => {
								setRenaming(null);
								if (name !== null) {
									edit.mutate({ kind: "rename", id: p.id, name });
								}
							}}
							actions={actions}
						/>
					</div>
				</div>
				<div className="min-w-0 flex-1 px-6 pt-5 pb-6">
					<SongsView
						mount={mount}
						songs={tracks}
						title={playlist?.name ?? "All tracks"}
						isPlaylist={playlist !== undefined}
						query={query}
						onRemove={
							playlist && editable
								? (positions) =>
										edit.mutate({ kind: "removeTracks", playlistId: playlist.id, positions })
								: undefined
						}
					/>
				</div>
			</div>
			{deleting && (
				<DeleteConfirm
					playlist={deleting}
					library={library}
					busy={edit.isPending}
					onCancel={() => setDeleting(null)}
					onConfirm={() => {
						const { id } = deleting;
						setDeleting(null);
						if (view.kind === "playlist" && within(library.playlists, id).has(view.id)) {
							setView({ kind: "all" });
						}
						edit.mutate({ kind: "delete", id });
					}}
				/>
			)}
		</div>
	);
}

/** New playlist or folder at the top level, from the + by the column's heading. */
function NewMenu({
	disabled,
	onCreate,
}: {
	disabled: boolean;
	onCreate: (folder: boolean) => void;
}) {
	const item =
		"flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted [&_svg]:size-4 [&_svg]:text-muted-foreground";
	return (
		<Menu.Root>
			<Menu.Trigger
				disabled={disabled}
				aria-label="New playlist or folder"
				title="New playlist or folder"
				className="grid size-5 place-items-center rounded text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40 data-[popup-open]:bg-foreground/[0.06] [&_svg]:size-3.5"
			>
				<Plus />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner sideOffset={4} align="end" className="z-50">
					<Menu.Popup className="w-44 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
						<Menu.Item className={item} onClick={() => onCreate(false)}>
							<ListPlus /> New playlist
						</Menu.Item>
						<Menu.Item className={item} onClick={() => onCreate(true)}>
							<FolderPlus /> New folder
						</Menu.Item>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

interface PlaylistActions {
	editable: boolean;
	library: UsbLibrary;
	create: (parentId: number, folder: boolean) => void;
	rename: (p: UsbPlaylist) => void;
	move: (p: UsbPlaylist, parentId: number) => void;
	remove: (p: UsbPlaylist) => void;
}

function menuFor(p: UsbPlaylist, a: PlaylistActions): MenuEntry[] {
	const targets = moveTargets(a.library.playlists, p.id);
	return [
		p.isFolder && {
			label: "New playlist inside",
			icon: <ListPlus />,
			disabled: !a.editable,
			onSelect: () => a.create(p.id, false),
		},
		p.isFolder && {
			label: "New folder inside",
			icon: <FolderPlus />,
			disabled: !a.editable,
			onSelect: () => a.create(p.id, true),
		},
		"separator",
		{ label: "Rename", icon: <PencilLine />, disabled: !a.editable, onSelect: () => a.rename(p) },
		{
			label: "Move to",
			icon: <FolderInput />,
			disabled: !a.editable || targets.length === 0,
			items: targets.map((t) => ({
				label: t.name,
				icon: t.id === 0 ? <ListMusic /> : <Folder />,
				onSelect: () => a.move(p, t.id),
			})),
		},
		"separator",
		{
			label: "Delete…",
			icon: <Trash2 />,
			destructive: true,
			disabled: !a.editable,
			onSelect: () => a.remove(p),
		},
	];
}

function PlaylistNav({
	library,
	view,
	onView,
	renaming,
	onRenamed,
	actions,
}: {
	library: UsbLibrary;
	view: View;
	onView: (v: View) => void;
	renaming: number | null;
	onRenamed: (p: UsbPlaylist, name: string | null) => void;
	actions: PlaylistActions;
}) {
	const tree = useMemo(() => playlistTree(library.playlists), [library.playlists]);
	return (
		<nav aria-label="Playlists on the drive" className="space-y-0.5 text-sm">
			<NavRow
				active={view.kind === "all"}
				onClick={() => onView({ kind: "all" })}
				icon={<Music />}
				label="All tracks"
				count={library.tracks.length}
				depth={0}
			/>
			{tree.map(({ playlist: p, depth }) => (
				<NavEntry
					key={p.id}
					playlist={p}
					depth={depth}
					active={view.kind === "playlist" && view.id === p.id}
					renaming={renaming === p.id}
					onView={onView}
					onRenamed={onRenamed}
					actions={actions}
				/>
			))}
			{tree.length === 0 && (
				<p className="px-2 py-1.5 text-muted-foreground text-xs">No playlists yet</p>
			)}
		</nav>
	);
}

function NavEntry({
	playlist: p,
	depth,
	active,
	renaming,
	onView,
	onRenamed,
	actions,
}: {
	playlist: UsbPlaylist;
	depth: number;
	active: boolean;
	renaming: boolean;
	onView: (v: View) => void;
	onRenamed: (p: UsbPlaylist, name: string | null) => void;
	actions: PlaylistActions;
}) {
	const icon = p.isFolder ? <Folder /> : <ListMusic />;
	return (
		<RowMenu label={p.name} items={menuFor(p, actions)}>
			{renaming ? (
				<div
					className="flex items-center gap-2 py-0.5 pr-1"
					style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
				>
					<span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>
					<InlineInput
						initial={p.name}
						label={`Rename ${p.name}`}
						parse={nonBlank}
						onCancel={() => onRenamed(p, null)}
						onCommit={(name) => onRenamed(p, name)}
					/>
				</div>
			) : (
				<NavRow
					active={active}
					onClick={p.isFolder ? undefined : () => onView({ kind: "playlist", id: p.id })}
					onDoubleClick={actions.editable ? () => actions.rename(p) : undefined}
					icon={icon}
					label={p.name}
					count={p.isFolder ? undefined : p.trackIds.length}
					depth={depth}
				/>
			)}
		</RowMenu>
	);
}

function NavRow({
	active,
	onClick,
	onDoubleClick,
	icon,
	label,
	count,
	depth,
}: {
	active: boolean;
	/** Without it the row is a folder heading. */
	onClick?: (() => void) | undefined;
	onDoubleClick?: (() => void) | undefined;
	icon: ReactNode;
	label: string;
	count?: number | undefined;
	depth: number;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			onDoubleClick={onDoubleClick}
			aria-current={active ? "true" : undefined}
			// The app sidebar's rows: quiet until hovered, the open one on a raised chip.
			className={cn(
				"flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-muted-foreground text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
				onClick ? "hover:bg-foreground/[0.04] hover:text-foreground" : "cursor-default",
				active &&
					"bg-foreground/[0.07] font-medium text-foreground shadow-[inset_0_0_0_1px_oklch(1_0_0/5%)] hover:bg-foreground/[0.07]",
			)}
			style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
		>
			<span className="shrink-0 [&_svg]:size-4">{icon}</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{count !== undefined && <span className="shrink-0 text-xs tabular-nums">{count}</span>}
		</button>
	);
}

function DeleteConfirm({
	playlist,
	library,
	busy,
	onCancel,
	onConfirm,
}: {
	playlist: UsbPlaylist;
	library: UsbLibrary;
	busy: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const inside = within(library.playlists, playlist.id).size - 1;
	const what = playlist.isFolder ? "folder" : "playlist";
	return (
		<ConfirmDialog
			title={`Delete ${what} “${playlist.name}” from the drive?`}
			confirmLabel={`Delete ${what}`}
			destructive
			busy={busy}
			onCancel={onCancel}
			onConfirm={onConfirm}
		>
			{inside > 0 &&
				`${plural(inside, "playlist or folder", "playlists and folders")} inside go too. `}
			The songs stay on the drive.
		</ConfirmDialog>
	);
}

function matches(t: Track, q: string): boolean {
	return [t.title, t.artist, t.album].some((f) => f.toLowerCase().includes(q));
}

/**
 * A playlist (or every song) on the drive, laid out like a library playlist: cover, title,
 * figures and Play, then the same song list. Songs play straight off the drive.
 */
function SongsView({
	mount,
	songs,
	title,
	isPlaylist,
	query,
	onRemove,
}: {
	mount: string;
	songs: readonly UsbTrack[];
	title: string;
	isPlaylist: boolean;
	query: string;
	/** Takes entries out of the shown playlist, by their 0-based place in it. */
	onRemove?: ((positions: number[]) => void) | undefined;
}) {
	const library = useTracks();
	const all = useMemo(
		() => usbAsTracks(songs, mount, library.data ?? []),
		[songs, mount, library.data],
	);
	// Rows keep their place in the playlist, which removal goes by, even while filtered.
	const rows = useMemo(() => all.map((track, slot) => ({ track, slot })), [all]);
	const q = query.trim().toLowerCase();
	const shown = q === "" ? rows : rows.filter((r) => matches(r.track, q));
	const seconds = all.reduce((n, t) => n + (t.durationMs ?? 0), 0) / 1000;
	const slotOf = (i: number) => shown[i]?.slot ?? -1;

	return (
		<div className="min-w-0 space-y-5">
			<PanelHeader
				plain
				kind={
					<>
						{isPlaylist ? <ListMusic /> : <Music />}{" "}
						{isPlaylist ? "Playlist on the drive" : "On the drive"}
					</>
				}
				title={title}
				meta={
					<>
						<span>{plural(all.length, "song", "songs")}</span>
						{seconds >= 1 && <span>{duration(seconds)}</span>}
					</>
				}
				art={
					<Cover
						tracks={all.filter((t) => t.id > 0)}
						fallback={isPlaylist ? <ListMusic className="size-8" /> : <Music className="size-8" />}
						className="size-24"
					/>
				}
				tracks={all}
			/>
			<TrackList
				tracks={shown.map((r) => r.track)}
				targetCount={0}
				rowKey={(_, i) => slotOf(i)}
				rowMenu={(_, i) =>
					onRemove
						? [
								{
									label: "Remove from playlist",
									icon: <ListX />,
									destructive: true,
									onSelect: () => onRemove([slotOf(i)]),
								},
							]
						: []
				}
				renderAction={
					onRemove &&
					((t, i) => (
						<Button
							size="icon-xs"
							variant="ghost"
							aria-label={`Remove ${t.title} from the playlist`}
							title="Remove from playlist"
							className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
							onClick={(e) => {
								e.stopPropagation();
								onRemove([slotOf(i)]);
							}}
						>
							<X />
						</Button>
					))
				}
				empty={<EmptyState title={songs.length === 0 ? "No songs" : "No songs match"} />}
			/>
		</div>
	);
}
