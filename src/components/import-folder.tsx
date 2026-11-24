import { useNavigate } from "@tanstack/react-router";
import { Download, FolderOpen, Power, Trash2, Wand2, Zap } from "lucide-react";
import { DestinationHeader, SettingLabel } from "#/components/destination-header.tsx";
import { HistoryList } from "#/components/history-list.tsx";
import { ImportView } from "#/components/import-view.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { MutationErrors } from "#/components/path-setting.tsx";
import { PlaceGone, PlacePage } from "#/components/place-page.tsx";
import { OffBadge, PlaceRow } from "#/components/place-row.tsx";
import { SettingRow, SettingRows } from "#/components/setting-row.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ConfirmButton } from "#/components/ui/confirm-button.tsx";
import { Fact, Facts } from "#/components/ui/facts.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { type ImportFolder, type ImportFolderId, importActivitySource } from "#/lib/api.ts";
import { activityEntries } from "#/lib/history.ts";
import { folderBrand, folderName } from "#/lib/import-folders.ts";
import { countNew } from "#/lib/import-state.ts";
import { useActivity } from "#/lib/queries.ts";
import {
	useImport,
	useImportFolder,
	useImportNewCount,
	useRemoveImportFolder,
	useUpdateImportFolder,
} from "#/lib/use-import.ts";

/** How a folder's songs come in, in a few words. */
function howLine(f: ImportFolder): string {
	const parts = [
		f.autoImport ? "Imports everything new" : "You pick what to import",
		f.convertAac && "AAC converted to MP3",
	];
	return parts.filter(Boolean).join(" · ");
}

/** What the last scan found, as a figure for the page's header. */
function newFigure(s: ReturnType<typeof useImport>): string {
	if (s.find.isPending) {
		return "Scanning…";
	}
	return s.scan === null ? "Not scanned yet" : `${countNew(s.scan).toLocaleString()} new`;
}

/** An import folder as a row of the Import page: what it is, what the last scan found. */
export function ImportFolderRow({ folder }: { folder: ImportFolder }) {
	const navigate = useNavigate();
	const update = useUpdateImportFolder();
	const found = useImportNewCount(folder);
	const open = () => void navigate({ to: "/import/$folderId", params: { folderId: folder.id } });
	return (
		<PlaceRow
			brand={folderBrand(folder.path)}
			name={folderName(folder.path)}
			badge={!folder.enabled && <OffBadge />}
			where={folder.path}
			whereTitle={folder.path}
			fill={
				<span className="text-muted-foreground text-xs tabular-nums">
					{folder.enabled && found !== null ? `${found.toLocaleString()} new` : ""}
				</span>
			}
			status={folder.enabled ? howLine(folder) : "Off"}
			action={
				<Button size="sm" variant="outline" onClick={open}>
					Open
				</Button>
			}
			open={open}
			menu={[
				{
					label: folder.enabled ? "Turn off" : "Turn on",
					icon: <Power />,
					onSelect: () => update.mutate({ ...folder, enabled: !folder.enabled }),
				},
			]}
		/>
	);
}

/** One import folder's page: header, then Import, History and Settings. */
export function ImportFolderPage({ id }: { id: ImportFolderId }) {
	const folder = useImportFolder(id);
	const update = useUpdateImportFolder();
	const s = useImport(folder);
	const history = useActivity(importActivitySource(id));
	if (!folder) {
		return (
			<PlaceGone section="import" icon={<FolderOpen />} title="Folder removed">
				It is no longer one of your import folders.
			</PlaceGone>
		);
	}
	return (
		<PlacePage
			key={id}
			enabled={folder.enabled}
			main={{ label: "Import", icon: <Download />, content: <ImportView s={s} /> }}
			header={(tabs) => (
				<>
					<DestinationHeader
						section="import"
						place={`import:${id}`}
						tabs={tabs}
						brand={folderBrand(folder.path)}
						title={folderName(folder.path)}
						titleHint={folder.path}
						meta={<span>{folder.enabled ? newFigure(s) : "Off"}</span>}
						toggle={
							// The switch says what it switches: a bare one in a header reads as nothing.
							<span
								className="flex items-center gap-2 text-muted-foreground text-xs"
								data-hint="Off: manplay stops looking in this folder. Nothing is removed."
							>
								{folder.enabled ? "Watching" : "Not watching"}
								<Switch
									checked={folder.enabled}
									onChange={(enabled) => update.mutate({ ...folder, enabled })}
									label={`Import from ${folderName(folder.path)}`}
								/>
							</span>
						}
					/>
					<MutationErrors mutations={[update]} />
				</>
			)}
			history={
				<HistoryList
					entries={activityEntries(history.data ?? [], "import")}
					empty="Nothing imported yet"
					titled
				/>
			}
			settings={<ImportFolderSettings folder={folder} />}
		/>
	);
}

/** How one folder's songs come in, and removing it. */
export function ImportFolderSettings({ folder }: { folder: ImportFolder }) {
	const navigate = useNavigate();
	const update = useUpdateImportFolder();
	const remove = useRemoveImportFolder();
	const set = (change: Partial<ImportFolder>) => update.mutate({ ...folder, ...change });
	return (
		<div className="space-y-3">
			<SettingRows title="Folder">
				<SettingRow
					label={<SettingLabel icon={<FolderOpen />} title="Location" hint={folder.path} />}
				>
					{null}
				</SettingRow>
				<SettingRow
					label={
						<SettingLabel
							icon={<Zap />}
							title="Import everything new"
							hint="New songs import on launch and every few minutes. Off: you choose what to import."
						/>
					}
				>
					<Switch
						checked={folder.autoImport}
						onChange={(autoImport) => set({ autoImport })}
						label="Import everything new"
					/>
				</SettingRow>
				<SettingRow
					label={
						<SettingLabel
							icon={<Wand2 />}
							title="Convert AAC to MP3"
							hint="AAC songs (.m4a) import as 320 kbps MP3 with tags and cover. Originals stay in the folder."
						/>
					}
				>
					<Switch
						checked={folder.convertAac}
						onChange={(convertAac) => set({ convertAac })}
						label="Convert AAC to MP3"
					/>
				</SettingRow>
				<SettingRow
					label={
						<SettingLabel
							icon={<Trash2 className="text-destructive" />}
							title="Stop importing from here"
							hint="manplay forgets this folder. Its files, and the songs already imported, stay where they are."
						/>
					}
				>
					<ConfirmButton
						size="sm"
						variant="outline"
						className="text-destructive"
						disabled={remove.isPending}
						destructive
						confirmLabel={`Stop importing from ${folderName(folder.path)}`}
						consequence={
							<Facts label="The folder, imported songs and history stay.">
								<Fact tone="kept">Folder's files</Fact>
								<Fact tone="kept">Imported songs</Fact>
								<Fact tone="kept">History</Fact>
							</Facts>
						}
						onConfirm={() =>
							remove.mutate(folder.id, {
								onSuccess: () => void navigate({ to: "/import" }),
							})
						}
					>
						Remove
					</ConfirmButton>
				</SettingRow>
			</SettingRows>
			{update.isError && <ErrorLine>{String(update.error)}</ErrorLine>}
			{remove.isError && <ErrorLine>{String(remove.error)}</ErrorLine>}
		</div>
	);
}
