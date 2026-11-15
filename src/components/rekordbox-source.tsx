import { Copy, FolderOpen, Trash2 } from "lucide-react";
import { useState } from "react";
import { MutationErrors, PathSetting } from "#/components/path-setting.tsx";
import { RekordboxExportButton } from "#/components/rekordbox-view.tsx";
import { SourcePanel } from "#/components/source-panel.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useDetail } from "#/context/detail-context.ts";
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

export function RekordboxPanel() {
	const { status, choose, stop } = useRekordbox();
	const { close } = useDetail();
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
			subtitle="Your library and chosen playlists as a rekordbox XML file"
			empty="Not exported yet."
			entries={activityEntries(history.data ?? [], "rekordbox")}
			settings={
				<>
					<PathSetting path={path} emptyHint="Nothing is written until you export.">
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
								<Button
									variant="ghost"
									className="ml-auto hover:text-destructive"
									title="Stop exporting. The file stays where it is."
									onClick={() => stop.mutate(undefined, { onSuccess: close })}
									disabled={stop.isPending}
								>
									<Trash2 /> Remove
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
