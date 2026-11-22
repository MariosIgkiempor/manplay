import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	CheckCircle2,
	Download,
	FileAudio,
	FolderOpen,
	Music,
	Power,
	RefreshCw,
	Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { DestinationHeader, SettingLabel } from "#/components/destination-header.tsx";
import { FrameSection } from "#/components/frame.tsx";
import { HistoryList } from "#/components/history-list.tsx";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { MutationErrors } from "#/components/path-setting.tsx";
import { PlacePage } from "#/components/place-page.tsx";
import { OffBadge, PlaceRow } from "#/components/place-row.tsx";
import { SettingRow, SettingRows } from "#/components/setting-row.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { type ItunesStatus, itunesStatus, pickItunesFolder, setItunesPath } from "#/lib/api.ts";
import { timeAgo } from "#/lib/format.ts";
import { activityEntries } from "#/lib/history.ts";
import {
	useActivity,
	useItunesImport,
	useItunesPending,
	useLibraryRoot,
	useServices,
} from "#/lib/queries.ts";

const EMPTY_HINT =
	"Pick the folder that holds your purchased songs, usually “iTunes Media” or “Music” inside your iTunes/Music folder.";

function useItunes() {
	const queryClient = useQueryClient();
	const status = useQuery({ queryKey: ["itunes"], queryFn: itunesStatus });
	const update = (next: ItunesStatus) => queryClient.setQueryData(["itunes"], next);
	const choose = useMutation({
		mutationFn: async () => {
			const path = await pickItunesFolder();
			return path === null ? null : setItunesPath(path);
		},
		onSuccess: (next) => {
			if (next) {
				update(next);
			}
		},
	});
	const stop = useMutation({ mutationFn: () => setItunesPath(null), onSuccess: update });
	const services = useServices();
	const path = status.data?.path ?? null;
	return {
		status,
		choose,
		stop,
		run: useItunesImport(),
		root: useLibraryRoot(),
		enabled: services.isEnabled("itunes", path !== null),
		setEnabled: (on: boolean) => services.setEnabled("itunes", on),
	};
}

function lastLine(status: ItunesStatus | undefined) {
	const last = status?.last;
	if (!last) {
		return "Not imported yet";
	}
	if (last.error) {
		return <span className="text-destructive">{last.error}</span>;
	}
	return `Last import ${timeAgo(last.ranAt)} · ${last.converted.length} converted`;
}

/** Converts what is new in the iTunes folder into the library. */
function ImportNowButton({
	run,
	disabled,
	variant = "default",
}: {
	run: { mutate: () => void; isPending: boolean };
	disabled: boolean;
	variant?: "default" | "outline";
}) {
	return (
		<Button
			size="sm"
			variant={variant}
			onClick={() => run.mutate()}
			disabled={disabled || run.isPending}
		>
			<RefreshCw className={run.isPending ? "animate-spin" : undefined} />
			{run.isPending ? "Converting…" : "Import now"}
		</Button>
	);
}

/** Picks the iTunes folder. */
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

/** iTunes as a row of the Import page: folder, songs not in the library yet, Import now. */
export function ItunesRow() {
	const navigate = useNavigate();
	const { status, choose, run, root, enabled, setEnabled } = useItunes();
	const path = status.data?.path ?? null;
	const pending = useItunesPending(enabled && path !== null);
	return (
		<PlaceRow
			brand="itunes"
			name="iTunes"
			badge={!enabled && <OffBadge />}
			where={path ?? "No folder chosen"}
			whereTitle={path ?? undefined}
			fill={
				<span className="text-muted-foreground text-xs tabular-nums">
					{enabled && pending.data ? `${pending.data.length.toLocaleString()} new` : ""}
				</span>
			}
			status={enabled ? lastLine(status.data) : "Off"}
			action={
				path === null ? (
					<ChooseButton choose={choose} label="Choose folder…" variant="outline" />
				) : (
					<ImportNowButton run={run} disabled={!enabled || root.data === null} variant="outline" />
				)
			}
			open={() => void navigate({ to: "/import/itunes" })}
			menu={[
				{
					label: enabled ? "Turn off" : "Turn on",
					icon: <Power />,
					onSelect: () => setEnabled(!enabled),
				},
				{ label: "Change folder…", icon: <FolderOpen />, onSelect: () => choose.mutate() },
			]}
		/>
	);
}

