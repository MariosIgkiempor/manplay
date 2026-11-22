import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ListMusic, ListX, X } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { useJellyfinMenu } from "#/components/jellyfin-menu.tsx";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { CollectionHeader } from "#/components/page-header.tsx";
import {
	HeaderSongSort,
	SelectableTrackList,
	useSongSort,
} from "#/components/selectable-track-list.tsx";
import { SharingControl } from "#/components/sharing-control.tsx";
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
		mutationFn: async (trackIds: readonly number[]) => {
			for (const trackId of trackIds) {
				await removeFromPlaylist(playlistId, trackId);
				record(undoRemoveFromPlaylist(playlistId, playlist?.name ?? "playlist", trackId));
			}
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
	const jellyfinMenu = useJellyfinMenu(playlist ? { kind: "playlist", id: playlist.id } : null);
	const seconds = list.reduce((n, t) => n + (t.durationMs ?? 0), 0) / 1000;
	const sort = useSongSort(list, "Playlist order");

	return (
		<main>
			<CollectionHeader
				sort={<HeaderSongSort songs={list.length} sort={sort} />}
				title={playlist?.name ?? "Playlist"}
				meta={
					<>
						<span>
							{list.length} {list.length === 1 ? "song" : "songs"}
						</span>
						{seconds >= 1 && <span>{duration(seconds)}</span>}
					</>
				}
				tracks={sort.sorted}
				fallbackIcon={<ListMusic className="size-10" />}
				onRename={(name) => rename.mutate(name)}
				onDelete={() => setConfirming(true)}
				menuExtra={jellyfinMenu}
				sharing={
					<SharingControl
						item={
							playlist
								? {
										kind: "playlist",
										id: playlist.id,
										name: playlist.name,
										scope: playlist.scope ?? "shared",
									}
								: null
						}
					/>
				}
			/>
			<div className="space-y-3 p-6">
				{[remove, rename, destroy].map(
					(m) => m.isError && <ErrorLine key={m.submittedAt}>{String(m.error)}</ErrorLine>,
				)}
				{list.length === 0 && !tracks.isPending ? (
					<EmptyState icon={<ListMusic />} title="This playlist is empty">
						Right-click songs in the library to add them.
					</EmptyState>
				) : (
					<SelectableTrackList
						tracks={list}
						listOrder="Playlist order"
						sort={sort.sort}
						onSortChange={sort.setSort}
						hideSortMenu
						menuExtra={(ts) => [
							{
								label:
									ts.length === 1 ? "Remove from playlist" : `Remove ${ts.length} from playlist`,
								icon: <ListX />,
								destructive: true,
								onSelect: () => remove.mutate(ts.map((t) => t.id)),
							},
						]}
						renderAction={(t) => (
							// Shown on hover or focus, so a long playlist is not a column of "Remove".
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`Remove ${t.title} from playlist`}
								title="Remove from playlist"
								className="text-muted-foreground opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
								onClick={(e) => {
									e.stopPropagation();
									remove.mutate([t.id]);
								}}
							>
								<X />
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
