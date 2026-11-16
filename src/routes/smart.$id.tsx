import { createFileRoute } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { EmptyState } from "#/components/page.tsx";
import { SmartPlaylistView } from "#/components/smart-playlist-view.tsx";
import { useSmartPlaylists } from "#/lib/use-smart.ts";

export const Route = createFileRoute("/smart/$id")({ component: SmartPlaylistPage });

function SmartPlaylistPage() {
	const { id } = Route.useParams();
	const list = useSmartPlaylists();
	const playlist = list.data?.find((p) => p.id === Number(id));
	if (list.isSuccess && !playlist) {
		return (
			<main className="p-6">
				<EmptyState icon={<Sparkles />} title="This smart playlist is gone">
					It was deleted. Pick another from the sidebar.
				</EmptyState>
			</main>
		);
	}
	return playlist ? <SmartPlaylistView key={playlist.id} playlist={playlist} /> : null;
}
