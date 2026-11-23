import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FolderPlus, ImageDown, Rows3 } from "lucide-react";
import { useState } from "react";
import { SettingLabel } from "#/components/destination-header.tsx";
import { FrameSection } from "#/components/frame.tsx";
import { HistoryList } from "#/components/history-list.tsx";
import { ImportFolderRow, ImportFolderSettings } from "#/components/import-folder.tsx";
import { EmptyState, ErrorLine, Page } from "#/components/page.tsx";
import { type OverviewTab, OverviewTabs, PlaceSettingsGroup } from "#/components/place-page.tsx";
import { SettingRow, SettingRows } from "#/components/setting-row.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Fact, Facts } from "#/components/ui/facts.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { type ImportFolder, importActivitySource } from "#/lib/api.ts";
import { activityEntries, mergedHistory } from "#/lib/history.ts";
import { folderBrand, folderName } from "#/lib/import-folders.ts";
import { useActivities, useServices } from "#/lib/queries.ts";
import { useAddImportFolder, useImportFolders, useUpdateImportFolder } from "#/lib/use-import.ts";

export const Route = createFileRoute("/import/")({ component: ImportPage });

/**
 * Every folder music is imported from, like the Export page's destinations, with what all of
 * them imported and all their settings in the other tabs; each folder's page has its import.
 */
function ImportPage() {
	const [tab, setTab] = useState<OverviewTab>("list");
	const folders = useImportFolders().data ?? [];
	const add = useAddImportFolder();
	const navigate = useNavigate();
	const on = folders.filter((f) => f.enabled).length;
	const addButton = (
		<Button
			size="sm"
			variant="outline"
			disabled={add.isPending}
			onClick={() =>
				add.mutate(undefined, {
					onSuccess: (f) =>
						f && void navigate({ to: "/import/$folderId", params: { folderId: f.id } }),
				})
			}
		>
			<FolderPlus /> Add folder
		</Button>
	);
	return (
		<Page
			title="Import"
			meta={
				<span>
					{on} of {folders.length} {folders.length === 1 ? "folder" : "folders"} on
				</span>
			}
			tabs={
				<OverviewTabs tab={tab} onChange={setTab} list={{ label: "Folders", icon: <Rows3 /> }} />
			}
		>
			{add.isError && <ErrorLine>{String(add.error)}</ErrorLine>}
			{tab === "list" &&
				(folders.length === 0 ? (
					<EmptyState icon={<FolderPlus />} title="No import folders yet" action={addButton}>
						<Facts label="Add folders where new music lands.">
							<Fact>Downloads</Fact>
							<Fact>iTunes Media</Fact>
						</Facts>
					</EmptyState>
				) : (
					<FrameSection title="Folders" count={folders.length} action={addButton}>
						{folders.map((f) => (
							<ImportFolderRow key={f.id} folder={f} />
						))}
					</FrameSection>
				))}
			{tab === "history" && <ImportHistory folders={folders} />}
			{tab === "settings" && <ImportSettings folders={folders} />}
		</Page>
	);
}

/** What every folder imported, newest first; each run says which folder it came from. */
function ImportHistory({ folders }: { folders: readonly ImportFolder[] }) {
	const runs = useActivities(folders.map((f) => importActivitySource(f.id)));
	const entries = mergedHistory(
		...folders.map((f, i) =>
			activityEntries(runs[i]?.data ?? [], "import").map((e) => ({
				...e,
				title: `${folderName(f.path)}: ${e.title}`,
			})),
		),
	);
	return <HistoryList marked entries={entries} empty="Nothing imported yet." />;
}

/** Settings for every folder: what applies to all of them, then each folder's own. */
function ImportSettings({ folders }: { folders: readonly ImportFolder[] }) {
	const navigate = useNavigate();
	const services = useServices();
	const update = useUpdateImportFolder();
	return (
		<div className="space-y-10">
			<SettingRows title="All folders">
				<SettingRow
					label={
						<SettingLabel
							icon={<ImageDown />}
							title="Covers for songs bought from Apple"
							hint="Fetch the official cover from Apple when importing iTunes songs. Only the album's catalogue number is sent."
						/>
					}
				>
					<Switch
						checked={services.isEnabled("appleCovers", false)}
						onChange={(on) => services.setEnabled("appleCovers", on)}
						label="Fetch covers for songs bought from Apple"
					/>
				</SettingRow>
			</SettingRows>
			{folders.map((f) => (
				<PlaceSettingsGroup
					key={f.id}
					brand={folderBrand(f.path)}
					title={folderName(f.path)}
					detail={f.path}
					toggle={
						<Switch
							checked={f.enabled}
							onChange={(enabled) => update.mutate({ ...f, enabled })}
							label={`Import from ${folderName(f.path)}`}
						/>
					}
					onOpen={() => void navigate({ to: "/import/$folderId", params: { folderId: f.id } })}
				>
					<ImportFolderSettings folder={f} />
				</PlaceSettingsGroup>
			))}
		</div>
	);
}
