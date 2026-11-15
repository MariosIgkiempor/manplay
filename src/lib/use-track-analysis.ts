import { useQuery } from "@tanstack/react-query";
import { trackAnalysis } from "#/lib/api.ts";

export const TRACK_ANALYSIS_KEY = ["track-analysis"] as const;

/** The kept beat grid and waveform of a track, or null before it has been analysed. */
export function useTrackAnalysis(trackId: number | null) {
	return useQuery({
		queryKey: [...TRACK_ANALYSIS_KEY, trackId],
		queryFn: () => trackAnalysis(trackId ?? 0),
		enabled: trackId !== null,
		staleTime: Number.POSITIVE_INFINITY,
	});
}
