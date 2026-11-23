import { useIsMutating, useMutationState } from "@tanstack/react-query";
import { FolderOpen, Music, RefreshCw, Trash2 } from "lucide-react";
import { FieldRow, FrameSection } from "#/components/frame.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ConfirmButton } from "#/components/ui/confirm-button.tsx";
import { type Effect, EffectList, Explainer } from "#/components/ui/explainer.tsx";
import { SCAN_KEY, useLibraryRoot, useResetLibrary, useScan, useTracks } from "#/lib/queries.ts";

const FOLDER_EFFECTS: readonly Effect[] = [
	{ tone: "kept", what: "Your music files", detail: "They stay where they are." },
];

const RESET_EFFECTS: readonly Effect[] = [
	{ tone: "changed", what: "Song list", detail: "Read again from the music folder." },
	{ tone: "lost", what: "Playlists" },
	{ tone: "lost", what: "Tag memberships" },
	{ tone: "lost", what: "Sync records" },
	{ tone: "kept", what: "A backup of the database", detail: "Saved before anything is cleared." },
	{ tone: "kept", what: "Your music files" },
];

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
				<Explainer
					summary="Files stay where they are"
					title="Your music folder"
					lead="manplay reads your music from this folder."
					effects={FOLDER_EFFECTS}
				/>
			}
		>
			<FieldRow
				label="Music folder"
				description={
					root.data ? (
						<>
							<code className="break-all font-mono text-foreground/90 text-xs">{root.data}</code>
							<span className="mt-1 flex items-center gap-1.5 tabular-nums">
								<Music className="size-3.5" aria-hidden />
								{songCount} · read again at every launch
							</span>
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
						<Explainer
							summary="Starts the song list over from the folder"
							title="Reset database"
							effects={RESET_EFFECTS}
						/>
					}
					align="center"
				>
					<ConfirmButton
						variant="destructive"
						disabled={scanning}
						destructive
						confirmLabel="Reset the library database"
						consequence={<EffectList effects={RESET_EFFECTS} />}
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
