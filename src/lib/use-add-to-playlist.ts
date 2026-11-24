import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useUndo } from "#/context/undo-context.ts";
import {
	addToPlaylist,
	createPlaylist,
	listPlaylists,
	playlistTracks,
	type Track,
} from "#/lib/api.ts";
import { undoAddToPlaylist } from "#/lib/undo-entries.ts";

/**
 * The library's playlists, and adding `tracks` to one by name: an existing one, or a new one made
 * for them. Each add can be undone.
 */
export function useAddToPlaylist(tracks: readonly Track[]) {
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

	return {
		playlists: playlists.data ?? [],
		add: (name: string, isNew: boolean) => add.mutate({ name, isNew }),
	};
}
