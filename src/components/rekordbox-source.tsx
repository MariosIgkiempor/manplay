import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FileDown, FolderOpen } from "lucide-react";
import { useState } from "react";
import { MutationErrors, PathSetting } from "#/components/path-setting.tsx";
import { SourceCard } from "#/components/source-card.tsx";
import { SourcePanel } from "#/components/source-panel.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useDetail } from "#/context/detail-context.ts";
import {
	exportRekordbox,
	pickRekordboxFile,
	type RekordboxStatus,
	rekordboxStatus,
	setRekordboxPath,
} from "#/lib/api.ts";
import { timeAgo } from "#/lib/format.ts";
import { activityEntries } from "#/lib/history.ts";
import { useActivity, useServices } from "#/lib/queries.ts";

const STEPS = [
	"In rekordbox open Settings → Advanced → Database, and under “rekordbox xml” click Browse and choose the file above.",
	"In Settings → View → Layout, tick “rekordbox xml” so it appears in the left-hand tree.",
	"Open “rekordbox xml” → “manplay” in the tree, right-click a playlist and choose Import Playlist.",
] as const;

function useRekordbox() {
	const queryClient = useQueryClient();
	const status = useQuery({ queryKey: ["rekordbox"], queryFn: rekordboxStatus });
	const update = (next: RekordboxStatus) => {
		queryClient.setQueryData(["rekordbox"], next);
		void queryClient.invalidateQueries({ queryKey: ["activity", "rekordbox"] });
	};
	const choose = useMutation({
		mutationFn: async () => {
			const path = await pickRekordboxFile();
			return path === null ? null : setRekordboxPath(path);
		},
		onSuccess: (next) => {
			if (next) {
				update(next);
			}
		},
	});
	const exportNow = useMutation({ mutationFn: exportRekordbox, onSuccess: update });
	const stop = useMutation({ mutationFn: () => setRekordboxPath(null), onSuccess: update });
	const services = useServices();
	return {
		status,
		choose,
		exportNow,
		stop,
		enabled: services.isEnabled("rekordbox", status.data?.path != null),
		setEnabled: (on: boolean) => services.setEnabled("rekordbox", on),
	};
}

function lastLine(s: RekordboxStatus | undefined) {
	if (!s) {
		return "";
	}
	if (s.error) {
		return <span className="text-destructive">{s.error}</span>;
	}
	if (s.exportedAt === null) {
		return "Not exported yet";
	}
	return `Updated ${timeAgo(s.exportedAt)} · ${s.playlists} ${s.playlists === 1 ? "playlist" : "playlists"} · ${s.tracks} tracks`;
}

export function RekordboxCard() {
	const detail = useDetail();
	const { status, choose, exportNow, enabled, setEnabled } = useRekordbox();
	const path = status.data?.path ?? null;
	return (
		<SourceCard
			brand="rekordbox"
			title="Rekordbox"
			subtitle={path ?? "No file chosen"}
			enabled={enabled}
			onToggle={setEnabled}
			status={lastLine(status.data)}
			onOpen={() => detail.open({ kind: "service", service: "rekordbox" })}
			action={
				path === null ? (
					<Button size="sm" onClick={() => choose.mutate()} disabled={choose.isPending}>
						<FolderOpen /> Choose location…
					</Button>
				) : (
					<Button size="sm" onClick={() => exportNow.mutate()} disabled={exportNow.isPending}>
						<FileDown /> Export now
					</Button>
				)
			}
		/>
	);
}

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
				Menu names can differ slightly between rekordbox versions. manplay rewrites the file
				whenever a playlist or the library changes, but rekordbox only reads it when you import, so
				re-import a playlist after changing it.
			</p>
		</details>
	);
}

export function RekordboxPanel() {
	const { status, choose, exportNow, stop, enabled, setEnabled } = useRekordbox();
	const history = useActivity("rekordbox");
	const [copied, setCopied] = useState(false);
	const path = status.data?.path ?? null;

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

	return (
		<SourcePanel
			brand="rekordbox"
			title="Rekordbox"
			subtitle="Your whole library and playlists as a rekordbox library file. Playlists appear in a “manplay” folder."
			enabled={enabled}
			onToggle={setEnabled}
			empty="Not exported yet."
			entries={activityEntries(history.data ?? [], "rekordbox")}
			settings={
				<>
					<PathSetting
						path={path}
						emptyHint="Choose where manplay should save a rekordbox library file. It is kept up to date automatically after that."
					>
						<Button
							variant={path === null ? "default" : "outline"}
							onClick={() => choose.mutate()}
							disabled={choose.isPending}
						>
							<FolderOpen /> {path === null ? "Choose location…" : "Change location…"}
						</Button>
						{path !== null && (
							<>
								<Button onClick={() => exportNow.mutate()} disabled={exportNow.isPending}>
									<FileDown /> Export now
								</Button>
								<Button variant="outline" onClick={() => void copy()}>
									<Copy /> {copied ? "Copied" : "Copy path"}
								</Button>
								<Button variant="ghost" onClick={() => stop.mutate()} disabled={stop.isPending}>
									Stop exporting
								</Button>
							</>
						)}
					</PathSetting>
					<MutationErrors mutations={[choose, exportNow, stop]} />
					<Setup />
				</>
			}
		/>
	);
}
