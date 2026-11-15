import { useIsMutating, useMutationState } from "@tanstack/react-query";
import { FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { ErrorLine, Panel, Section } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { SCAN_KEY, useLibraryRoot, useResetLibrary, useScan, useTracks } from "#/lib/queries.ts";

/** Where the library lives on disk, and how to rescan it. */
export function LibrarySettings() {
	const root = useLibraryRoot();
	const tracks = useTracks();
	const scan = useScan();
	const reset = useResetLibrary();
	const [confirming, setConfirming] = useState(false);
	// Also true while the automatic launch-time rescan is running.
	const scanning = useIsMutating({ mutationKey: SCAN_KEY }) > 0;
	const lastError = useMutationState({
		filters: { mutationKey: SCAN_KEY, status: "error" },
		select: (m) => String(m.state.error),
	}).at(-1);
	const count = tracks.data?.length ?? 0;

	return (
		<Section
			title="Library folder"
			description={
				<>
					Songs are read from <code className="text-foreground">artist/album/track</code> folders.
					The folder is rescanned every time manplay opens.
				</>
			}
		>
			<Panel className="space-y-3">
				<div className="flex flex-wrap items-center gap-2">
					<code
						className="min-w-0 flex-1 truncate rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs"
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
				</div>
				<p className="text-muted-foreground text-xs tabular-nums">
					{count} {count === 1 ? "song" : "songs"} found.
				</p>
				{lastError && !scanning && <ErrorLine>{lastError}</ErrorLine>}
			</Panel>
			{root.data && (
				<Panel className="flex flex-wrap items-center justify-between gap-3">
					<div className="min-w-0 space-y-0.5">
						<p className="font-medium text-sm">Reset database</p>
						<p className="text-muted-foreground text-xs">
							Rebuilds the song list from the folder. Playlists, tags and sync records are cleared;
							a backup is kept and your files are not touched.
						</p>
					</div>
					<Button variant="destructive" disabled={scanning} onClick={() => setConfirming(true)}>
						<Trash2 />
						Reset database
					</Button>
					{reset.isError && !scanning && <ErrorLine>{String(reset.error)}</ErrorLine>}
				</Panel>
			)}
			{confirming && (
				<ConfirmDialog
					title="Reset the library database?"
					confirmLabel="Reset database"
					destructive
					onCancel={() => setConfirming(false)}
					onConfirm={() => {
						setConfirming(false);
						reset.mutate();
					}}
				>
					Songs are rebuilt from the folder. Playlist and tag memberships and sync records are
					cleared. A backup of the database is kept, and your music files are not touched.
				</ConfirmDialog>
			)}
		</Section>
	);
}