/** The iTunes source, laid out like an export destination: header, then Import, History and Settings. */
export function ItunesPage() {
	const { status, choose, stop, run, root, enabled, setEnabled } = useItunes();
	const history = useActivity("itunes");
	const path = status.data?.path ?? null;
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
							{EMPTY_HINT}
						</EmptyState>
					) : (
						<ItunesPending />
					),
			}}
			header={(tabs) => (
				<>
					<DestinationHeader
						section="import"
						place="itunes"
						tabs={tabs}
						brand="itunes"
						kind={
							<>
								<Music /> Purchased music
							</>
						}
						title="iTunes"
						titleHint={path ?? undefined}
						meta={<span>{lastLine(status.data)}</span>}
						toggle={<Switch checked={enabled} onChange={setEnabled} label="Enable iTunes" />}
						actions={
							path === null ? (
								chooseButton
							) : (
								<ImportNowButton run={run} disabled={!enabled || root.data === null} />
							)
						}
					/>
					{root.data === null && (
						<ErrorLine>Choose your library folder first (Library page).</ErrorLine>
					)}
					<MutationErrors mutations={[choose, stop, run]} />
				</>
			)}
			history={
				<HistoryList
					entries={activityEntries(history.data ?? [], "itunes")}
					empty="Nothing imported yet."
				/>
			}
			settings={
				<ItunesSettings
					path={path}
					chooseButton={chooseButton}
					onStop={() => stop.mutate()}
					stopping={stop.isPending}
				/>
			}
		/>
	);
}

function ItunesSettings({
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
		<SettingRows title="Source">
			<SettingRow
				label={<SettingLabel icon={<FolderOpen />} title="Folder" hint={path ?? EMPTY_HINT} />}
			>
				{chooseButton}
			</SettingRow>
			<SettingRow
				label={
					<SettingLabel
						icon={<FileAudio />}
						title="Conversion"
						hint="Converted to 320 kbps MP3, filed by artist and album in your library."
					/>
				}
			>
				<span className="text-muted-foreground text-xs">MP3, 320 kbps</span>
			</SettingRow>
			{path !== null && (
				<SettingRow
					label={
						<SettingLabel
							icon={<Trash2 className="text-destructive" />}
							title="Stop importing"
							hint="manplay forgets this folder. Songs already imported stay in your library."
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
						Stop
					</Button>
				</SettingRow>
			)}
		</SettingRows>
	);
}

/** Songs in the iTunes folder that are not in the library yet. */
export function ItunesPending() {
	const { status, enabled } = useItunes();
	const path = status.data?.path ?? null;
	const pending = useItunesPending(enabled && path !== null);
	const songs = pending.data ?? [];
	return (
		<div className="space-y-3">
			{/* The header's Import now brings these in; the list only says what it will bring. */}
			<FrameSection
				title="Not in your library yet"
				count={songs.length > 0 ? songs.length : undefined}
				description="Import now, in the header, brings these in."
			>
				{songs.length === 0 ? (
					<div className="flex items-center gap-2 px-4 py-6 text-muted-foreground text-sm">
						<CheckCircle2 className="size-4 text-success" />
						{pending.isPending ? "Checking iTunes…" : "All caught up. Nothing new in iTunes."}
					</div>
				) : (
					<ul className="divide-y divide-hairline text-sm">
						{songs.slice(0, 50).map((c) => (
							<li key={c.dest} className="min-w-0 px-4 py-2.5">
								<div className="truncate font-medium">{c.title}</div>
								<div className="truncate text-muted-foreground text-xs">
									{[c.artist, c.album].filter((x) => x !== "").join(", ")}
								</div>
							</li>
						))}
						{songs.length > 50 && (
							<li className="px-4 py-2.5 text-muted-foreground text-xs">
								And {songs.length - 50} more
							</li>
						)}
					</ul>
				)}
			</FrameSection>
		</div>
	);
}

/** True when the iTunes service is on and a folder is chosen. */
export function useItunesOn(): boolean {
	const { status, enabled } = useItunes();
	return enabled && (status.data?.path ?? null) !== null;
}
