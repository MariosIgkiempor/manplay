import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FolderOpen, RefreshCw } from "lucide-react";
import { MutationErrors, PathSetting } from "#/components/path-setting.tsx";
import { SourceCard } from "#/components/source-card.tsx";
import { SourcePanel } from "#/components/source-panel.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useDetail } from "#/context/detail-context.ts";
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

export function ItunesCard() {
	const detail = useDetail();
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
			onOpen={() => detail.open({ kind: "service", service: "itunes" })}
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

export function ItunesPanel() {
	const { status, choose, stop, run, root, enabled, setEnabled } = useItunes();
	const history = useActivity("itunes");
	const path = status.data?.path ?? null;
	return (
		<SourcePanel
			brand="itunes"
			title="iTunes"
			subtitle="Converted to 320 kbps MP3 and filed under artist/album. The iTunes folder is never changed. Also runs each time manplay starts."
			enabled={enabled}
			onToggle={setEnabled}
			empty="Nothing imported yet."
			entries={activityEntries(history.data ?? [], "itunes")}
			settings={
				<>
					{root.data === null && (
						<p className="text-destructive text-sm">
							Choose your library folder first (Library page).
						</p>
					)}
					<PathSetting path={path} emptyHint={EMPTY_HINT}>
						<Button
							variant={path === null ? "default" : "outline"}
							onClick={() => choose.mutate()}
							disabled={choose.isPending}
						>
							<FolderOpen /> {path === null ? "Choose folder…" : "Change folder…"}
						</Button>
						{path !== null && (
							<>
								<Button onClick={() => run.mutate()} disabled={run.isPending || root.data === null}>
									<RefreshCw className={run.isPending ? "animate-spin" : undefined} />
									{run.isPending ? "Converting…" : "Import now"}
								</Button>
								<Button variant="ghost" onClick={() => stop.mutate()} disabled={stop.isPending}>
									Stop importing
								</Button>
							</>
						)}
					</PathSetting>
					<MutationErrors mutations={[choose, stop, run]} />
				</>
			}
		/>
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
				<h3 className="font-medium text-sm">iTunes</h3>
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
				<div className="flex items-center gap-2 rounded-xl border border-dashed p-4 text-muted-foreground text-sm">
					<CheckCircle2 className="size-4" />
					{pending.isPending ? "Checking iTunes…" : "All caught up. Nothing new in iTunes."}
				</div>
			) : (
				<ul className="divide-y rounded-xl border text-sm">
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
