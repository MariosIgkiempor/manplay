import { useIsMutating, useQueries } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Library as LibraryIcon, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { HeaderMenu } from "#/components/header-menu.tsx";
import {
	AnalyzeButton,
	LibraryEmpty,
	LibraryList,
	LibrarySortMenu,
} from "#/components/library-parts.tsx";
import { PageHeader, PageIcon } from "#/components/page-header.tsx";
import { SearchPalette } from "#/components/search-palette.tsx";
import { ViewToggle } from "#/components/view-toggle.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { groupAlbums } from "#/lib/albums.ts";
import { playlistTracks } from "#/lib/api.ts";
import { useLibrarySorts } from "#/lib/library-sorts.ts";
import { PAGE_BODY, PAGE_TOOLBAR } from "#/lib/page-layout.ts";
import {
	SCAN_KEY,
	useLibraryRoot,
	useLibraryView,
	useScan,
	useSyncTargets,
	useTracks,
} from "#/lib/queries.ts";
import { filterTracks, type Pill, type PlaylistMembers } from "#/lib/search.ts";
import { sortAlbums } from "#/lib/sorting.ts";
import { cn } from "#/lib/utils.ts";

export const Route = createFileRoute("/")({ component: Library });

const plural = (n: number, one: string) => `${n.toLocaleString()} ${n === 1 ? one : `${one}s`}`;

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
	const sorts = useLibrarySorts();
	const albumCount = useMemo(() => groupAlbums(tracks.data ?? []).length, [tracks.data]);
	const albums = useMemo(
		() => sortAlbums(groupAlbums(visible), sorts.albums),
		[visible, sorts.albums],
	);

	const hasRoot = typeof root.data === "string";
	// Nothing to search or sort yet: say how to get songs in, instead of an empty list.
	const libraryEmpty = root.isSuccess && tracks.isSuccess && tracks.data.length === 0;

	return (
		<main>
			<PageHeader
				art={
					<PageIcon>
						<LibraryIcon />
					</PageIcon>
				}
				title="Library"
				titleHint={root.data ?? undefined}
				meta={
					libraryEmpty ? undefined : (
						<>
							<span>{plural(tracks.data?.length ?? 0, "song")}</span>
							<span>{plural(albumCount, "album")}</span>
						</>
					)
				}
				actions={
					hasRoot ? (
						<>
							<AnalyzeButton tracks={tracks.data ?? []} />
							<HeaderMenu
								entries={[
									{
										label: scanning ? "Scanning…" : "Rescan",
										icon: <RefreshCw />,
										hint: "Look for added, changed and removed files",
										onSelect: () => scan.mutate("saved"),
										disabled: scanning,
									},
								]}
							/>
						</>
					) : null
				}
				tabs={libraryEmpty ? null : <ViewToggle view={view} onChange={setView} />}
			/>
			{libraryEmpty ? (
				<LibraryEmpty
					hasRoot={hasRoot}
					scanning={scanning}
					onPick={() => scan.mutate("pick")}
					onRescan={() => scan.mutate("saved")}
				/>
			) : (
				<>
					{/* Search stays at hand while the list scrolls. */}
					<div className={PAGE_TOOLBAR}>
						<SearchPalette
							pills={pills}
							onPills={setPills}
							text={search}
							onText={setSearch}
							trailing={<LibrarySortMenu view={view} sorts={sorts} segment />}
						/>
					</div>

					<div className={cn("space-y-5", PAGE_BODY)}>
						<LibraryList
							view={view}
							albums={albums}
							tracks={visible}
							targetCount={targetCount}
							sorts={sorts}
							onOpen={(key) => detail.open({ kind: "album", key })}
							onOpenArtist={(name) => detail.open({ kind: "artist", name })}
						/>
					</div>
				</>
			)}
		</main>
	);
}
