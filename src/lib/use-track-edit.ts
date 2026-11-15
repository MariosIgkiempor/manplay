import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { setTempoKey, type Track } from "#/lib/api.ts";
import { normalizeKey } from "#/lib/musical-key.ts";
import { refreshAfterFsChange, useTagsWrite } from "#/lib/queries.ts";

/** Fields a list row can edit in place. */
export type InlineField = "title" | "bpm" | "key";

function patched(track: Track, field: InlineField, value: string): Track {
	if (field === "title") {
		return { ...track, title: value };
	}
	if (field === "bpm") {
		return { ...track, bpm: value === "" ? null : Number(value) };
	}
	return { ...track, key: value === "" ? null : (normalizeKey(value) ?? track.key) };
}

/**
 * Saves one value of one song from a list row. The lists update at once; the library rescan
 * that follows confirms (or reverts) it. A BPM or key typed by hand replaces the detected one.
 */
export function useTrackEdit() {
	const queryClient = useQueryClient();
	const { mutateAsync: writeTags } = useTagsWrite();
	return useCallback(
		async (track: Track, field: InlineField, value: string) => {
			const patch = (list: Track[] | undefined) =>
				list?.map((t) => (t.id === track.id ? patched(t, field, value) : t));
			queryClient.setQueryData<Track[]>(["tracks"], patch);
			queryClient.setQueriesData<Track[]>({ queryKey: ["playlist-tracks"] }, patch);
			try {
				const report =
					field === "title"
						? await writeTags({ path: track.path, edits: { title: value } })
						: await setTempoKey(track.id, { [field]: value });
				const failed = report.failed[0];
				if (failed) {
					throw new Error(failed.error);
				}
			} finally {
				if (field !== "title") {
					await refreshAfterFsChange(queryClient);
				}
			}
		},
		[queryClient, writeTags],
	);
}
