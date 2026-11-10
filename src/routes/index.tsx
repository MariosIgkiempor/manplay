import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FolderSearch, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { AlbumGrid } from "#/components/album-grid.tsx";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { SyncStatusPill } from "#/components/sync-status-pill.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { type View, ViewToggle } from "#/components/view-toggle.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { groupAlbums } from "#/lib/albums.ts";
import { listTags, pickAndScan, type Track } from "#/lib/api.ts";
import { useSyncRun, useSyncTargets, useTracks } from "#/lib/queries.ts";

export const Route = createFileRoute("/")({ component: Library });

function matches(t: Track, q: string, tag: string): boolean {
	const hay = `${t.title} ${t.artist} ${t.album}`.toLowerCase();
	const tagOk = tag === "" || t.tags.some((x) => x.toLowerCase() === tag.toLowerCase());
	return tagOk && hay.includes(q);
}

function Library() {
	const queryClient = useQueryClient();
	const detail = useDetail();
	const [view, setView] = useState<View>("albums");
	const [search, setSearch] = useState("");
	const [tagFilter, setTagFilter] = useState("");

	const tracks = useTracks();
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const targets = useSyncTargets();
	const targetCount = targets.data?.length ?? 0;
	const syncRun = useSyncRun();

	const scan = useMutation({
		mutationFn: pickAndScan,
		onSuccess: async (count) => {
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			// Mirror new files to every destination in the background.
			if (count !== null && targetCount > 0) {
				syncRun.mutate(undefined);
			}
		},
	});

	const visible = useMemo(() => {
		const q = search.trim().toLowerCase();
		return (tracks.data ?? []).filter((t) => matches(t, q, tagFilter));
	}, [tracks.data, search, tagFilter]);
	const albums = useMemo(() => groupAlbums(visible), [visible]);

	return (
		<main className="space-y-5 p-6">
			<header className="flex flex-wrap items-center justify-between gap-3">
				<h1 className="font-bold text-2xl">Library</h1>
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
					<Button variant="outline" onClick={() => scan.mutate()} disabled={scan.isPending}>
						<FolderSearch />
						{scan.isPending ? "Scanning…" : "Scan folder"}
					</Button>
				</div>
			</header>

			{[scan, syncRun].map(
				(m) =>
					m.isError && (
						<p key={m.submittedAt} className="text-destructive text-sm">
							{String(m.error)}
						</p>
					),
			)}

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
