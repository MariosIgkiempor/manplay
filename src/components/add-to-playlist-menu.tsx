import { ContextMenu } from "@base-ui/react/context-menu";
import { useIsMutating } from "@tanstack/react-query";
import {
	AudioWaveform,
	Disc3,
	Grid3x3,
	PencilLine,
	Play,
	TextCursorInput,
	UserRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { type MenuEntry, MenuItems, MenuLabel, MenuSeparator } from "#/components/menu.tsx";
import { PlaylistSubmenu } from "#/components/playlist-submenu.tsx";
import { TagSubmenu } from "#/components/tag-submenu.tsx";
import { useDetailNav } from "#/context/detail-context.ts";
import { usePlayer } from "#/context/player-context.ts";
import { albumKey } from "#/lib/albums.ts";
import type { Track } from "#/lib/api.ts";
import { popup } from "#/lib/menu-styles.ts";
import { ANALYSIS_KEY, useAnalyze } from "#/lib/queries.ts";
import { tagTargetFor } from "#/lib/tag-target.ts";

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

/**
 * Wraps `children` so a right-click offers what can be done to `tracks`: play, add to a playlist,
 * tag, rename, edit metadata, analyze, and go to their album or artist.
 */
export function AddToPlaylistMenu({
	tracks,
	label,
	onPlay,
	onRename,
	extra,
	noGoTo = false,
	children,
}: Props) {
	const go = useDetailNav();
	const player = usePlayer();
	const analyze = useAnalyze();
	const analyzing = useIsMutating({ mutationKey: ANALYSIS_KEY }) > 0;
	const { album, artist } = noGoTo ? { album: null, artist: null } : shared(tracks);
	const target = tagTargetFor(tracks);
	const edits: MenuEntry[] = [
		onRename && {
			label: "Rename",
			icon: <PencilLine />,
			shortcut: "F2",
			onSelect: onRename,
		},
		target && {
			label: "Edit metadata…",
			icon: <TextCursorInput />,
			onSelect: () => go({ kind: "edit", target }),
		},
		tracks.length === 1 &&
			tracks[0]?.analyzed && {
				label: "Edit beat grid…",
				icon: <Grid3x3 />,
				onSelect: () => go({ kind: "grid", trackId: tracks[0]?.id ?? 0 }),
			},
		{
			label: "Analyze BPM & key",
			icon: <AudioWaveform />,
			disabled: analyzing,
			onSelect: () => analyze.mutate(tracks.map((t) => t.id)),
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
		...(extra ?? []),
	];
	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger>{children}</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Positioner className="z-50">
					{/* Focus stays where the chosen item put it, e.g. in a rename field it opened. */}
					<ContextMenu.Popup className={popup} finalFocus={false}>
						<MenuLabel>{label}</MenuLabel>
						<MenuItems
							items={[
								{
									label: "Play",
									icon: <Play />,
									disabled: tracks.length === 0,
									onSelect: onPlay ?? (() => player.play(tracks, 0)),
								},
							]}
						/>
						<MenuSeparator />
						<PlaylistSubmenu tracks={tracks} />
						<TagSubmenu tracks={tracks} />
						<MenuSeparator />
						<MenuItems items={edits} />
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}
