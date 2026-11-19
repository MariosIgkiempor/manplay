import { useNavigate } from "@tanstack/react-router";
import { Copy, FileCode, FolderOpen, History, Settings2, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { DestinationHeader, SettingLabel } from "#/components/destination-header.tsx";
import { HeaderMenu } from "#/components/header-menu.tsx";
import { HistoryList } from "#/components/history-list.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { MutationErrors } from "#/components/path-setting.tsx";
import { PlaceFrame } from "#/components/place-page.tsx";
import { RekordboxExportButton } from "#/components/rekordbox-view.tsx";
import { SettingRow, SettingRows } from "#/components/setting-row.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
import type { RekordboxStatus } from "#/lib/api.ts";
import { timeAgo } from "#/lib/format.ts";
import { activityEntries } from "#/lib/history.ts";
import { useActivity } from "#/lib/queries.ts";
import { useRekordbox } from "#/lib/use-rekordbox.ts";

const STEPS = [
	"In rekordbox open Settings → Advanced → Database, and under “rekordbox xml” click Browse and choose the file above.",
	"In Settings → View → Layout, tick “rekordbox xml” so it appears in the left-hand tree.",
	"Open “rekordbox xml” → “manplay” in the tree, right-click a playlist and choose Import Playlist.",
] as const;

function Setup() {
	return (
		<details className="rounded-lg border p-3 text-sm">
			<summary className="cursor-pointer font-medium">One-time setup in rekordbox</summary>
			<ol className="mt-3 list-decimal space-y-2 pl-5">
				{STEPS.map((step) => (
					<li key={step}>{step}</li>
				))}
			</ol>
			<p className="mt-3 text-muted-foreground text-xs">
				After changing a playlist, export again and re-import it in rekordbox.
			</p>
		</details>
	);
}

type Tab = "history" | "settings";

/** What the file holds and when it was written. */
function FileFigures({ status }: { status: RekordboxStatus | undefined }) {
	if (!status?.path) {
		return <span>No file chosen yet</span>;
	}
	return (
		<>
			<span>
				{plural(status.tracks, "track")} in {plural(status.playlists, "playlist")}
			</span>
			<span>
				{status.exportedAt ? `Exported ${timeAgo(status.exportedAt)}` : "Not exported yet"}
			</span>
		</>
	);
}

function RekordboxSettings({
	path,
	chooseButton,
	onStop,
	stopping,
}: {
	path: string | null;
	chooseButton: ReactNode;
	onStop: () => void;
	stopping: boolean;
}) {
	return (
		<div className="space-y-3">
			<SettingRows>
				<SettingRow
					label={
						<SettingLabel
							icon={<FolderOpen />}
							title="File location"
							hint={path ?? "Nothing is written until you choose where and export."}
						/>
					}
				>
					{chooseButton}
				</SettingRow>
				{path !== null && (
					<SettingRow
						label={
							<SettingLabel
								icon={<Trash2 className="text-destructive" />}
								title="Stop exporting"
								hint="manplay stops writing the file. The file stays where it is."
							/>
						}
					>
						<Button
							size="sm"
							variant="outline"
							className="border-destructive/40 text-destructive hover:bg-destructive/10"
							onClick={onStop}
							disabled={stopping}
						>
							Remove
						</Button>
					</SettingRow>
				)}
			</SettingRows>
			<Setup />
		</div>
	);
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const plural = (n: number, one: string) => `${n.toLocaleString()} ${n === 1 ? one : `${one}s`}`;

/** The rekordbox XML destination, laid out like a USB drive: header, then History and Settings. */
export function RekordboxPage() {
	const { status, choose, stop } = useRekordbox();
	const navigate = useNavigate();
	const history = useActivity("rekordbox");
	const [tab, setTab] = useState<Tab>("history");
	const [copied, setCopied] = useState(false);
	const data = status.data;
	const path = data?.path ?? null;

	const copy = async () => {
		if (path === null) {
			return;
		}
		try {
			await navigator.clipboard.writeText(path);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard access can be denied; the path is also visible on screen.
		}
	};

	const chooseButton = (
		<Button
			size="sm"
			variant={path === null ? "default" : "outline"}
			onClick={() => choose.mutate()}
			disabled={choose.isPending}
		>
			<FolderOpen /> {path === null ? "Choose location…" : "Change…"}
		</Button>
	);

	return (
		<PlaceFrame
			header={
				<DestinationHeader
					section="export"
					place="rekordbox"
					brand="rekordbox"
					kind={
						<>
							<FileCode /> rekordbox XML
						</>
					}
					title={path === null ? "rekordbox" : fileName(path)}
					titleHint={path ?? undefined}
					meta={<FileFigures status={data} />}
					actions={
						path === null ? (
							chooseButton
						) : (
							<>
								<RekordboxExportButton size="sm" label="Export…" />
								<HeaderMenu
									size="sm"
									entries={[
										{
											label: copied ? "Copied" : "Copy path",
											icon: <Copy />,
											onSelect: () => void copy(),
										},
									]}
								/>
							</>
						)
					}
					tabs={
						<Segmented
							className="border-b-0"
							value={tab}
							onChange={setTab}
							label="rekordbox view"
							items={[
								{ value: "history", label: "History", icon: <History /> },
								{ value: "settings", label: "Settings", icon: <Settings2 /> },
							]}
						/>
					}
				/>
			}
		>
			{data?.error && <ErrorLine>{data.error}</ErrorLine>}
			<MutationErrors mutations={[choose, stop]} />
			{tab === "history" ? (
				<HistoryList
					entries={activityEntries(history.data ?? [], "rekordbox")}
					empty="Not exported yet."
				/>
			) : (
				<RekordboxSettings
					path={path}
					chooseButton={chooseButton}
					onStop={() =>
						stop.mutate(undefined, { onSuccess: () => void navigate({ to: "/export" }) })
					}
					stopping={stop.isPending}
				/>
			)}
		</PlaceFrame>
	);
}
