import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ComponentProps, useMemo, useState } from "react";
import { ErrorLine } from "#/components/page.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { TrackList } from "#/components/track-list.tsx";
import { useUndo } from "#/context/undo-context.ts";
import { type Track, untagTrack } from "#/lib/api.ts";
import { duration } from "#/lib/format.ts";
import { useSyncTargets } from "#/lib/queries.ts";
import { nextSort, type Sort, sortTracks } from "#/lib/track-fields.ts";
import { undoUntag } from "#/lib/undo-entries.ts";
import { useTrackEdit } from "#/lib/use-track-edit.ts";
import { useTrackSelection } from "#/lib/use-track-selection.ts";

type ListProps = Omit<
	ComponentProps<typeof TrackList>,
	"selection" | "targetCount" | "onRemoveTag" | "onEdit" | "sort" | "onSort"
>;

/**
 * Track list with click / shift-click / cmd-click selection, sortable columns and in-place
 * editing of title, BPM and key.
 */
export function SelectableTrackList({ tracks, ...rest }: ListProps) {
	const queryClient = useQueryClient();
	const [sort, setSort] = useState<Sort | null>(null);
	const sorted = useMemo(() => sortTracks(tracks, sort), [tracks, sort]);
	const selection = useTrackSelection(sorted);
	const targets = useSyncTargets();
	const saveEdit = useTrackEdit();
	const { record } = useUndo();

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
			<TrackList
				{...rest}
				tracks={sorted}
				targetCount={targets.data?.length ?? 0}
				selection={selection}
				sort={sort}
				onSort={(key) => setSort((s) => nextSort(s, key))}
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
