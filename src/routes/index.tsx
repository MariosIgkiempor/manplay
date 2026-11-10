import { useIsMutating, useMutationState, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FolderOpen, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { AlbumGrid } from "#/components/album-grid.tsx";
import { MissingBanner } from "#/components/missing-banner.tsx";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { SyncStatusPill } from "#/components/sync-status-pill.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { type View, ViewToggle } from "#/components/view-toggle.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { groupAlbums } from "#/lib/albums.ts";
import { listTags, type Track } from "#/lib/api.ts";
import {
	SCAN_KEY,
	useLibraryRoot,
	useScan,
	useSyncRun,
	useSyncTargets,
	useTracks,
} from "#/lib/queries.ts";

export const Route = createFileRoute("/")({ component: Library });

function matches(t: Track, q: string, tag: string): boolean {
	const hay = `${t.title} ${t.artist} ${t.album}`.toLowerCase();
	const tagOk = tag === "" || t.tags.some((x) => x.toLowerCase() === tag.toLowerCase());
	return tagOk && hay.includes(q);
}

function Library() {
	const detail = useDetail();
	const [view, setView] = useState<View>("albums");
	const [search, setSearch] = useState("");
	const [tagFilter, setTagFilter] = useState("");

	const tracks = useTracks();
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
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

	const visible = useMemo(() => {
		const q = search.trim().toLowerCase();
		return (tracks.data ?? []).filter((t) => matches(t, q, tagFilter));
	}, [tracks.data, search, tagFilter]);
	const albums = useMemo(() => groupAlbums(visible), [visible]);

	return (
		<main className="space-y-5 p-6">
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<h1 className="font-bold text-2xl">Library</h1>
					{root.data && (
						<p className="truncate text-muted-foreground text-xs" title={root.data}>
							{root.data}
						</p>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<SyncStatusPill />
					<div className="relative">
						<Search className="absolute top-2 left-2.5 size-4 text-muted-foreground" />
						<Input
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search"
							className="w-56 pl-8"
						/>
					</div>
					<select
						aria-label="Filter by tag"
						className="h-8 rounded-lg border bg-background px-2 text-sm"
						value={tagFilter}
						onChange={(e) => setTagFilter(e.target.value)}
					>
						<option value="">All tags</option>
						{tags.data?.map((g) => (
							<option key={g.id} value={g.name}>
								{g.name} ({g.trackCount})
							</option>
						))}
					</select>
					<ViewToggle view={view} onChange={setView} />
					{root.data && (
						<Button variant="outline" onClick={() => scan.mutate("saved")} disabled={scanning}>
							<RefreshCw className={scanning ? "animate-spin" : ""} />
							{scanning ? "Scanning…" : "Rescan"}
						</Button>
					)}
					<Button
						variant={root.data ? "ghost" : "outline"}
						onClick={() => scan.mutate("pick")}
						disabled={scanning}
					>
						<FolderOpen />
						{root.data ? "Change folder" : "Choose folder"}
					</Button>
				</div>
			</header>

			<MissingBanner />
			{lastScanError && !scanning && <p className="text-destructive text-sm">{lastScanError}</p>}
			{syncRun.isError && <p className="text-destructive text-sm">{String(syncRun.error)}</p>}

			{view === "albums" ? (
				<AlbumGrid
					albums={albums}
					targetCount={targetCount}
					onOpen={(a) => detail.open({ kind: "album", key: a.key })}
				/>
			) : (
				<SelectableTrackList tracks={visible} />
			)}
		</main>
	);
}
