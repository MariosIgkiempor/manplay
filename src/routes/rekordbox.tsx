import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RekordboxExport } from "#/components/rekordbox-export.tsx";
import { rekordboxStatus } from "#/lib/api.ts";

export const Route = createFileRoute("/rekordbox")({ component: RekordboxPage });

const STEPS = [
	"In rekordbox open Settings → Advanced → Database, and under “rekordbox xml” click Browse and choose the file above.",
	"In Settings → View → Layout, tick “rekordbox xml” so it appears in the left-hand tree.",
	"Open “rekordbox xml” → “manplay” in the tree, right-click a playlist and choose Import Playlist.",
] as const;

function RekordboxPage() {
	const status = useQuery({ queryKey: ["rekordbox"], queryFn: rekordboxStatus });

	return (
		<main className="max-w-3xl space-y-6 p-6">
			<header>
				<h1 className="font-bold text-2xl">Rekordbox</h1>
				<p className="text-muted-foreground text-sm">
					Your whole library and your playlists, as a rekordbox library file. Playlists appear in a
					“manplay” folder.
				</p>
			</header>

			{status.isError && <p className="text-destructive text-sm">{String(status.error)}</p>}
			{status.data && <RekordboxExport status={status.data} />}

			<section className="space-y-3 rounded-xl border bg-card p-4">
				<h2 className="font-medium">One-time setup in rekordbox</h2>
				<ol className="list-decimal space-y-2 pl-5 text-sm">
					{STEPS.map((step) => (
						<li key={step}>{step}</li>
					))}
				</ol>
				<p className="text-muted-foreground text-xs">
					Menu names can differ slightly between rekordbox versions.
				</p>
			</section>

			<section className="space-y-2 rounded-xl border bg-card p-4">
				<h2 className="font-medium">After you change a playlist</h2>
				<p className="text-sm">
					manplay rewrites the file whenever a playlist or the library changes, but rekordbox only
					reads it when you import. Re-import the playlist in rekordbox to pick up the changes.
				</p>
			</section>
		</main>
	);
}
