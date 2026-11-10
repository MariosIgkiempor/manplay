import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TrackList } from "#/components/track-list.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	deletePlaylist,
	listPlaylists,
	playlistTracks,
	removeFromPlaylist,
	renamePlaylist,
	untagTrack,
} from "#/lib/api.ts";
import { useSyncTargets } from "#/lib/queries.ts";

export const Route = createFileRoute("/playlists/$id")({ component: PlaylistPage });

function PlaylistPage() {
	const { id } = Route.useParams();
	const playlistId = Number(id);
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });
	const tracks = useQuery({
		queryKey: ["playlist-tracks", playlistId],
		queryFn: () => playlistTracks(playlistId),
	});
	const targets = useSyncTargets();
	const playlist = playlists.data?.find((p) => p.id === playlistId);

	const refresh = async () => {
		await queryClient.invalidateQueries({ queryKey: ["playlists"] });
		await queryClient.invalidateQueries({ queryKey: ["playlist-tracks", playlistId] });
	};
	const remove = useMutation({
		mutationFn: (trackId: number) => removeFromPlaylist(playlistId, trackId),
		onSuccess: refresh,
	});
	const rename = useMutation({
		mutationFn: (name: string) => renamePlaylist(playlistId, name),
		onSuccess: refresh,
	});
	const untag = useMutation({
		mutationFn: ({ name, trackId }: { name: string; trackId: number }) => untagTrack(name, trackId),
		onSuccess: async () => {
			await refresh();
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["tags"] });
		},
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
			{[remove, rename, destroy, untag].map(
				(m) =>
					m.isError && (
						<p key={m.submittedAt} className="text-destructive text-sm">
							{String(m.error)}
						</p>
					),
			)}
			<TrackList
				tracks={tracks.data ?? []}
				targetCount={targets.data?.length ?? 0}
				onRemoveTag={(t, name) => untag.mutate({ name, trackId: t.id })}
				renderAction={(t) => (
					<Button variant="ghost" size="sm" onClick={() => remove.mutate(t.id)}>
						Remove
					</Button>
				)}
			/>
		</main>
	);
}
