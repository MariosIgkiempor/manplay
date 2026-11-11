import { useIsMutating, useMutationState, useQueries } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { FilesView } from "#/components/files-view.tsx";
import { LibraryHeader } from "#/components/library-header.tsx";
import { LibraryList, ScanButtons } from "#/components/library-parts.tsx";
import { MissingBanner } from "#/components/missing-banner.tsx";
import { SearchPalette } from "#/components/search-palette.tsx";
import { SyncStatusPill } from "#/components/sync-status-pill.tsx";
import { type View, ViewToggle } from "#/components/view-toggle.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { groupAlbums } from "#/lib/albums.ts";
import { playlistTracks } from "#/lib/api.ts";
import {
	SCAN_KEY,
	useLibraryRoot,
	useScan,
	useSyncRun,
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
	const [view, setView] = useState<View>("albums");
	const [search, setSearch] = useState("");
	const [pills, setPills] = useState<Pill[]>([]);

	const tracks = useTracks();
	const targets = useSyncTargets();
	const targetCount = targets.data?.length ?? 0;
	const syncRun = useSyncRun();
	const root = useLibraryRoot();
	const scan = useScan();
	// Also true while the automatic launch-time rescan is running.
	const scanning = useIsMutating({ mutationKey: SCAN_KEY }) > 0;
	const lastScanError = useMutationState({
		filters: { mutationKey: SCAN_KEY, status: "error" },
		select: (m) => String(m.state.error),
	}).at(-1);

	const members = usePlaylistMembers(pills);
	const visible = useMemo(
		() => filterTracks(tracks.data ?? [], pills, search, members),
		[tracks.data, pills, search, members],
	);
	const albums = useMemo(() => groupAlbums(visible), [visible]);

	const files = view === "files";

	return (
		<main className={files ? "flex h-full flex-col" : undefined}>
			<LibraryHeader
				title="Library"
				subtitle={root.data ?? undefined}
				controls={
					<>
						<SyncStatusPill />
						<ViewToggle view={view} onChange={setView} />
						<ScanButtons
							hasRoot={!!root.data}
							scanning={scanning}
							onScan={(mode) => scan.mutate(mode)}
						/>
					</>
				}
				filters={
					files ? undefined : (
						<SearchPalette pills={pills} onPills={setPills} text={search} onText={setSearch} />
					)
				}
			/>

			<div className={files ? "space-y-3 px-6 pb-4" : "space-y-5 px-6 pt-5 pb-6"}>
				<MissingBanner />
				{lastScanError && !scanning && <p className="text-destructive text-sm">{lastScanError}</p>}
				{syncRun.isError && <p className="text-destructive text-sm">{String(syncRun.error)}</p>}
				{!files && (
					<LibraryList
						view={view}
						albums={albums}
						tracks={visible}
						targetCount={targetCount}
						onOpen={(key) => detail.open({ kind: "album", key })}
					/>
				)}
			</div>
			{files && (
				<div className="min-h-0 flex-1">
					<FilesView />
				</div>
			)}
		</main>
	);
}
