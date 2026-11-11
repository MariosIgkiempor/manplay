import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { TrackList } from "#/components/track-list.tsx";
import { type Track, untagTrack } from "#/lib/api.ts";
import { useSyncTargets } from "#/lib/queries.ts";
import { useTrackSelection } from "#/lib/use-track-selection.ts";

type ListProps = Omit<
	ComponentProps<typeof TrackList>,
	"selection" | "targetCount" | "onRemoveTag"
>;

/** Track list with click / shift-click / cmd-click selection and bulk actions. */
export function SelectableTrackList({ tracks, ...rest }: ListProps) {
	const queryClient = useQueryClient();
	const selection = useTrackSelection(tracks);
	const targets = useSyncTargets();

	const untag = useMutation({
		mutationFn: ({ name, trackId }: { name: string; trackId: number }) => untagTrack(name, trackId),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["playlist-tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["tags"] });
		},
	});

	const selectedTracks = tracks.filter((t) => selection.selected.has(t.id));

	return (
		<div className="space-y-3">
			{untag.isError && <p className="text-destructive text-sm">{String(untag.error)}</p>}
			<TrackList
				{...rest}
				tracks={tracks}
				targetCount={targets.data?.length ?? 0}
				selection={selection}
				onRemoveTag={(t: Track, name: string) => untag.mutate({ name, trackId: t.id })}
			/>
			<StatusBar>
				<Stat label="Total songs" value={tracks.length} />
				{selectedTracks.length > 0 && <Stat label="Selected" value={selectedTracks.length} />}
			</StatusBar>
		</div>
	);
}
