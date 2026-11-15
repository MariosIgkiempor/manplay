import { createFileRoute } from "@tanstack/react-router";
import { DownloadsCard, useDownloadsEnabled } from "#/components/downloads-source.tsx";
import { ImportView } from "#/components/import-view.tsx";
import { ItunesCard, ItunesPending, useItunesOn } from "#/components/itunes-source.tsx";
import { EmptyState, Page, Section } from "#/components/page.tsx";
import { typeScale } from "#/lib/type-scale.ts";
import { useImport } from "#/lib/use-import.ts";

export const Route = createFileRoute("/import")({ component: ImportPage });

function ImportPage() {
	const { enabled } = useDownloadsEnabled();
	const s = useImport(enabled);
	const itunesOn = useItunesOn();
	return (
		<Page title="Import">
			<Section title="Sources">
				<div className="grid gap-4 lg:grid-cols-2">
					<DownloadsCard s={s} />
					<ItunesCard />
				</div>
			</Section>
			<Section title="Ready to import">
				<div className="space-y-8">
					{itunesOn && <ItunesPending />}
					{enabled && s.folder !== null && (
						<div className="space-y-3">
							<h3 className={typeScale.label}>Downloads</h3>
							<ImportView s={s} />
						</div>
					)}
				</div>
				{!(itunesOn || (enabled && s.folder !== null)) && (
					<EmptyState title="No source is on">Turn on a source above.</EmptyState>
				)}
			</Section>
		</Page>
	);
}
