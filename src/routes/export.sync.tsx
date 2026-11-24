import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus, RefreshCw, Upload } from "lucide-react";
import { EmptyState } from "#/components/page.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { PlaceFrame } from "#/components/place-page.tsx";
import { type SyncMode, SyncPanel } from "#/components/sync-summary.tsx";
import { Button } from "#/components/ui/button.tsx";
import { PAGE_ART } from "#/lib/page-layout.ts";
import { syncSearchSchema } from "#/lib/place-routes.ts";
import { useSyncTargets } from "#/lib/queries.ts";
import { cn } from "#/lib/utils.ts";

export const Route = createFileRoute("/export/sync")({
	validateSearch: (search) => syncSearchSchema.parse(search),
	component: SyncRoute,
});

const ABOUT: Record<SyncMode, string> = {
	both: "Send your changes, bring in theirs, decide about files only they have",
	pull: "Starts with what comes into your library",
	push: "Starts with what goes to destinations",
};

/**
 * One review of several destinations, as a page of its own: what to send, bring in and settle.
 * A lone destination is reviewed on its own page instead.
 */
function SyncRoute() {
	const { mode = "both", ids } = Route.useSearch();
	const navigate = useNavigate();
	const targets = useSyncTargets();
	const all = ids ?? targets.data?.map((t) => t.id) ?? [];
	return (
		<PlaceFrame
			flush
			header={
				<PageHeader
					art={
						<div
							className={cn(
								PAGE_ART,
								"grid place-items-center bg-primary/15 text-primary [&_svg]:size-4",
							)}
						>
							<RefreshCw />
						</div>
					}
					title={`Sync ${all.length.toLocaleString()} destinations`}
					meta={ABOUT[mode]}
				/>
			}
		>
			{targets.isSuccess && all.length === 0 && (
				<div className="p-6">
					<EmptyState
						icon={<Upload />}
						title="No destinations to sync"
						action={
							<Button size="sm" onClick={() => void navigate({ to: "/export/add", search: {} })}>
								<Plus /> Add destination
							</Button>
						}
					>
						A Tailscale folder or an R2 bucket can be synced.
					</EmptyState>
				</div>
			)}
			{all.length > 0 && (
				<SyncPanel
					key={`${mode}:${all.join(",")}`}
					ids={all}
					mode={mode}
					variant="page"
					onClose={() => void navigate({ to: "/export" })}
				/>
			)}
		</PlaceFrame>
	);
}
