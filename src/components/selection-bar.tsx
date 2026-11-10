import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { usePlayer } from "#/context/player-context.ts";
import { addToPlaylist, listPlaylists, listTags, type Track, tagTracks } from "#/lib/api.ts";

interface Props {
	/** Selected tracks, in list order. */
	tracks: readonly Track[];
	onClear: () => void;
}

const REFRESH = ["tracks", "playlist-tracks", "tags", "playlists"] as const;

/** Bulk actions for the currently selected tracks. */
export function SelectionBar({ tracks, onClear }: Props) {
	const queryClient = useQueryClient();
	const player = usePlayer();
	const listId = useId();
	const [newTag, setNewTag] = useState("");
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });
	const ids = tracks.map((t) => t.id);

	const refresh = async () => {
		for (const key of REFRESH) {
			await queryClient.invalidateQueries({ queryKey: [key] });
		}
	};
	const tag = useMutation({
		mutationFn: (name: string) => tagTracks(name, ids),
		onSuccess: async () => {
			setNewTag("");
			await refresh();
		},
	});
	const add = useMutation({
		mutationFn: (playlistId: number) => addToPlaylist(playlistId, ids),
		onSuccess: async () => {
			onClear();
			await refresh();
		},
	});

	const onSubmit = (e: FormEvent) => {
		e.preventDefault();
		const name = newTag.trim();
		if (name !== "") {
			tag.mutate(name);
		}
	};

	return (
		<div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
			<span className="font-medium">{tracks.length} selected</span>
			<Button variant="outline" onClick={() => player.play(tracks, 0)}>
				<Play /> Play
			</Button>
			<form onSubmit={onSubmit} className="flex gap-2">
				<Input
					value={newTag}
					onChange={(e) => setNewTag(e.target.value)}
					placeholder="Add tag…"
					list={listId}
					className="w-40"
				/>
				<datalist id={listId}>
					{tags.data?.map((g) => (
						<option key={g.id} value={g.name} />
					))}
				</datalist>
				<Button type="submit" variant="outline" disabled={tag.isPending}>
					Tag
				</Button>
			</form>
			<select
				aria-label="Add selected to playlist"
				className="h-8 rounded-lg border bg-background px-2 text-sm"
				value=""
				onChange={(e) => add.mutate(Number(e.target.value))}
			>
				<option value="" disabled>
					Add to playlist…
				</option>
				{playlists.data?.map((p) => (
					<option key={p.id} value={p.id}>
						{p.name}
					</option>
				))}
			</select>
			<Button variant="ghost" onClick={onClear}>
				Clear
			</Button>
			{[tag, add].map(
				(m) =>
					m.isError && (
						<span key={m.submittedAt} className="text-destructive">
							{String(m.error)}
						</span>
					),
			)}
		</div>
	);
}
