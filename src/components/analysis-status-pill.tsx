import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { ProgressPill } from "#/components/progress-pill.tsx";
import { cancelAnalysis } from "#/lib/api.ts";
import { progressLabel, useAnalysisProgress } from "#/lib/use-analysis-progress.ts";

/** Show new results in the lists every this many files. */
const REFRESH_EVERY = 10;

/** BPM and key analysis progress for the status bar. Click for the analysis in Settings. */
export function AnalysisStatusPill() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { running, progress } = useAnalysisProgress();
	const [stopping, setStopping] = useState(false);

	const done = progress?.phase === "analyzing" ? progress.done : 0;
	useEffect(() => {
		if (done > 0 && done % REFRESH_EVERY === 0) {
			void queryClient.invalidateQueries({ queryKey: ["tracks"] });
		}
	}, [done, queryClient]);

	useEffect(() => {
		if (!running) {
			setStopping(false);
		}
	}, [running]);

	if (!running) {
		return null;
	}
	return (
		<div className="flex items-center gap-1.5">
			<button
				type="button"
				title="Show analysis details"
				className="rounded-md px-1.5 py-0.5 hover:bg-primary/10"
				onClick={() => void navigate({ to: "/settings", search: { section: "analysis" } })}
			>
				<ProgressPill
					label={progressLabel(progress, stopping)}
					done={progress?.done ?? 0}
					total={progress?.total ?? 0}
				/>
			</button>
			{progress?.phase !== "saving" && (
				<button
					type="button"
					aria-label="Stop analysis"
					title="Stop analysis (results so far are kept)"
					className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
					disabled={stopping}
					onClick={() => {
						setStopping(true);
						void cancelAnalysis();
					}}
				>
					<X className="size-3.5" />
				</button>
			)}
		</div>
	);
}
