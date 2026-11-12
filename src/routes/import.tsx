import { createFileRoute } from "@tanstack/react-router";
import { DownloadsCard, useDownloadsEnabled } from "#/components/downloads-source.tsx";
import { ImportView } from "#/components/import-view.tsx";
import { ItunesCard, ItunesPending, useItunesOn } from "#/components/itunes-source.tsx";
import { useImport } from "#/lib/use-import.ts";

export const Route = createFileRoute("/import")({ component: ImportPage });

function ImportPage() {
	const { enabled } = useDownloadsEnabled();
	const s = useImport(enabled);
	const itunesOn = useItunesOn();
	return (
		<main className="mx-auto w-full max-w-5xl space-y-8 p-6 lg:p-8">
			<header className="space-y-1">
				<h1 className="font-semibold text-2xl tracking-tight">Import</h1>
				<p className="max-w-xl text-muted-foreground text-sm">
					Bring music into your library. Sources are never changed. Switch a source off to pause it.
				</p>
			</header>
			<section className="grid gap-4 lg:grid-cols-2">
				<DownloadsCard s={s} />
				<ItunesCard />
			</section>
			<section className="space-y-6">
				<h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
					New to import
				</h2>
				{itunesOn && <ItunesPending />}
				{enabled && s.folder !== null && (
					<div className="space-y-3">
						<h3 className="font-medium text-sm">Downloads</h3>
						<ImportView s={s} />
					</div>
				)}
				{!(itunesOn || (enabled && s.folder !== null)) && (
					<p className="text-muted-foreground text-sm">Turn on a source above to see what's new.</p>
				)}
			</section>
		</main>
	);
}
