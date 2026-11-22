import { useIsMutating } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
	type AnalysisProgress,
	isAnalyzing,
	onAnalysisFinished,
	onAnalysisProgress,
} from "#/lib/api.ts";
import { ANALYSIS_KEY } from "#/lib/queries.ts";

/**
 * Live progress of the running analysis or tag save, whoever started it (this page or the
 * background analysis of new songs); `null` while idle or before it reports.
 */
export function useAnalysisProgress(): { running: boolean; progress: AnalysisProgress | null } {
	const started = useIsMutating({ mutationKey: ANALYSIS_KEY }) > 0;
	const [backend, setBackend] = useState(false);
	const [progress, setProgress] = useState<AnalysisProgress | null>(null);
	const running = started || backend;

	useEffect(() => {
		let cancelled = false;
		const unlisten: (() => void)[] = [];
		const keep = (fn: () => void) => (cancelled ? fn() : unlisten.push(fn));
		void isAnalyzing().then((on) => !cancelled && setBackend(on));
		void onAnalysisProgress((p) => {
			setBackend(true);
			setProgress(p);
		}).then(keep);
		void onAnalysisFinished(() => setBackend(false)).then(keep);
		return () => {
			cancelled = true;
			for (const fn of unlisten) {
				fn();
			}
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
