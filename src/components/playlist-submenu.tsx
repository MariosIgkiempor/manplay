import { ListPlus } from "lucide-react";
import { SearchSubmenu } from "#/components/search-submenu.tsx";
import type { Track } from "#/lib/api.ts";
import { useAddToPlaylist } from "#/lib/use-add-to-playlist.ts";

/** Right-click "Add to playlist" submenu: search playlists or create one; stays open for more. */
export function PlaylistSubmenu({ tracks }: { tracks: readonly Track[] }) {
	const { playlists, add } = useAddToPlaylist(tracks);
	return (
		<SearchSubmenu
			label="Add to playlist"
			icon={ListPlus}
			placeholder="Search or create playlist…"
			emptyHint="Type a name to create a playlist."
			items={playlists.map((p) => ({
				name: p.name,
				count: p.trackCount,
				checked: false,
			}))}
			onPick={add}
		/>
	);
}
