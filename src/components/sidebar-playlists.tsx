import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { Copy, ListMusic, PencilLine, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { InlineInput } from "#/components/inline-edit.tsx";
import { RowMenu } from "#/components/menu.tsx";
import { RowCount, SectionLabel } from "#/components/sidebar-parts.tsx";
import { rowBase, rowClass } from "#/components/sidebar-row.ts";
import { usePlayer } from "#/context/player-context.ts";
import {
	addToPlaylist,
	createPlaylist,
	deletePlaylist,
	listPlaylists,
	type Playlist,
	playlistTracks,
	renamePlaylist,
} from "#/lib/api.ts";

const nonBlank = (v: string) => (v.trim() === "" ? null : v.trim());

/** The first free "<name> copy", "<name> copy 2", … */
function copyName(name: string, taken: readonly Playlist[]): string {
	const names = new Set(taken.map((p) => p.name.toLowerCase()));
	let candidate = `${name} copy`;
	for (let n = 2; names.has(candidate.toLowerCase()); n++) {
		candidate = `${name} copy ${n}`;
	}
	return candidate;
}

function usePlaylistActions() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const player = usePlayer();
	const refresh = () => queryClient.invalidateQueries({ queryKey: ["playlists"] });
	const songsOf = (id: number) =>
		queryClient.fetchQuery({
			queryKey: ["playlist-tracks", id],
			queryFn: () => playlistTracks(id),
		});
	return {
		play: async (p: Playlist) => player.play(await songsOf(p.id), 0),
		rename: useMutation({
			mutationFn: ({ id, name }: { id: number; name: string }) => renamePlaylist(id, name),
			onSettled: refresh,
		}),
		duplicate: useMutation({
			mutationFn: async ({ p, all }: { p: Playlist; all: readonly Playlist[] }) => {
				const songs = await songsOf(p.id);
				const id = await createPlaylist(copyName(p.name, all));
				await addToPlaylist(
					id,
					songs.map((t) => t.id),
				);
				return id;
			},
			onSuccess: async (id) => {
				await refresh();
				await navigate({ to: "/playlists/$id", params: { id: String(id) } });
			},
		}),
		remove: useMutation({
			mutationFn: (id: number) => deletePlaylist(id),
			onSuccess: async (_, id) => {
				queryClient.removeQueries({ queryKey: ["playlist-tracks", id] });
				await refresh();
			},
		}),
	};
}

/** Library playlists in the sidebar; right-click one to play, rename, duplicate or delete it. */
export function SidebarPlaylists() {
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });
	const actions = usePlaylistActions();
	const [renaming, setRenaming] = useState<number | null>(null);
	const [deleting, setDeleting] = useState<Playlist | null>(null);
	const all = playlists.data ?? [];
	const m = matchRoute({ to: "/playlists/$id" });
	const active = m ? Number(m.id) : null;
	const error = [actions.rename, actions.duplicate, actions.remove].find((x) => x.isError)?.error;

	return (
		<section className="space-y-0.5">
			<SectionLabel>Playlists</SectionLabel>
			{all.map((p) => (
				<RowMenu
					key={p.id}
					label={p.name}
					items={[
						{
							label: "Play",
							icon: <Play />,
							disabled: p.trackCount === 0,
							onSelect: () => void actions.play(p),
						},
						"separator",
						{ label: "Rename", icon: <PencilLine />, onSelect: () => setRenaming(p.id) },
						{
							label: "Duplicate",
							icon: <Copy />,
							disabled: actions.duplicate.isPending,
							onSelect: () => actions.duplicate.mutate({ p, all }),
						},
						"separator",
						{
							label: "Delete…",
							icon: <Trash2 />,
							destructive: true,
							onSelect: () => setDeleting(p),
						},
					]}
				>
					<div className={rowClass(active === p.id)}>
						{renaming === p.id ? (
							<div className="flex min-w-0 flex-1 items-center gap-2 py-0.5 pl-2">
								<ListMusic className="size-4 shrink-0 text-muted-foreground" />
								<InlineInput
									initial={p.name}
									label={`Rename ${p.name}`}
									parse={nonBlank}
									onCancel={() => setRenaming(null)}
									onCommit={(name) => {
										setRenaming(null);
										actions.rename.mutate({ id: p.id, name });
									}}
								/>
							</div>
						) : (
							<Link
								to="/playlists/$id"
								params={{ id: String(p.id) }}
								className={rowBase}
								onDoubleClick={() => setRenaming(p.id)}
							>
								<ListMusic className="size-4 shrink-0" />
								<span className="truncate">{p.name}</span>
								<RowCount n={p.trackCount} />
							</Link>
						)}
						<span className="size-5 shrink-0" />
					</div>
				</RowMenu>
			))}
			{error && <p className="px-2 text-destructive text-xs">{String(error)}</p>}
			{deleting && (
				<ConfirmDialog
					title={`Delete playlist “${deleting.name}”?`}
					confirmLabel="Delete playlist"
					destructive
					onCancel={() => setDeleting(null)}
					onConfirm={() => {
						const { id } = deleting;
						setDeleting(null);
						actions.remove.mutate(id, {
							onSuccess: () => active === id && void navigate({ to: "/" }),
						});
					}}
				>
					The songs stay in your library.
				</ConfirmDialog>
			)}
		</section>
	);
}
