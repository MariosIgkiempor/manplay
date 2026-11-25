import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { MenuContextTrigger } from "@ui-sdk/react/menu";
import {
	AudioWaveform,
	Copy,
	Disc3,
	FolderOpen,
	Grid3x3,
	ListEnd,
	ListStart,
	Music,
	PencilLine,
	Play,
	TextCursorInput,
	Undo2,
	UserRound,
} from "lucide-react";
import { type ReactNode, useContext, useState } from "react";
import { type MenuEntry, MenuItems, MenuLabel, MenuSeparator } from "#/components/menu.tsx";
import { PlaylistSubmenu } from "#/components/playlist-submenu.tsx";
import { TagSubmenu } from "#/components/tag-submenu.tsx";
import { ContextMenuPopup, MenuRoot } from "#/components/ui/popup.tsx";
import { useDetailNav } from "#/context/detail-context.ts";
import { usePlayer } from "#/context/player-context.ts";
import { TrackOrderContext } from "#/context/track-order.ts";
import { albumKey } from "#/lib/albums.ts";
import { fsReveal, type Track } from "#/lib/api.ts";
import { loadForEditing } from "#/lib/load-for-editing.ts";
import { popup } from "#/lib/menu-styles.ts";
import { FILE_MANAGER } from "#/lib/platform.ts";
import { ANALYSIS_KEY, useAnalyze, useRedetect } from "#/lib/queries.ts";
import { tagTargetFor } from "#/lib/tag-target.ts";
import { useShortcutLabel } from "#/lib/use-shortcuts.ts";

interface Props {
	/** Tracks the menu acts on; read when a menu item is chosen. */
	tracks: readonly Track[];
	/** Menu heading, e.g. "3 songs" or the album name. */
	label: string;
	/** Replaces the default "Play" (which plays `tracks` from the first). */
	onPlay?: (() => void) | undefined;
	/** Offers "Rename" (one song, renamed in place in the list). */
	onRename?: (() => void) | undefined;
	/** Items for where the menu is, e.g. "Remove from playlist", shown last. */
	extra?: readonly MenuEntry[] | undefined;
	/** Hide "Go to album" / "Go to artist", e.g. on the album's own panel. */
	noGoTo?: boolean;
	children: ReactNode;
}

/** The one album and the one artist the songs share, if they share one. */
function shared(tracks: readonly Track[]) {
	const first = tracks[0];
	if (!first) {
		return { album: null, artist: null };
	}
	const oneAlbum = tracks.every((t) => t.album === first.album && t.artist === first.artist);
	const oneArtist = tracks.every((t) => t.artist === first.artist);
	return {
		album: oneAlbum && first.album !== "" ? albumKey(first.artist, first.album) : null,
		artist: oneArtist && first.artist !== "" ? first.artist : null,
	};
}

/** For one song: find its file, and copy its name to paste elsewhere (a set list, a search). */
function fileEntries(song: Track): MenuEntry[] {
	return [
		{
			label: `Show in ${FILE_MANAGER}`,
			icon: <FolderOpen />,
			onSelect: () => void fsReveal(song.path),
		},
		{
			label: "Copy artist and title",
			icon: <Copy />,
			onSelect: () =>
				void navigator.clipboard.writeText(
					song.artist === "" ? song.title : `${song.artist} - ${song.title}`,
				),
		},
	];
}

/**
 * Wraps `children` so a right-click offers what can be done to `tracks`: play, add to a playlist,
 * tag, rename, edit metadata, analyze, and go to their album or artist.
 *
 * Grids and lists wrap hundreds of rows in one each, so the menu's items (and the hooks they read)
 * are built only once the menu first opens, not as the page draws.
 */
export function AddToPlaylistMenu({ children, ...menu }: Props) {
	const [opened, setOpened] = useState(false);
	return (
		<MenuRoot
			onOpenChange={(next) => {
				if (next) {
					setOpened(true);
				}
			}}
		>
			<MenuContextTrigger>{children}</MenuContextTrigger>
			{opened && <TrackMenuPopup {...menu} />}
		</MenuRoot>
	);
}

