import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useUndo } from "#/context/undo-context.ts";
import {
	deletePlaylist,
	listPlaylists,
	playlistTracks,
	removeFromPlaylist,
	renamePlaylist,
} from "#/lib/api.ts";
import { undoRemoveFromPlaylist } from "#/lib/undo-entries.ts";

export const Route = createFileRoute("/playlists/$id")({ component: PlaylistPage });

function PlaylistPage() {
	const { id } = Route.useParams();
	const playlistId = Number(id);
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { record } = useUndo();

	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });
	const tracks = useQuery({
		queryKey: ["playlist-tracks", playlistId],
		queryFn: () => playlistTracks(playlistId),
	});
	const playlist = playlists.data?.find((p) => p.id === playlistId);

	const refresh = async () => {
		await queryClient.invalidateQueries({ queryKey: ["playlists"] });
		await queryClient.invalidateQueries({ queryKey: ["playlist-tracks", playlistId] });
	};
	const remove = useMutation({
		mutationFn: async (trackId: number) => {
			await removeFromPlaylist(playlistId, trackId);
			record(undoRemoveFromPlaylist(playlistId, playlist?.name ?? "playlist", trackId));
		},
		onSuccess: refresh,
	});
	const rename = useMutation({
		mutationFn: (name: string) => renamePlaylist(playlistId, name),
		onSuccess: refresh,
	});
	const destroy = useMutation({
		mutationFn: () => deletePlaylist(playlistId),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["playlists"] });
			await navigate({ to: "/" });
		},
	});

	const onRename = () => {
		const name = window.prompt("Rename playlist", playlist?.name ?? "")?.trim();
		if (name !== undefined && name !== "") {
			rename.mutate(name);
		}
	};

	return (
		<main className="space-y-4 p-6">
			<header className="flex items-center justify-between gap-4">
				<h1 className="font-semibold text-xl">
					{playlist?.name ?? "Playlist"} ({tracks.data?.length ?? 0})
				</h1>
				<div className="flex gap-2">
					<Button variant="outline" onClick={onRename}>
						Rename
					</Button>
					<Button
						variant="outline"
						onClick={() => {
							if (window.confirm("Delete playlist? Tracks stay in your library.")) {
								destroy.mutate();
							}
						}}
					>
						Delete
					</Button>
				</div>
			</header>
			{[remove, rename, destroy].map(
				(m) =>
					m.isError && (
						<p key={m.submittedAt} className="text-destructive text-sm">
							{String(m.error)}
						</p>
					),
			)}
			<SelectableTrackList
				tracks={tracks.data ?? []}
				renderAction={(t) => (
					<Button
						variant="ghost"
						size="sm"
						onClick={(e) => {
							e.stopPropagation();
							remove.mutate(t.id);
						}}
					>
						Remove
					</Button>
				)}
			/>
		</main>
	);
}
