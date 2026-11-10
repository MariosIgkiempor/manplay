import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { TrackTable } from "#/components/track-table.tsx";
import { Button } from "#/components/ui/button.tsx";
import { addToPlaylist, listPlaylists, listTracks, pickAndScan } from "#/lib/api.ts";

export const Route = createFileRoute("/")({ component: Library });

function Library() {
	const queryClient = useQueryClient();
	const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
	const tracks = useQuery({ queryKey: ["tracks"], queryFn: listTracks });
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });

	const scan = useMutation({
		mutationFn: pickAndScan,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tracks"] }),
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

	const rows = tracks.data ?? [];

	return (
		<main className="space-y-4 p-6">
			<header className="flex items-center justify-between gap-4">
				<h1 className="font-semibold text-xl">Library ({rows.length})</h1>
				<div className="flex items-center gap-2">
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
			{add.isError && <p className="text-destructive text-sm">{String(add.error)}</p>}
			<TrackTable tracks={rows} selected={selected} onToggle={toggle} />
		</main>
	);
}
