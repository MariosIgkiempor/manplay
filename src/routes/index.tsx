import { useIsMutating, useQueries } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { LibraryHeader } from "#/components/library-header.tsx";
import { LibraryList, ScanButtons } from "#/components/library-parts.tsx";
import { SearchPalette } from "#/components/search-palette.tsx";
import { ViewToggle } from "#/components/view-toggle.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { groupAlbums } from "#/lib/albums.ts";
import { playlistTracks } from "#/lib/api.ts";
import {
	SCAN_KEY,
	useLibraryRoot,
	useLibraryView,
	useScan,
	useSyncTargets,
	useTracks,
} from "#/lib/queries.ts";
import { filterTracks, type Pill, type PlaylistMembers } from "#/lib/search.ts";

export const Route = createFileRoute("/")({ component: Library });

/** Track ids of each playlist that is picked as a pill, for filtering. */
function usePlaylistMembers(pills: readonly Pill[]): PlaylistMembers {
	const ids = pills.filter((p) => p.kind === "playlist").map((p) => Number(p.id));
	return useQueries({
		queries: ids.map((id) => ({
			queryKey: ["playlist-tracks", id],
			queryFn: () => playlistTracks(id),
		})),
		combine: (results) =>
			new Map(
				ids.flatMap((id, i) => {
					const tracks = results[i]?.data;
					return tracks ? [[id, new Set(tracks.map((t) => t.id))] as const] : [];
				}),
			),
	});
}

function Library() {
	const detail = useDetail();
	// Saved in the database; the Albums default shows only until the saved tab has loaded.
	const saved = useLibraryView();
	const view = saved.view ?? "albums";
	const setView = saved.setView;
	const [search, setSearch] = useState("");
	const [pills, setPills] = useState<Pill[]>([]);

	const tracks = useTracks();
	const targets = useSyncTargets();
	const targetCount = targets.data?.length ?? 0;
	const root = useLibraryRoot();
	const scan = useScan();
	// Also true while the automatic launch-time rescan is running.
	const scanning = useIsMutating({ mutationKey: SCAN_KEY }) > 0;

	const members = usePlaylistMembers(pills);
	const visible = useMemo(
		() => filterTracks(tracks.data ?? [], pills, search, members),
		[tracks.data, pills, search, members],
	);
	const albums = useMemo(() => groupAlbums(visible), [visible]);

	return (
		<main>
			<LibraryHeader
				title="Library"
				subtitle={root.data ?? undefined}
				controls={
					<>
						<ViewToggle view={view} onChange={setView} />
						<ScanButtons
							hasRoot={!!root.data}
							scanning={scanning}
							onScan={(mode) => scan.mutate(mode)}
						/>
					</>
				}
				filters={
					<SearchPalette pills={pills} onPills={setPills} text={search} onText={setSearch} />
				}
			/>

			<div className="space-y-5 px-6 pt-5 pb-6">
				<LibraryList
					view={view}
					albums={albums}
					tracks={visible}
					targetCount={targetCount}
					onOpen={(key) => detail.open({ kind: "album", key })}
					onOpenArtist={(name) => detail.open({ kind: "artist", name })}
				/>
			</div>
		</main>
	);
}
