import { useIsMutating, useMutationState } from "@tanstack/react-query";
import { FolderOpen, Music, RefreshCw, Trash2 } from "lucide-react";
import { FieldRow, FrameSection } from "#/components/frame.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ConfirmButton } from "#/components/ui/confirm-button.tsx";
import { Fact, Facts } from "#/components/ui/facts.tsx";
import { SCAN_KEY, useLibraryRoot, useResetLibrary, useScan, useTracks } from "#/lib/queries.ts";

/** Where the library lives on disk, how to rescan it, and how to start its database over. */
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
	const count = tracks.data?.length ?? 0;
	const songCount = `${count.toLocaleString()} ${count === 1 ? "song" : "songs"}`;

	return (
		<FrameSection
			title="Library"
			description={
				<Facts label="The folder manplay reads your music from. Files stay where they are.">
					<Fact tone="kept">Files stay where they are</Fact>
				</Facts>
			}
		>
			<FieldRow
				label="Music folder"
				description={
					root.data ? (
						<>
							<code className="break-all font-mono text-foreground/90 text-xs">{root.data}</code>
							<Facts
								label={`${songCount}, read again at every launch.`}
								className="mt-1 flex tabular-nums"
							>
								<Fact icon={<Music />}>{songCount}</Fact>
								<Fact tone="changed">Rescanned at launch</Fact>
							</Facts>
						</>
					) : (
						"Choose a folder laid out as artist, album, then songs."
					)
				}
				align="center"
			>
				<Button variant="outline" onClick={() => scan.mutate("pick")} disabled={scanning}>
					<FolderOpen />
					{root.data ? "Change folder" : "Choose folder"}
				</Button>
				{root.data && (
					<Button variant="outline" onClick={() => scan.mutate("saved")} disabled={scanning}>
						<RefreshCw className={scanning ? "animate-spin motion-reduce:animate-none" : ""} />
						{scanning ? "Scanning…" : "Rescan"}
					</Button>
				)}
			</FieldRow>
			{lastError && !scanning && (
				<div className="px-4 py-3">
					<ErrorLine>{lastError}</ErrorLine>
				</div>
			)}
			{root.data && (
				<FieldRow
					label="Reset database"
					description={
						<Facts label="Rebuilds the song list from the folder. Playlists, tag memberships and sync records are cleared; a backup is kept.">
							<Fact tone="changed">Song list</Fact>
							<Fact tone="lost">Playlists</Fact>
							<Fact tone="lost">Tag memberships</Fact>
							<Fact tone="lost">Sync records</Fact>
							<Fact tone="kept">Backup</Fact>
						</Facts>
					}
					align="center"
				>
					<ConfirmButton
						variant="destructive"
						disabled={scanning}
						destructive
						confirmLabel="Reset the library database"
						consequence={
							<Facts label="Songs are rebuilt from the folder. Playlist and tag memberships and sync records are cleared. A backup of the database is kept, and your music files are not touched.">
								<Fact tone="lost">Playlists</Fact>
								<Fact tone="lost">Tag memberships</Fact>
								<Fact tone="lost">Sync records</Fact>
								<Fact tone="kept">Backup</Fact>
								<Fact tone="kept">Music files</Fact>
							</Facts>
						}
						onConfirm={() => reset.mutate()}
					>
						<Trash2 />
						Reset database
					</ConfirmButton>
				</FieldRow>
			)}
			{reset.isError && !scanning && (
				<div className="px-4 py-3">
					<ErrorLine>{String(reset.error)}</ErrorLine>
				</div>
			)}
		</FrameSection>
	);
}
