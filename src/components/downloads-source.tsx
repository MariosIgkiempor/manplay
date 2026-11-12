import { useQuery } from "@tanstack/react-query";
import { FolderOpen, RefreshCw } from "lucide-react";
import { MutationErrors, PathSetting } from "#/components/path-setting.tsx";
import { SourceCard } from "#/components/source-card.tsx";
import { SourcePanel } from "#/components/source-panel.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { importGetFolder } from "#/lib/api.ts";
import { activityEntries } from "#/lib/history.ts";
import { countNew } from "#/lib/import-state.ts";
import { useActivity, useServices } from "#/lib/queries.ts";
import { useChooseImportFolder, type useImport } from "#/lib/use-import.ts";

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

export function DownloadsCard({ s }: { s: ReturnType<typeof useImport> }) {
	const detail = useDetail();
	const { enabled, setEnabled } = useDownloadsEnabled();
	return (
		<SourceCard
			brand="downloads"
			title="Downloads"
			subtitle={s.folder ?? "No folder chosen"}
			enabled={enabled}
			onToggle={setEnabled}
			status={statusLine(s)}
			onOpen={() => detail.open({ kind: "service", service: "downloads" })}
			action={
				s.folder === null ? (
					<Button size="sm" onClick={() => s.choose.mutate()} disabled={s.choose.isPending}>
						<FolderOpen /> Choose folder…
					</Button>
				) : (
					<Button size="sm" onClick={() => s.rescan(false)} disabled={s.find.isPending}>
						<RefreshCw className={s.find.isPending ? "animate-spin" : undefined} />
						{s.find.isPending ? "Scanning…" : "Rescan"}
					</Button>
				)
			}
		/>
	);
}

export function DownloadsPanel() {
	const folder = useQuery({ queryKey: ["import-folder"], queryFn: importGetFolder });
	const choose = useChooseImportFolder();
	const history = useActivity("downloads");
	const path = folder.data ?? null;
	const { enabled, setEnabled } = useDownloadsEnabled();
	return (
		<SourcePanel
			brand="downloads"
			title="Downloads"
			subtitle="New music in this folder, newest first. Zips are searched too. Nothing is moved or deleted."
			enabled={enabled}
			onToggle={setEnabled}
			empty="Nothing imported yet."
			entries={activityEntries(history.data ?? [], "downloads")}
			settings={
				<>
					<PathSetting path={path} emptyHint="Choose a folder to look for new music.">
						<Button
							variant={path === null ? "default" : "outline"}
							onClick={() => choose.mutate()}
							disabled={choose.isPending}
						>
							<FolderOpen /> {path === null ? "Choose folder…" : "Change folder…"}
						</Button>
					</PathSetting>
					<MutationErrors mutations={[choose]} />
				</>
			}
		/>
	);
}
