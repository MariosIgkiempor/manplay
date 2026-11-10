import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { TrackTable } from "#/components/track-table.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import {
	addToPlaylist,
	getSyncTarget,
	listPlaylists,
	listTags,
	listTracks,
	pickAndScan,
	syncNow,
	tagTracks,
	untagTrack,
} from "#/lib/api.ts";

export const Route = createFileRoute("/")({ component: Library });

function Library() {
	const queryClient = useQueryClient();
	const tagListId = useId();
	const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
	const tracks = useQuery({ queryKey: ["tracks"], queryFn: listTracks });
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const [tagFilter, setTagFilter] = useState("");
	const [newTag, setNewTag] = useState("");

	const refreshTags = async () => {
		await queryClient.invalidateQueries({ queryKey: ["tracks"] });
		await queryClient.invalidateQueries({ queryKey: ["playlist-tracks"] });
		await queryClient.invalidateQueries({ queryKey: ["tags"] });
	};
	const tag = useMutation({
		mutationFn: (name: string) => tagTracks(name, [...selected]),
		onSuccess: async () => {
			setNewTag("");
			await refreshTags();
		},
	});
	const untag = useMutation({
		mutationFn: ({ name, trackId }: { name: string; trackId: number }) => untagTrack(name, trackId),
		onSuccess: refreshTags,
	});
	const onTagSubmit = (e: FormEvent) => {
		e.preventDefault();
		const name = newTag.trim();
		if (name !== "") {
			tag.mutate(name);
		}
	};

	const target = useQuery({ queryKey: ["sync-target"], queryFn: getSyncTarget });
	const sync = useMutation({ mutationFn: syncNow });
	const scan = useMutation({
		mutationFn: pickAndScan,
		onSuccess: async (count) => {
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			// Mirror new files to the sync target in the background.
			if (count !== null && target.data) {
				sync.mutate();
			}
		},
	});
	const add = useMutation({
		mutationFn: (playlistId: number) => addToPlaylist(playlistId, [...selected]),
		onSuccess: async () => {
			setSelected(new Set());
			await queryClient.invalidateQueries({ queryKey: ["playlists"] });
			await queryClient.invalidateQueries({ queryKey: ["playlist-tracks"] });
		},
	});

	const toggle = (id: number) => {
		const next = new Set(selected);
		if (!next.delete(id)) {
			next.add(id);
		}
		setSelected(next);
	};

	const rows = (tracks.data ?? []).filter(
		(t) => tagFilter === "" || t.tags.some((x) => x.toLowerCase() === tagFilter.toLowerCase()),
	);

	return (
		<main className="space-y-4 p-6">
			<header className="flex items-center justify-between gap-4">
				<h1 className="font-semibold text-xl">Library ({rows.length})</h1>
				<div className="flex items-center gap-2">
					<select
						aria-label="Filter by tag"
						className="h-8 rounded-lg border bg-background px-2 text-sm"
						value={tagFilter}
						onChange={(e) => setTagFilter(e.target.value)}
					>
						<option value="">All tags</option>
						{tags.data?.map((g) => (
							<option key={g.id} value={g.name}>
								{g.name} ({g.trackCount})
							</option>
						))}
					</select>
					{selected.size > 0 && (
						<form onSubmit={onTagSubmit} className="flex gap-2">
							<Input
								value={newTag}
								onChange={(e) => setNewTag(e.target.value)}
								placeholder={`Tag ${selected.size}…`}
								list={tagListId}
							/>
							<datalist id={tagListId}>
								{tags.data?.map((g) => (
									<option key={g.id} value={g.name} />
								))}
							</datalist>
							<Button type="submit" variant="outline" disabled={tag.isPending}>
								Tag
							</Button>
						</form>
					)}
					{selected.size > 0 && (
						<select
							aria-label="Add selected to playlist"
							className="h-8 rounded-lg border bg-background px-2 text-sm"
							value=""
							onChange={(e) => add.mutate(Number(e.target.value))}
						>
							<option value="" disabled>
								Add {selected.size} to playlist…
							</option>
							{playlists.data?.map((p) => (
								<option key={p.id} value={p.id}>
									{p.name}
								</option>
							))}
						</select>
					)}
					<Button onClick={() => scan.mutate()} disabled={scan.isPending}>
						{scan.isPending ? "Scanning…" : "Scan folder"}
					</Button>
				</div>
			</header>
			{scan.isError && <p className="text-destructive text-sm">{String(scan.error)}</p>}
			{sync.isPending && (
				<p className="text-muted-foreground text-sm">Syncing to {target.data?.machine}…</p>
			)}
			{sync.isError && <p className="text-destructive text-sm">{String(sync.error)}</p>}
			{tag.isError && <p className="text-destructive text-sm">{String(tag.error)}</p>}
			{add.isError && <p className="text-destructive text-sm">{String(add.error)}</p>}
			<TrackTable
				tracks={rows}
				selected={selected}
				onToggle={toggle}
				onRemoveTag={(t, name) => untag.mutate({ name, trackId: t.id })}
			/>
		</main>
	);
}
