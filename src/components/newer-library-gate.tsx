import { Download, RefreshCw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useNewerLibrary } from "#/lib/queries.ts";
import { useInstallUpdate, useUpdateCheck } from "#/lib/updater.ts";

/**
 * The app, or, when a newer manplay set up the library, only a notice to update: this version
 * would take songs that version streams as removed, so the backend left the library closed.
 */
export function NewerLibraryGate({ children }: { children: ReactNode }) {
	const newer = useNewerLibrary();
	if (newer.isPending) {
		return null;
	}
	// A failed check must not keep the app shut; the backend refuses the library on its own.
	if (!newer.data) {
		return children;
	}
	return (
		<main className="flex flex-1 items-center justify-center p-8">
			<EmptyState
				icon={<TriangleAlert className="text-destructive" />}
				title="This library needs a newer manplay"
				className="max-w-md"
				action={<UpdateButton />}
			>
				A newer version of manplay set up this library, and this version cannot open it safely.
				Update manplay to open it. Nothing in the library was changed.
			</EmptyState>
		</main>
	);
}

function UpdateButton() {
	const update = useUpdateCheck();
	const install = useInstallUpdate();
	if (update.data) {
		return (
			<div className="flex flex-col items-center gap-2">
				<Button onClick={() => install.mutate()} disabled={install.isPending}>
					<Download />
					{install.isPending ? "Installing…" : `Install ${update.data.version} and restart`}
				</Button>
				{install.isError && <ErrorLine>{String(install.error)}</ErrorLine>}
			</div>
		);
	}
	return (
		<Button variant="outline" onClick={() => update.refetch()} disabled={update.isFetching}>
			<RefreshCw className={update.isFetching ? "animate-spin motion-reduce:animate-none" : ""} />
			{update.isFetching ? "Checking for updates…" : "Check for updates"}
		</Button>
	);
}
