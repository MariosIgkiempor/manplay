import { useIsMutating } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FolderTree } from "lucide-react";
import { FolderFigure } from "#/components/destination-header.tsx";
import { FilesView } from "#/components/files-view.tsx";
import { ScanButtons } from "#/components/library-parts.tsx";
import { PageHeader, PageIcon } from "#/components/page-header.tsx";
import { SCAN_KEY, useLibraryRoot, useScan } from "#/lib/queries.ts";

export const Route = createFileRoute("/files")({ component: FilesPage });

function FilesPage() {
	const root = useLibraryRoot();
	const scan = useScan();
	const scanning = useIsMutating({ mutationKey: SCAN_KEY }) > 0;
	return (
		<main className="flex h-full flex-col">
			<PageHeader
				art={
					<PageIcon>
						<FolderTree />
					</PageIcon>
				}
				title="Files"
				meta={root.data ? <FolderFigure path={root.data} /> : <span>No library folder yet</span>}
				actions={
					<ScanButtons
						hasRoot={!!root.data}
						scanning={scanning}
						onScan={(mode) => scan.mutate(mode)}
					/>
				}
			/>
			<div className="min-h-0 flex-1">
				<FilesView />
			</div>
		</main>
	);
}
