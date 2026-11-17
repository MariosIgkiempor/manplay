import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CheckCircle2, FileAudio, FolderOpen, Music, RefreshCw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { DestinationHeader, FolderFigure, SettingLabel } from "#/components/destination-header.tsx";
import { HistoryList } from "#/components/history-list.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { MutationErrors } from "#/components/path-setting.tsx";
import { PlacePage } from "#/components/place-page.tsx";
import { SettingRow, SettingRows } from "#/components/setting-row.tsx";
import { SourceCard } from "#/components/source-card.tsx";
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
import { typeScale } from "#/lib/type-scale.ts";

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

export function ItunesCard() {
	const navigate = useNavigate();
	const { status, choose, run, root, enabled, setEnabled } = useItunes();
	const path = status.data?.path ?? null;
	return (
		<SourceCard
			brand="itunes"
			title="iTunes"
			subtitle={path ?? "No folder chosen"}
			enabled={enabled}
			onToggle={setEnabled}
			status={lastLine(status.data)}
			onOpen={() => void navigate({ to: "/import/itunes" })}
			action={
				path === null ? (
					<Button size="sm" onClick={() => choose.mutate()} disabled={choose.isPending}>
						<FolderOpen /> Choose folder…
					</Button>
				) : (
					<Button
						size="sm"
						onClick={() => run.mutate()}
						disabled={run.isPending || root.data === null}
					>
						<RefreshCw className={run.isPending ? "animate-spin" : undefined} />
						{run.isPending ? "Converting…" : "Import now"}
					</Button>
				)
			}
		/>
	);
}

/** The iTunes source, laid out like an export destination: header, then History and Settings. */
export function ItunesPage() {
	const { status, choose, stop, run, root, enabled, setEnabled } = useItunes();
	const history = useActivity("itunes");
	const path = status.data?.path ?? null;
	const chooseButton = (
		<Button
			size="sm"
			variant={path === null ? "default" : "outline"}
			onClick={() => choose.mutate()}
			disabled={choose.isPending}
		>
			<FolderOpen /> {path === null ? "Choose folder…" : "Change…"}
		</Button>
	);
	return (
		<PlacePage
			enabled={enabled}
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
						meta={
							<>
								<span>{lastLine(status.data)}</span>
								<FolderFigure path={path} />
							</>
						}
						toggle={<Switch checked={enabled} onChange={setEnabled} label="Enable iTunes" />}
						actions={
							path === null ? (
								chooseButton
							) : (
								<Button
									size="sm"
									onClick={() => run.mutate()}
									disabled={!enabled || run.isPending || root.data === null}
								>
									<RefreshCw className={run.isPending ? "animate-spin" : undefined} />
									{run.isPending ? "Converting…" : "Import now"}
								</Button>
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
		<SettingRows>
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
	const { status, run, root, enabled } = useItunes();
	const path = status.data?.path ?? null;
	const pending = useItunesPending(enabled && path !== null);
	const songs = pending.data ?? [];
	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-2">
				<h3 className={typeScale.label}>iTunes</h3>
				<Button
					size="sm"
					onClick={() => run.mutate()}
					disabled={run.isPending || root.data === null || songs.length === 0}
				>
					<RefreshCw className={run.isPending ? "animate-spin" : undefined} />
					{run.isPending ? "Converting…" : `Import all (${songs.length})`}
				</Button>
			</div>
			{songs.length === 0 ? (
				<div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-muted-foreground text-sm">
					<CheckCircle2 className="size-4" />
					{pending.isPending ? "Checking iTunes…" : "All caught up. Nothing new in iTunes."}
				</div>
			) : (
				<ul className="divide-y rounded-lg border text-sm">
					{songs.slice(0, 50).map((c) => (
						<li key={c.dest} className="px-3 py-2">
							<span className="font-medium">{c.title}</span>
							<span className="text-muted-foreground">
								{" "}
								· {c.artist} · {c.album}
							</span>
						</li>
					))}
					{songs.length > 50 && (
						<li className="px-3 py-2 text-muted-foreground">…and {songs.length - 50} more</li>
					)}
				</ul>
			)}
		</div>
	);
}

/** True when the iTunes service is on and a folder is chosen. */
export function useItunesOn(): boolean {
	const { status, enabled } = useItunes();
	return enabled && (status.data?.path ?? null) !== null;
}
