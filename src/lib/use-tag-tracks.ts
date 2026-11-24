import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SearchItem } from "#/components/search-submenu.tsx";
import { useUndo } from "#/context/undo-context.ts";
import { listTags, type Track, tagTracks } from "#/lib/api.ts";
import { flattenTagTree } from "#/lib/tag-tree.ts";
import { undoTagTracks } from "#/lib/undo-entries.ts";

const REFRESH = ["tracks", "playlist-tracks", "tags", "playlists"] as const;

/**
 * The library's tags, nested ones after their parent, each marked when every one of `tracks`
 * has it; and tagging `tracks` by name, making the tag when it is new. Each tagging can be undone.
 */
export function useTagTracks(tracks: readonly Track[]) {
	const queryClient = useQueryClient();
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const { record } = useUndo();
	const tag = useMutation({
		mutationFn: async (name: string) => {
			const lower = name.toLowerCase();
			const missing = tracks
				.filter((t) => !t.tags.some((x) => x.toLowerCase() === lower))
				.map((t) => t.id);
			await tagTracks(
				name,
				tracks.map((t) => t.id),
			);
			const entry = undoTagTracks(name, missing);
			if (entry) {
				record(entry);
			}
		},
		onSuccess: async () => {
			for (const key of REFRESH) {
				await queryClient.invalidateQueries({ queryKey: [key] });
			}
		},
	});
	const hasAll = (name: string) =>
		tracks.length > 0 &&
		tracks.every((t) => t.tags.some((x) => x.toLowerCase() === name.toLowerCase()));

	const items: SearchItem[] = flattenTagTree(tags.data ?? []).map(({ node, depth }) => ({
		name: node.name,
		label: node.label,
		depth,
		count: node.trackCount,
		checked: hasAll(node.name),
	}));
	return { tags: items, tag: (name: string) => tag.mutate(name) };
}
