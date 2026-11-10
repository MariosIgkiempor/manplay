import { CircleAlert, CircleCheck } from "lucide-react";
import type { SyncRun } from "#/lib/api.ts";
import { timeAgo } from "#/lib/format.ts";

export function SyncHistory({ runs }: { runs: readonly SyncRun[] }) {
	if (runs.length === 0) {
		return <p className="text-muted-foreground text-sm">No syncs yet.</p>;
	}
	return (
		<ul className="divide-y rounded-xl border bg-card">
			{runs.map((r) => {
				const Icon = r.failed > 0 ? CircleAlert : CircleCheck;
				return (
					<li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
						<Icon
							className={
								r.failed > 0 ? "size-4 shrink-0 text-amber-500" : "size-4 shrink-0 text-emerald-500"
							}
						/>
						<div className="min-w-0 flex-1">
							<div className="truncate">
								{r.machine} <span className="text-muted-foreground">/ {r.path.join(" / ")}</span>
							</div>
							{r.firstError && (
								<div className="truncate text-destructive text-xs" title={r.firstError}>
									{r.firstError}
								</div>
							)}
						</div>
						<div className="shrink-0 text-muted-foreground text-xs tabular-nums">
							{r.uploaded} uploaded · {r.skipped} up to date
							{r.failed > 0 && ` · ${r.failed} failed`}
						</div>
						<div className="w-24 shrink-0 text-right text-muted-foreground text-xs">
							{timeAgo(r.finishedAt)}
						</div>
					</li>
				);
			})}
		</ul>
	);
}
