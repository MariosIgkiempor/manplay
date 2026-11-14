import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPlus } from "lucide-react";
import { SearchSubmenu } from "#/components/search-submenu.tsx";
import { useUndo } from "#/context/undo-context.ts";
import {
	addToPlaylist,
	createPlaylist,
	listPlaylists,
	playlistTracks,
	type Track,
} from "#/lib/api.ts";
import { undoAddToPlaylist } from "#/lib/undo-entries.ts";

/** Right-click "Add to playlist" submenu: search playlists or create one; stays open for more. */
export function PlaylistSubmenu({ tracks }: { tracks: readonly Track[] }) {
	const queryClient = useQueryClient();
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });
	const { record } = useUndo();
	const ids = tracks.map((t) => t.id);
	const add = useMutation({
		mutationFn: async ({ name, isNew }: { name: string; isNew: boolean }) => {
			const existing = playlists.data?.find((p) => p.name.toLowerCase() === name.toLowerCase());
			const created = isNew && !existing;
			const id = created ? await createPlaylist(name) : existing?.id;
			if (id === undefined) {
				return;
			}
			const already = created
				? new Set<number>()
				: new Set((await playlistTracks(id)).map((t) => t.id));
			await addToPlaylist(id, ids);
			const entry = undoAddToPlaylist(
				id,
				existing?.name ?? name,
				ids.filter((t) => !already.has(t)),
				created,
			);
			if (entry) {
				record(entry);
			}
		},
		onSettled: async () => {
			await queryClient.invalidateQueries({ queryKey: ["playlists"] });
			await queryClient.invalidateQueries({ queryKey: ["playlist-tracks"] });
		},
	});

	return (
		<SearchSubmenu
			label="Add to playlist"
			icon={ListPlus}
			placeholder="Search or create playlist…"
			emptyHint="Type a name to create a playlist."
			items={(playlists.data ?? []).map((p) => ({
				name: p.name,
				count: p.trackCount,
				checked: false,
			}))}
			onPick={(name, isNew) => add.mutate({ name, isNew })}
		/>
	);
}
