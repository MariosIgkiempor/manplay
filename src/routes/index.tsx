import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FolderSearch, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { AlbumDetail } from "#/components/album-detail.tsx";
import { AlbumGrid } from "#/components/album-grid.tsx";
import { SelectionBar } from "#/components/selection-bar.tsx";
import { SyncStatusPill } from "#/components/sync-status-pill.tsx";
import { TrackList } from "#/components/track-list.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { type View, ViewToggle } from "#/components/view-toggle.tsx";
import { type Album, groupAlbums } from "#/lib/albums.ts";
import { listTags, pickAndScan, type Track, untagTrack } from "#/lib/api.ts";
import { useSyncRun, useSyncTargets, useTracks } from "#/lib/queries.ts";

export const Route = createFileRoute("/")({ component: Library });

function matches(t: Track, q: string, tag: string): boolean {
	const hay = `${t.title} ${t.artist} ${t.album}`.toLowerCase();
	const tagOk = tag === "" || t.tags.some((x) => x.toLowerCase() === tag.toLowerCase());
	return tagOk && hay.includes(q);
}

function Library() {
	const queryClient = useQueryClient();
	const [view, setView] = useState<View>("albums");
	const [search, setSearch] = useState("");
	const [tagFilter, setTagFilter] = useState("");
	const [openKey, setOpenKey] = useState<string | null>(null);
	const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());

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
	const untag = useMutation({
		mutationFn: ({ name, trackId }: { name: string; trackId: number }) => untagTrack(name, trackId),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["tags"] });
		},
	});

	const visible = useMemo(() => {
		const q = search.trim().toLowerCase();
		return (tracks.data ?? []).filter((t) => matches(t, q, tagFilter));
	}, [tracks.data, search, tagFilter]);
	const albums = useMemo(() => groupAlbums(visible), [visible]);
	const openAlbum: Album | undefined = albums.find((a) => a.key === openKey);

	const toggle = (id: number) => {
		const next = new Set(selected);
		if (!next.delete(id)) {
			next.add(id);
		}
		setSelected(next);
	};
	const onRemoveTag = (t: Track, name: string) => untag.mutate({ name, trackId: t.id });

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

			{[scan, syncRun, untag].map(
				(m) =>
					m.isError && (
						<p key={m.submittedAt} className="text-destructive text-sm">
							{String(m.error)}
						</p>
					),
			)}
			{selected.size > 0 && (
				<SelectionBar selected={selected} onClear={() => setSelected(new Set())} />
			)}

			{view === "albums" && openAlbum ? (
				<AlbumDetail
					album={openAlbum}
					targetCount={targetCount}
					onBack={() => setOpenKey(null)}
					onRemoveTag={onRemoveTag}
				/>
			) : view === "albums" ? (
				<AlbumGrid albums={albums} targetCount={targetCount} onOpen={(a) => setOpenKey(a.key)} />
			) : (
				<TrackList
					tracks={visible}
					targetCount={targetCount}
					selected={selected}
					onToggle={toggle}
					onRemoveTag={onRemoveTag}
				/>
			)}
		</main>
	);
}
