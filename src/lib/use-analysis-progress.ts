import { useIsMutating } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type AnalysisProgress, onAnalysisProgress } from "#/lib/api.ts";
import { ANALYSIS_KEY } from "#/lib/queries.ts";

/** Live progress of the running analysis or tag save; `null` while idle or before it reports. */
export function useAnalysisProgress(): { running: boolean; progress: AnalysisProgress | null } {
	const running = useIsMutating({ mutationKey: ANALYSIS_KEY }) > 0;
	const [progress, setProgress] = useState<AnalysisProgress | null>(null);

	useEffect(() => {
		let cancelled = false;
		let unlisten: (() => void) | undefined;
		void onAnalysisProgress(setProgress).then((fn) => {
			if (cancelled) {
				fn();
			} else {
				unlisten = fn;
			}
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, []);

	useEffect(() => {
		if (!running) {
			setProgress(null);
		}
	}, [running]);

	return { running, progress };
}

/** "Analyzing BPM & key" or "Saving to files", for a progress label. */
export function progressLabel(progress: AnalysisProgress | null, stopping: boolean): string {
	if (stopping) {
		return "Stopping analysis…";
	}
	return progress?.phase === "saving" ? "Saving to files" : "Analyzing BPM & key";
}
