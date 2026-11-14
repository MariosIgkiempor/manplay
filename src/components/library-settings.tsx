import { useIsMutating, useMutationState } from "@tanstack/react-query";
import { FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { SCAN_KEY, useLibraryRoot, useResetLibrary, useScan, useTracks } from "#/lib/queries.ts";

/** Where the library lives on disk, and how to rescan it. */
export function LibrarySettings() {
	const root = useLibraryRoot();
	const tracks = useTracks();
	const scan = useScan();
	const reset = useResetLibrary();
	// Also true while the automatic launch-time rescan is running.
	const scanning = useIsMutating({ mutationKey: SCAN_KEY }) > 0;
	const lastError = useMutationState({
		filters: { mutationKey: SCAN_KEY, status: "error" },
		select: (m) => String(m.state.error),
	}).at(-1);

	return (
		<section className="space-y-4 rounded-xl border bg-card p-4">
			<h2 className="font-medium">Library</h2>
			<div className="space-y-1">
				<div className="text-muted-foreground text-xs">Folder</div>
				<div className="flex flex-wrap items-center gap-2">
					<code
						className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-sm"
						title={root.data ?? undefined}
					>
						{root.data ?? "No folder chosen"}
					</code>
					<Button variant="outline" onClick={() => scan.mutate("pick")} disabled={scanning}>
						<FolderOpen />
						{root.data ? "Change folder" : "Choose folder"}
					</Button>
					{root.data && (
						<Button variant="outline" onClick={() => scan.mutate("saved")} disabled={scanning}>
							<RefreshCw className={scanning ? "animate-spin" : ""} />
							{scanning ? "Scanning…" : "Rescan"}
						</Button>
					)}
					{root.data && (
						<Button
							variant="outline"
							disabled={scanning}
							onClick={() => {
								if (
									window.confirm(
										"Reset the library database? Tracks are rebuilt from the folder. Playlist and tag memberships and sync records are cleared (a backup is kept). Your files are not touched.",
									)
								) {
									reset.mutate();
								}
							}}
						>
							<Trash2 />
							Reset database
						</Button>
					)}
				</div>
				<p className="text-muted-foreground text-xs">
					Expected layout: <code>artist/album/track</code>. {tracks.data?.length ?? 0} songs found.
					The folder is rescanned on launch.
				</p>
			</div>
			{lastError && !scanning && <p className="text-destructive text-sm">{lastError}</p>}
			{reset.isError && !scanning && (
				<p className="text-destructive text-sm">{String(reset.error)}</p>
			)}
		</section>
	);
}
