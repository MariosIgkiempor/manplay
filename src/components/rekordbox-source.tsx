import { Copy, FolderOpen } from "lucide-react";
import { useState } from "react";
import { MutationErrors, PathSetting } from "#/components/path-setting.tsx";
import { RekordboxExportButton } from "#/components/rekordbox-view.tsx";
import { SourceCard } from "#/components/source-card.tsx";
import { SourcePanel } from "#/components/source-panel.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useDetail } from "#/context/detail-context.ts";
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
	const { status, choose, enabled, setEnabled } = useRekordbox();
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
					<RekordboxExportButton size="sm" />
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
				Menu names can differ slightly between rekordbox versions. manplay only rewrites the file
				when you export, and rekordbox only reads it when you import. After changing a playlist,
				export again and re-import it.
			</p>
		</details>
	);
}

export function RekordboxPanel() {
	const { status, choose, stop, enabled, setEnabled } = useRekordbox();
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
			subtitle="Your whole library, plus the playlists and tags you pick, as a rekordbox library file. They appear in a “manplay” folder."
			enabled={enabled}
			onToggle={setEnabled}
			empty="Not exported yet."
			entries={activityEntries(history.data ?? [], "rekordbox")}
			settings={
				<>
					<PathSetting
						path={path}
						emptyHint="Choose where manplay should save a rekordbox library file. Nothing is written until you export."
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
								<RekordboxExportButton label="Choose what to export…" />
								<Button variant="outline" onClick={() => void copy()}>
									<Copy /> {copied ? "Copied" : "Copy path"}
								</Button>
								<Button variant="ghost" onClick={() => stop.mutate()} disabled={stop.isPending}>
									Stop exporting
								</Button>
							</>
						)}
					</PathSetting>
					<MutationErrors mutations={[choose, stop]} />
					<Setup />
				</>
			}
		/>
	);
}
