import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Copy, ListMusic, PencilLine, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { InlineInput } from "#/components/inline-edit.tsx";
import { HiddenItems, ScopeMark } from "#/components/item-sharing.tsx";
import { RowMenu } from "#/components/menu.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { AddButton, NewRow } from "#/components/sidebar-create.tsx";
import { GroupHeading, RowCount } from "#/components/sidebar-parts.tsx";
import {
	CHILD_PAD,
	HOVER_ACTION,
	pageRow,
	rowBase,
	rowClass,
	useRowMatch,
} from "#/components/sidebar-row.ts";
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
import { useItemSharing, useNewItemScope } from "#/lib/use-item-sharing.tsx";
import { useStoredFlag } from "#/lib/use-pane-width.ts";

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
	const queryClient = useQueryClient();
	const matchRoute = useRowMatch();
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });
	const actions = usePlaylistActions();
	const [renaming, setRenaming] = useState<number | null>(null);
	const [adding, setAdding] = useState(false);
	const [deleting, setDeleting] = useState<Playlist | null>(null);
	const [closed, setClosed] = useStoredFlag("manplay.sidebar.playlistsClosed");
	const sharing = useItemSharing();
	const newScope = useNewItemScope();
	const everything = playlists.data ?? [];
	const all = everything.filter((p) => !p.hidden);
	const hidden = everything.filter((p) => p.hidden);
	const m = matchRoute({ to: "/playlists/$id" });
	const active = m ? Number(m.id) : null;
	const error =
		[actions.rename, actions.duplicate, actions.remove].find((x) => x.isError)?.error ??
		sharing.error;
	const itemOf = (p: Playlist) => ({
		kind: "playlist" as const,
		id: p.id,
		name: p.name,
		scope: p.scope ?? "shared",
	});

	return (
		<div className="space-y-0.5">
			<GroupHeading
				label="Playlists"
				icon={<ListMusic />}
				open={!closed}
				onToggle={() => setClosed(!closed)}
				action={
					<AddButton
						label="New playlist"
						className={HOVER_ACTION}
						onClick={() => {
							setClosed(false);
							setAdding(true);
						}}
					/>
				}
			/>
			{!closed && adding && (
				<NewRow
					icon={<ListMusic />}
					indent={CHILD_PAD}
					placeholder="Playlist name"
					parse={(v) => v.trim() || null}
					onCancel={() => {
						setAdding(false);
						newScope.reset();
					}}
					scope={newScope.prop}
					onCreate={async (name) => {
						const id = await createPlaylist(name, newScope.value);
						await queryClient.invalidateQueries({ queryKey: ["playlists"] });
						await navigate({ to: "/playlists/$id", params: { id: String(id) } });
					}}
				/>
			)}
			{!closed &&
				all.map((p) => (
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
								onSelect: () => actions.duplicate.mutate({ p, all: everything }),
							},
							"separator",
							...sharing.entries(itemOf(p)),
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
								<div
									className="flex min-w-0 flex-1 items-center gap-2 py-0.5"
									style={{ paddingLeft: CHILD_PAD }}
								>
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
									{...pageRow(p.name)}
									style={{ paddingLeft: CHILD_PAD }}
									onDoubleClick={() => setRenaming(p.id)}
								>
									<ListMusic className="size-4 shrink-0 opacity-70" />
									<span className="min-w-0 truncate">{p.name}</span>
									<ScopeMark scope={p.scope ?? "shared"} held={p.held ?? false} />
									<RowCount n={p.trackCount} />
								</Link>
							)}
						</div>
					</RowMenu>
				))}
			{!closed && (
				<HiddenItems
					items={hidden.map((p) => ({ key: String(p.id), name: p.name, item: itemOf(p) }))}
					onUnhide={sharing.unhide}
				/>
			)}
			{sharing.dialogs}
			{error && <ErrorLine className="px-2">{String(error)}</ErrorLine>}
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
		</div>
	);
}
