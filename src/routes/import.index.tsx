import { createFileRoute } from "@tanstack/react-router";
import { DownloadsRow, useDownloadsEnabled } from "#/components/downloads-source.tsx";
import { FrameSection } from "#/components/frame.tsx";
import { ItunesRow, useItunesOn } from "#/components/itunes-source.tsx";
import { Page } from "#/components/page.tsx";
import { countNew } from "#/lib/import-state.ts";
import { useItunesPending } from "#/lib/queries.ts";
import { useImport } from "#/lib/use-import.ts";

export const Route = createFileRoute("/import/")({ component: ImportPage });

/** Every import source in one list, like the Export page; each source's page has its import. */
function ImportPage() {
	const { enabled } = useDownloadsEnabled();
	const s = useImport(enabled);
	const itunesOn = useItunesOn();
	const downloadsOn = enabled && s.folder !== null;
	const on = Number(downloadsOn) + Number(itunesOn);
	const itunesNew = useItunesPending(itunesOn).data?.length ?? 0;
	const found = (downloadsOn && s.scan ? countNew(s.scan) : 0) + (itunesOn ? itunesNew : 0);
	return (
		<Page
			title="Import"
			meta={
				<>
					<span>{on} of 2 sources on</span>
					<span>
						{found === 0 ? "Nothing new" : `${found.toLocaleString()} new songs to import`}
					</span>
				</>
			}
		>
			<FrameSection title="Sources" count={2}>
				<DownloadsRow s={s} />
				<ItunesRow />
			</FrameSection>
		</Page>
	);
}
