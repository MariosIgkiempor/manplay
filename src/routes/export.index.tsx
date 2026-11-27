import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CloudUpload, Download, Plus, Rows3, Settings2 } from "lucide-react";
import { useState } from "react";
import { Destinations } from "#/components/destinations.tsx";
import { HeaderMenu } from "#/components/header-menu.tsx";
import { HistoryList } from "#/components/history-list.tsx";
import { EmptyState, Page } from "#/components/page.tsx";
import { type OverviewTab, OverviewTabs, PlaceSettingsGroup } from "#/components/place-page.tsx";
import { SyncButton } from "#/components/sync-flow.tsx";
import { DestinationSettings } from "#/components/target-page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { DriveSettings } from "#/components/usb-drives.tsx";
import { useSyncActions } from "#/context/sync-actions-context.ts";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { isR2, targetShortName } from "#/lib/api.ts";
import { syncEntries } from "#/lib/history.ts";
import { useSyncHistory, useSyncTargets, useTracks } from "#/lib/queries.ts";
import { useUsbDrives } from "#/lib/use-usb.ts";

export const Route = createFileRoute("/export/")({ component: ExportPage });

function ExportPage() {
	const [tab, setTab] = useState<OverviewTab>("list");
	const progress = useSyncProgress();
	const { start } = useSyncActions();
	const targets = useSyncTargets();
	const tracks = useTracks();
	const targetCount = targets.data?.length ?? 0;
	const pending =
		targetCount === 0 ? 0 : (tracks.data ?? []).filter((t) => t.syncedCount < targetCount).length;
	const busy = progress.size > 0;

	return (
		<Page
			title="Export"
			meta={
				<>
					<span>
						{targetCount} {targetCount === 1 ? "destination" : "destinations"}
					</span>
					{targetCount > 0 && (
						<span>
							{pending === 0 ? "Everything synced" : `${pending.toLocaleString()} songs to sync`}
						</span>
					)}
				</>
			}
			actions={
				<>
					<SyncButton disabled={busy || targetCount === 0} label="Sync all" />
					<HeaderMenu
						entries={[
							{
								label: "Only bring into your library…",
								icon: <Download />,
								onSelect: () => start("pull"),
								disabled: busy || targetCount === 0,
							},
							{
								label: "Only send to destinations…",
								icon: <CloudUpload />,
								onSelect: () => start("push"),
								disabled: busy || targetCount === 0,
							},
						]}
					/>
				</>
			}
			tabs={
				<OverviewTabs
					tab={tab}
					onChange={setTab}
					list={{ label: "Destinations", icon: <Rows3 /> }}
				/>
			}
		>
			{tab === "list" && <Destinations />}
			{tab === "history" && <ExportHistory />}
			{tab === "settings" && <ExportSettings />}
		</Page>
	);
}

/** Every sync, newest first, each run marked with where it went. */
function ExportHistory() {
	const syncs = useSyncHistory();
	return (
		<HistoryList marked entries={syncEntries(syncs.data ?? [])} empty="Nothing exported yet" />
	);
}

/** Every destination's settings, one after the other: synced folders, drives. */
function ExportSettings() {
	const navigate = useNavigate();
	const targets = useSyncTargets().data ?? [];
	const drives = useUsbDrives().data ?? [];
	if (targets.length === 0 && drives.length === 0) {
		return (
			<EmptyState
				icon={<Settings2 />}
				title="No destinations to set up"
				action={
					<Button size="sm" onClick={() => void navigate({ to: "/export/add", search: {} })}>
						<Plus /> Add destination
					</Button>
				}
			>
				Each destination's settings show here once it is added.
			</EmptyState>
		);
	}
	return (
		<div className="space-y-10">
			{targets.map((t) => (
				<PlaceSettingsGroup
					key={t.id}
					brand={isR2(t) ? "cloudflare" : "tailscale"}
					title={targetShortName(t)}
					detail={`${t.machine}: ${t.path.join(" / ") || "bucket root"}`}
					onOpen={() => void navigate({ to: "/export/$targetId", params: { targetId: t.id } })}
				>
					<DestinationSettings target={t} />
				</PlaceSettingsGroup>
			))}
			{drives.map((d) => (
				<PlaceSettingsGroup
					key={d.mount}
					brand="usb"
					title={d.name}
					detail={d.mount}
					onOpen={() => void navigate({ to: "/export/usb", search: { mount: d.mount } })}
				>
					<DriveSettings drive={d} />
				</PlaceSettingsGroup>
			))}
		</div>
	);
}
