import { ContextMenu } from "@base-ui/react/context-menu";
import type { ReactNode } from "react";
import { PlaylistSubmenu } from "#/components/playlist-submenu.tsx";
import { TagSubmenu } from "#/components/tag-submenu.tsx";
import type { Track } from "#/lib/api.ts";

const popup =
	"z-50 min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground text-sm shadow-lg outline-none";

interface Props {
	/** Tracks the menu acts on; read when a menu item is chosen. */
	tracks: readonly Track[];
	/** Menu heading, e.g. "3 songs" or the album name. */
	label: string;
	children: ReactNode;
}

/** Wraps `children` so a right-click offers "Add to playlist" and "Tag" for `tracks`. */
export function AddToPlaylistMenu({ tracks, label, children }: Props) {
	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger>{children}</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Positioner className="z-50">
					<ContextMenu.Popup className={popup}>
						<div className="max-w-64 truncate px-2 py-1 text-muted-foreground text-xs">{label}</div>
						<PlaylistSubmenu tracks={tracks} />
						<TagSubmenu tracks={tracks} />
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}
