import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Download, FolderOpen, Power, RefreshCw } from "lucide-react";
import { DestinationHeader, SettingLabel } from "#/components/destination-header.tsx";
import { HistoryList } from "#/components/history-list.tsx";
import { ImportView } from "#/components/import-view.tsx";
import { EmptyState } from "#/components/page.tsx";
import { MutationErrors } from "#/components/path-setting.tsx";
import { PlacePage } from "#/components/place-page.tsx";
import { OffBadge, PlaceRow } from "#/components/place-row.tsx";
import { SettingRow, SettingRows } from "#/components/setting-row.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { importGetFolder } from "#/lib/api.ts";
import { activityEntries } from "#/lib/history.ts";
import { countNew } from "#/lib/import-state.ts";
import { useActivity, useServices } from "#/lib/queries.ts";
import { useChooseImportFolder, useImport } from "#/lib/use-import.ts";

/** Whether Downloads is switched on (on by default once a folder is chosen). */
export function useDownloadsEnabled() {
	const folder = useQuery({ queryKey: ["import-folder"], queryFn: importGetFolder });
	const services = useServices();
	return {
		enabled: services.isEnabled("downloads", folder.data != null),
		setEnabled: (on: boolean) => services.setEnabled("downloads", on),
	};
}

function statusLine(s: ReturnType<typeof useImport>): string {
	if (s.find.isPending) {
		return "Scanning…";
	}
	if (s.scan === null) {
		return s.folder === null ? "Nothing to scan yet" : "Not scanned yet";
	}
	const n = countNew(s.scan);
	return n === 0 ? "All caught up" : `${n.toLocaleString()} new track${n === 1 ? "" : "s"} found`;
}

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Scans the Downloads folder again for new music. */
function RescanButton({
	s,
	enabled,
	variant = "default",
}: {
	s: ReturnType<typeof useImport>;
	enabled: boolean;
	variant?: "default" | "outline";
}) {
	const scanning = s.find.isPending;
	return (
		<Button
			size="sm"
			variant={variant}
			onClick={() => s.rescan(false)}
			disabled={!enabled || scanning}
		>
			<RefreshCw className={scanning ? "animate-spin" : undefined} />
			{scanning ? "Scanning…" : "Rescan"}
		</Button>
	);
}

/** Picks the Downloads folder. */
function ChooseButton({
	choose,
	label,
	variant,
}: {
	choose: { mutate: () => void; isPending: boolean };
	label: string;
	variant: "default" | "outline";
}) {
	return (
		<Button size="sm" variant={variant} onClick={() => choose.mutate()} disabled={choose.isPending}>
			<FolderOpen /> {label}
		</Button>
	);
}

/** Downloads as a row of the Import page: folder, what the last scan found, Rescan. */
export function DownloadsRow({ s }: { s: ReturnType<typeof useImport> }) {
	const navigate = useNavigate();
	const { enabled, setEnabled } = useDownloadsEnabled();
	const found = s.scan === null ? 0 : countNew(s.scan);
	return (
		<PlaceRow
			brand="downloads"
			name={s.folder === null ? "Downloads" : folderName(s.folder)}
			badge={!enabled && <OffBadge />}
			where={s.folder ?? "No folder chosen"}
			whereTitle={s.folder ?? undefined}
			fill={
				<span className="text-muted-foreground text-xs tabular-nums">
					{enabled && s.folder !== null ? `${found.toLocaleString()} new` : ""}
				</span>
			}
			status={enabled ? statusLine(s) : "Off"}
			action={
				s.folder === null ? (
					<ChooseButton choose={s.choose} label="Choose folder…" variant="outline" />
				) : (
					<RescanButton s={s} enabled={enabled} variant="outline" />
				)
			}
			open={() => void navigate({ to: "/import/downloads" })}
			menu={[
				{
					label: enabled ? "Turn off" : "Turn on",
					icon: <Power />,
					onSelect: () => setEnabled(!enabled),
				},
				{ label: "Change folder…", icon: <FolderOpen />, onSelect: () => s.choose.mutate() },
			]}
		/>
	);
}

/** The Downloads source, laid out like an export destination: header, then Import, History and Settings. */
export function DownloadsPage() {
	const folder = useQuery({ queryKey: ["import-folder"], queryFn: importGetFolder });
	const choose = useChooseImportFolder();
	const history = useActivity("downloads");
	const path = folder.data ?? null;
	const { enabled, setEnabled } = useDownloadsEnabled();
	const s = useImport(enabled);
	const chooseButton = (
		<ChooseButton
			choose={choose}
			label={path === null ? "Choose folder…" : "Change…"}
			variant={path === null ? "default" : "outline"}
		/>
	);
	return (
		<PlacePage
			enabled={enabled}
			main={{
				label: "Import",
				icon: <Download />,
				content:
					path === null ? (
						<EmptyState icon={<FolderOpen />} title="No folder chosen" action={chooseButton}>
							Choose the folder your downloads land in.
						</EmptyState>
					) : (
						<ImportView s={s} />
					),
			}}
			header={(tabs) => (
				<>
					<DestinationHeader
						section="import"
						place="downloads"
						tabs={tabs}
						brand="downloads"
						kind={
							<>
								<Download /> Import folder
							</>
						}
						title={path === null ? "Downloads" : folderName(path)}
						titleHint={path ?? undefined}
						meta={<span>{path === null ? "No folder chosen" : "Zips included, newest first"}</span>}
						toggle={<Switch checked={enabled} onChange={setEnabled} label="Enable Downloads" />}
						actions={path === null ? chooseButton : <RescanButton s={s} enabled={enabled} />}
					/>
					<MutationErrors mutations={[choose]} />
				</>
			)}
			history={
				<HistoryList
					entries={activityEntries(history.data ?? [], "downloads")}
					empty="Nothing imported yet."
				/>
			}
			settings={
				<SettingRows>
					<SettingRow
						label={
							<SettingLabel
								icon={<FolderOpen />}
								title="Folder"
								hint={path ?? "Choose a folder to look for new music."}
							/>
						}
					>
						{chooseButton}
					</SettingRow>
				</SettingRows>
			}
		/>
	);
}
