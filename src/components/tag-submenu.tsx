import { Tag as TagIcon } from "lucide-react";
import { SearchSubmenu } from "#/components/search-submenu.tsx";
import type { Track } from "#/lib/api.ts";
import { useTagTracks } from "#/lib/use-tag-tracks.ts";

/** Right-click "Tag" submenu: search existing tags or create one; stays open for more. */
export function TagSubmenu({ tracks }: { tracks: readonly Track[] }) {
	const { tags, tag } = useTagTracks(tracks);
	return (
		<SearchSubmenu
			label="Tag"
			icon={TagIcon}
			placeholder="Search or create tag (a/b nests)…"
			emptyHint="Type a name to create a tag. Use / to nest, e.g. Genre/House."
			items={tags}
			onPick={tag}
		/>
	);
}
