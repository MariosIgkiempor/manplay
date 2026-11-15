import { ContextMenu } from "@base-ui/react/context-menu";
import { useIsMutating } from "@tanstack/react-query";
import { AudioWaveform, TextCursorInput } from "lucide-react";
import type { ReactNode } from "react";
import { PlaylistSubmenu } from "#/components/playlist-submenu.tsx";
import { TagSubmenu } from "#/components/tag-submenu.tsx";
import { useDetailNav } from "#/context/detail-context.ts";
import type { Track } from "#/lib/api.ts";
import { ANALYSIS_KEY, useAnalyze } from "#/lib/queries.ts";
import { tagTargetFor } from "#/lib/tag-target.ts";

const menuItem =
	"flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-muted";
const popup =
	"z-50 min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground text-sm shadow-lg outline-none";

interface Props {
	/** Tracks the menu acts on; read when a menu item is chosen. */
	tracks: readonly Track[];
	/** Menu heading, e.g. "3 songs" or the album name. */
	label: string;
	children: ReactNode;
}

/**
 * Wraps `children` so a right-click offers "Add to playlist", "Tag", "Edit metadata" and
 * "Analyze BPM & key" for `tracks`.
 */
export function AddToPlaylistMenu({ tracks, label, children }: Props) {
	const go = useDetailNav();
	const analyze = useAnalyze();
	const analyzing = useIsMutating({ mutationKey: ANALYSIS_KEY }) > 0;
	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger>{children}</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Positioner className="z-50">
					<ContextMenu.Popup className={popup}>
						<div className="max-w-64 truncate px-2 py-1 text-muted-foreground text-xs">{label}</div>
						<PlaylistSubmenu tracks={tracks} />
						<TagSubmenu tracks={tracks} />
						<ContextMenu.Item
							className={menuItem}
							onClick={() => {
								const target = tagTargetFor(tracks);
								if (target) {
									go({ kind: "edit", target });
								}
							}}
						>
							<TextCursorInput className="size-4" /> Edit metadata…
						</ContextMenu.Item>
						<ContextMenu.Item
							className={`${menuItem} data-[disabled]:opacity-50`}
							disabled={analyzing}
							onClick={() => analyze.mutate(tracks.map((t) => t.id))}
						>
							<AudioWaveform className="size-4" /> Analyze BPM &amp; key
						</ContextMenu.Item>
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}
