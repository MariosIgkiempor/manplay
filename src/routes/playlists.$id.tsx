import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ListMusic } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { PageHeader } from "#/components/page-header.tsx";
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
import { duration } from "#/lib/format.ts";
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

	const [confirming, setConfirming] = useState(false);
	const list = tracks.data ?? [];
	const seconds = list.reduce((n, t) => n + (t.durationMs ?? 0), 0) / 1000;

	return (
		<main>
			<PageHeader
				kind={
					<>
						<ListMusic className="size-3.5" /> Playlist
					</>
				}
				title={playlist?.name ?? "Playlist"}
				meta={
					<>
						<span>
							{list.length} {list.length === 1 ? "song" : "songs"}
						</span>
						{seconds >= 1 && <span>{duration(seconds)}</span>}
					</>
				}
				tracks={list}
				fallbackIcon={<ListMusic className="size-10" />}
				onRename={(name) => rename.mutate(name)}
				onDelete={() => setConfirming(true)}
			/>
			<div className="space-y-3 p-6">
				{[remove, rename, destroy].map(
					(m) =>
						m.isError && (
							<p key={m.submittedAt} className="text-destructive text-sm">
								{String(m.error)}
							</p>
						),
				)}
				{list.length === 0 && !tracks.isPending ? (
					<p className="text-muted-foreground text-sm">
						This playlist is empty. Add songs from a song’s right-click menu in the library.
					</p>
				) : (
					<SelectableTrackList
						tracks={list}
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
				)}
			</div>
			{confirming && (
				<ConfirmDialog
					title={`Delete playlist “${playlist?.name ?? ""}”?`}
					confirmLabel="Delete playlist"
					destructive
					busy={destroy.isPending}
					onCancel={() => setConfirming(false)}
					onConfirm={() => {
						setConfirming(false);
						destroy.mutate();
					}}
				>
					The songs stay in your library.
				</ConfirmDialog>
			)}
		</main>
	);
}
