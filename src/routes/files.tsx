import { useIsMutating } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FilesView } from "#/components/files-view.tsx";
import { LibraryHeader } from "#/components/library-header.tsx";
import { ScanButtons } from "#/components/library-parts.tsx";
import { SCAN_KEY, useLibraryRoot, useScan } from "#/lib/queries.ts";

export const Route = createFileRoute("/files")({ component: FilesPage });

function FilesPage() {
	const root = useLibraryRoot();
	const scan = useScan();
	const scanning = useIsMutating({ mutationKey: SCAN_KEY }) > 0;
	return (
		<main className="flex h-full flex-col">
			<LibraryHeader
				title="Files"
				subtitle={root.data ?? undefined}
				controls={
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
