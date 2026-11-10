import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { addToPlaylist, listPlaylists, listTags, tagTracks } from "#/lib/api.ts";

interface Props {
	selected: ReadonlySet<number>;
	onClear: () => void;
}

const REFRESH = ["tracks", "playlist-tracks", "tags", "playlists"] as const;

/** Bulk actions for the currently selected tracks. */
export function SelectionBar({ selected, onClear }: Props) {
	const queryClient = useQueryClient();
	const listId = useId();
	const [newTag, setNewTag] = useState("");
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });

	const refresh = async () => {
		for (const key of REFRESH) {
			await queryClient.invalidateQueries({ queryKey: [key] });
		}
	};
	const tag = useMutation({
		mutationFn: (name: string) => tagTracks(name, [...selected]),
		onSuccess: async () => {
			setNewTag("");
			await refresh();
		},
	});
	const add = useMutation({
		mutationFn: (playlistId: number) => addToPlaylist(playlistId, [...selected]),
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
			<span className="font-medium">{selected.size} selected</span>
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
