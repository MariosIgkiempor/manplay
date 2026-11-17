import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ProgressPill } from "#/components/progress-pill.tsx";
import { onWaveformProgress, type WaveformProgress } from "#/lib/api.ts";

/** Show downloaded waveforms in the lists every this many files. */
const REFRESH_EVERY = 40;

/** Waveforms going to and coming from the shared library after a sync, in the status bar. */
export function WaveformStatusPill() {
	const queryClient = useQueryClient();
	const [progress, setProgress] = useState<WaveformProgress | null>(null);
	useEffect(() => {
		let lastRefresh = 0;
		let lastPhase: WaveformProgress["phase"] = "done";
		const off = onWaveformProgress((p) => {
			if (p.phase !== lastPhase) {
				lastRefresh = 0;
				lastPhase = p.phase;
			}
			if (p.phase === "done") {
				setProgress(null);
				void queryClient.invalidateQueries({ queryKey: ["tracks"] });
				return;
			}
			setProgress(p);
			if (p.phase === "download" && p.done - lastRefresh >= REFRESH_EVERY) {
				lastRefresh = p.done;
				void queryClient.invalidateQueries({ queryKey: ["tracks"] });
			}
		});
		return () => {
			void off.then((stop) => stop());
		};
	}, [queryClient]);
	if (!progress) {
		return null;
	}
	return (
		<ProgressPill
			label={progress.phase === "upload" ? "Uploading waveforms" : "Downloading waveforms"}
			done={progress.done}
			total={progress.total}
		/>
	);
}
