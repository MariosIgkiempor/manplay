import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ComponentProps, useMemo, useState } from "react";
import { ErrorLine } from "#/components/page.tsx";
import { SortMenu } from "#/components/sort-menu.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { TrackList } from "#/components/track-list.tsx";
import { PanelBarActions, useHasPanelBar } from "#/context/panel-bar.tsx";
import { useUndo } from "#/context/undo-context.ts";
import { type Track, untagTrack } from "#/lib/api.ts";
import { duration } from "#/lib/format.ts";
import { useSyncTargets } from "#/lib/queries.ts";
import { type ListSort, type SongSort, songSortOptions, sortSongs } from "#/lib/sorting.ts";
import { undoUntag } from "#/lib/undo-entries.ts";
import { useTrackEdit } from "#/lib/use-track-edit.ts";
import { useTrackSelection } from "#/lib/use-track-selection.ts";

type ListProps = Omit<
	ComponentProps<typeof TrackList>,
	"selection" | "targetCount" | "onRemoveTag" | "onEdit"
> & {
	/** Name of the order the songs come in (e.g. "Album order"), offered as a sort and used first. */
	listOrder?: string;
	/** Sort kept by the caller, e.g. saved for the library; the list keeps its own otherwise. */
	sort?: ListSort<SongSort>;
	onSortChange?: (sort: ListSort<SongSort>) => void;
	/** The caller shows the sort menu elsewhere (e.g. the page header). */
	hideSortMenu?: boolean;
};

/** A song list's sort, kept by a page that shows the sort menu in its header, and the songs in it. */
export function useSongSort(songs: readonly Track[], listOrder?: string) {
	const [sort, setSort] = useState<ListSort<SongSort>>(
		listOrder ? { key: "list", desc: false } : { key: "title", desc: false },
	);
	// The page's Play plays the songs in the order the list shows them.
	const sorted = useMemo(() => sortSongs(songs, sort), [songs, sort]);
	return { sort, setSort, options: songSortOptions(listOrder), sorted };
}

/** The sort menu for a page header's button group; nothing with fewer than two songs to sort. */
export function HeaderSongSort({
	songs,
	sort,
}: {
	songs: number;
	sort: ReturnType<typeof useSongSort>;
}) {
	if (songs < 2) {
		return null;
	}
	return <SortMenu options={sort.options} value={sort.sort} onChange={sort.setSort} segment />;
}

/**
 * Track list with click / shift-click / cmd-click selection, a sort menu, and in-place editing of
 * title, BPM and key.
 */
export function SelectableTrackList({
	tracks,
	listOrder,
	sort: givenSort,
	onSortChange,
	hideSortMenu = false,
	...rest
}: ListProps) {
	const queryClient = useQueryClient();
	const [ownSort, setOwnSort] = useState<ListSort<SongSort>>(
		listOrder ? { key: "list", desc: false } : { key: "title", desc: false },
	);
	const sort = givenSort ?? ownSort;
	const setSort = onSortChange ?? setOwnSort;
	const sorted = useMemo(() => sortSongs(tracks, sort), [tracks, sort]);
	const selection = useTrackSelection(sorted);
	const targets = useSyncTargets();
	const saveEdit = useTrackEdit();
	const { record } = useUndo();
	const inPanel = useHasPanelBar();

	const untag = useMutation({
		mutationFn: async ({ name, trackId }: { name: string; trackId: number }) => {
			await untagTrack(name, trackId);
			record(undoUntag(name, trackId));
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["playlist-tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["tags"] });
		},
	});
	const [editError, setEditError] = useState<string | null>(null);

	const totalSeconds = tracks.reduce((n, t) => n + (t.durationMs ?? 0), 0) / 1000;

	return (
		<div className="space-y-3">
			{untag.isError && <ErrorLine>{String(untag.error)}</ErrorLine>}
			{editError && <ErrorLine>Could not save: {editError}</ErrorLine>}
			{/* In the side panel the sort goes in its top bar, so the list starts under the tabs. */}
			{!hideSortMenu &&
				tracks.length > 1 &&
				(inPanel ? (
					<PanelBarActions>
						<SortMenu options={songSortOptions(listOrder)} value={sort} onChange={setSort} />
					</PanelBarActions>
				) : (
					<div className="flex justify-end">
						<SortMenu options={songSortOptions(listOrder)} value={sort} onChange={setSort} />
					</div>
				))}
			<TrackList
				{...rest}
				tracks={sorted}
				targetCount={targets.data?.length ?? 0}
				selection={selection}
				onRemoveTag={(t: Track, name: string) => untag.mutate({ name, trackId: t.id })}
				onEdit={(t, field, value) => {
					setEditError(null);
					saveEdit(t, field, value).catch((e: unknown) => setEditError(String(e)));
				}}
			/>
			<StatusBar>
				<Stat label="Songs" value={tracks.length} />
				<Stat label="Duration" value={duration(totalSeconds)} />
				{selection.selected.size > 0 && <Stat label="Selected" value={selection.selected.size} />}
			</StatusBar>
		</div>
	);
}
