import { createFileRoute } from "@tanstack/react-router";
import { Upload } from "lucide-react";
import { useEffect } from "react";
import { Destinations } from "#/components/destinations.tsx";
import { Page } from "#/components/page.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { PullButton, SyncButton } from "#/components/sync-flow.tsx";
import { SyncReviewButton } from "#/components/sync-review.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { useSyncTargets, useTracks } from "#/lib/queries.ts";

export const Route = createFileRoute("/export")({
	component: ExportPage,
	/** `usb`: a drive's mount point to open, e.g. from the sidebar. */
	validateSearch: ({ usb }: { usb?: unknown }): { usb?: string } =>
		typeof usb === "string" ? { usb } : {},
});

/** Opens the drive the page was asked for, then drops it from the address so asking again works. */
function useOpenDrive() {
	const { usb } = Route.useSearch();
	const navigate = Route.useNavigate();
	const { open } = useDetail();
	useEffect(() => {
		if (usb) {
			open({ kind: "usb", mount: usb });
			void navigate({ search: {}, replace: true });
		}
	}, [usb, open, navigate]);
}

function ExportPage() {
	useOpenDrive();
	const progress = useSyncProgress();
	const targets = useSyncTargets();
	const tracks = useTracks();
	const targetCount = targets.data?.length ?? 0;
	const pending =
		targetCount === 0 ? 0 : (tracks.data ?? []).filter((t) => t.syncedCount < targetCount).length;
	const busy = progress.size > 0;

	return (
		<Page
			title="Export"
			icon={<Upload />}
			meta={
				<>
					<span>
						{targetCount} {targetCount === 1 ? "destination" : "destinations"}
					</span>
					<span>
						{pending === 0 ? "Everything synced" : `${pending.toLocaleString()} songs to sync`}
					</span>
				</>
			}
			actions={
				<>
					<PullButton disabled={busy || targetCount === 0} />
					<SyncReviewButton variant="outline" disabled={busy || targetCount === 0} />
					<SyncButton disabled={busy || targetCount === 0} label="Sync all" />
				</>
			}
		>
			<Destinations />
			<StatusBar>
				<Stat label="Destinations" value={targetCount} />
				<Stat label="Songs to sync" value={pending} />
			</StatusBar>
		</Page>
	);
}