/** The menu itself, drawn from the first time it opens. */
function TrackMenuPopup({
	tracks,
	label,
	onPlay,
	onRename,
	extra,
	noGoTo = false,
}: Omit<Props, "children">) {
	const go = useDetailNav();
	const order = useContext(TrackOrderContext);
	const player = usePlayer();
	const queryClient = useQueryClient();
	const keyOf = (shortcut: string | null) => (shortcut === null ? {} : { shortcut });
	const playNextKey = keyOf(useShortcutLabel("listPlayNext"));
	const queueKey = keyOf(useShortcutLabel("listQueue"));
	const editKey = keyOf(useShortcutLabel("listEdit"));
	const analyze = useAnalyze();
	const redetect = useRedetect();
	const hasEdits = tracks.some((t) => t.edited.bpm || t.edited.key || t.edited.grid);
	const analyzing = useIsMutating({ mutationKey: ANALYSIS_KEY }) > 0;
	const { album, artist } = noGoTo ? { album: null, artist: null } : shared(tracks);
	const target = tagTargetFor(tracks);
	const song = tracks.length === 1 ? tracks[0] : undefined;
	const edits: MenuEntry[] = [
		onRename && {
			label: "Rename",
			icon: <PencilLine />,
			shortcut: "F2",
			onSelect: onRename,
		},
		song && {
			label: "Open song",
			icon: <Music />,
			onSelect: () => go({ kind: "song", trackId: song.id, list: order ?? undefined }),
		},
		target && {
			label: "Edit metadata…",
			icon: <TextCursorInput />,
			...editKey,
			onSelect: () =>
				song
					? go({ kind: "song", trackId: song.id, list: order ?? undefined })
					: go({ kind: "edit", target }),
		},
		song && {
			label: "Edit grid & cues…",
			icon: <Grid3x3 />,
			onSelect: () => {
				const all = queryClient.getQueryData<readonly Track[]>(["tracks"]) ?? [song];
				loadForEditing(player, song, order ?? undefined, all);
			},
		},
		{
			label: "Analyze BPM & key",
			icon: <AudioWaveform />,
			disabled: analyzing,
			onSelect: () => analyze.mutate(tracks.map((t) => t.id)),
		},
		hasEdits && {
			label: "Discard my BPM, key & grid edits",
			icon: <Undo2 />,
			destructive: true,
			disabled: analyzing,
			onSelect: () => redetect.mutate(tracks.map((t) => t.id)),
		},
		"separator",
		album !== null && {
			label: "Go to album",
			icon: <Disc3 />,
			onSelect: () => go({ kind: "album", key: album }),
		},
		artist !== null && {
			label: "Go to artist",
			icon: <UserRound />,
			onSelect: () => go({ kind: "artist", name: artist }),
		},
		"separator",
		...(song ? fileEntries(song) : []),
		"separator",
		...(extra ?? []),
	];
	return (
		// Focus stays where the chosen item put it, e.g. in a rename field it opened.
		<ContextMenuPopup className={popup} finalFocus="none">
			<MenuLabel>{label}</MenuLabel>
			<MenuItems
				items={[
					{
						label: "Play",
						icon: <Play />,
						disabled: tracks.length === 0,
						onSelect: onPlay ?? (() => player.play(tracks, 0)),
					},
					{
						label: "Play next",
						icon: <ListStart />,
						disabled: tracks.length === 0,
						...playNextKey,
						onSelect: () => player.playNext(tracks),
					},
					{
						label: "Add to queue",
						icon: <ListEnd />,
						disabled: tracks.length === 0,
						...queueKey,
						onSelect: () => player.addToQueue(tracks),
					},
				]}
			/>
			<MenuSeparator />
			<PlaylistSubmenu tracks={tracks} />
			<TagSubmenu tracks={tracks} />
			<MenuSeparator />
			<MenuItems items={edits} />
		</ContextMenuPopup>
	);
}
