import { TriangleAlert } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { useLibraryStatus, useRemoveMissing } from "#/lib/queries.ts";

/** Shown when files vanished from disk; they are only removed after a grace period. */
export function MissingBanner() {
	const status = useLibraryStatus();
	const remove = useRemoveMissing();
	const data = status.data;
	if (!data || data.missing === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
			<TriangleAlert className="size-4 shrink-0 text-amber-500" />
			<span className="flex-1">
				{data.missing} {data.missing === 1 ? "file is" : "files are"} missing from disk. They are
				hidden, keep their playlists and tags, and come back if the files return. After{" "}
				{data.graceDays} days they are removed here and from sync destinations.
			</span>
			<Button
				variant="outline"
				size="sm"
				disabled={remove.isPending}
				onClick={() => {
					if (
						window.confirm(
							`Remove ${data.missing} missing tracks now, including their copies on sync destinations?`,
						)
					) {
						remove.mutate();
					}
				}}
			>
				Remove now
			</Button>
			{remove.isError && <span className="text-destructive">{String(remove.error)}</span>}
		</div>
	);
}
