import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tag as TagIcon } from "lucide-react";
import { SearchSubmenu } from "#/components/search-submenu.tsx";
import { listTags, type Track, tagTracks } from "#/lib/api.ts";

const REFRESH = ["tracks", "playlist-tracks", "tags", "playlists"] as const;

/** Right-click "Tag" submenu: search existing tags or create one; stays open for more. */
export function TagSubmenu({ tracks }: { tracks: readonly Track[] }) {
	const queryClient = useQueryClient();
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const ids = tracks.map((t) => t.id);
	const tag = useMutation({
		mutationFn: (name: string) => tagTracks(name, ids),
		onSuccess: async () => {
			for (const key of REFRESH) {
				await queryClient.invalidateQueries({ queryKey: [key] });
			}
		},
	});
	const hasAll = (name: string) =>
		tracks.length > 0 &&
		tracks.every((t) => t.tags.some((x) => x.toLowerCase() === name.toLowerCase()));

	return (
		<SearchSubmenu
			label="Tag"
			icon={TagIcon}
			placeholder="Search or create tag…"
			emptyHint="Type a name to create a tag."
			items={(tags.data ?? []).map((t) => ({
				name: t.name,
				count: t.trackCount,
				checked: hasAll(t.name),
			}))}
			onPick={(name) => tag.mutate(name)}
		/>
	);
}
