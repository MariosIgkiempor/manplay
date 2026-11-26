import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ProgressPill } from "#/components/progress-pill.tsx";
import { onSongFetchProgress, type SongFetchProgress } from "#/lib/api.ts";

/** Songs other devices added coming down from the shared library's destination, in the status bar. */
export function SongFetchStatusPill() {
	const queryClient = useQueryClient();
	const [progress, setProgress] = useState<SongFetchProgress | null>(null);
	useEffect(() => {
		const off = onSongFetchProgress((p) => {
			if (p.total === 0) {
				setProgress(null);
				void queryClient.invalidateQueries({ queryKey: ["tracks"] });
				return;
			}
			setProgress(p);
		});
		return () => {
			void off.then((stop) => stop());
		};
	}, [queryClient]);
	if (!progress) {
		return null;
	}
	return <ProgressPill label="Downloading songs" done={progress.done} total={progress.total} />;
}
