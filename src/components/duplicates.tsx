import { Copy, FolderOpen, Play, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { fileMenuEntries } from "#/components/file-menu.tsx";
import { RowMenu } from "#/components/menu.tsx";
import { ErrorLine } from "#/components/page.tsx";
import {
	PanelIntro,
	PROBLEM_ROW,
	ProblemList,
	ProblemsCleared,
	ProblemText,
} from "#/components/problem-panel.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ConfirmButton } from "#/components/ui/confirm-button.tsx";
import { Fact, Facts } from "#/components/ui/facts.tsx";
import { PanelBarTitle } from "#/context/panel-bar.tsx";
import { usePlayer } from "#/context/player-context.ts";
import { type CarryCandidate, type DuplicateGroup, fsReveal } from "#/lib/api.ts";
import { confirmTrash } from "#/lib/confirm.ts";
import { extraCopies } from "#/lib/duplicates.ts";
import { formatBytes } from "#/lib/format.ts";
import { baseName, relSegments } from "#/lib/fs-path.ts";
import { FILE_MANAGER, TRASH } from "#/lib/platform.ts";
import {
	useCarryCandidates,
	useCarryDecision,
	useDuplicates,
	useFsTrash,
	useLibraryRoot,
	useTracks,
} from "#/lib/queries.ts";
import { cn } from "#/lib/utils.ts";

/** Status bar notice: the same audio is stored in more than one file, or a song was re-encoded. */
export function DuplicatesIndicator({ onClick }: { onClick: () => void }) {
	const groups = useDuplicates().data ?? [];
	const carry = useCarryCandidates().data ?? [];
	if (groups.length === 0 && carry.length === 0) {
		return null;
	}
	if (groups.length === 0) {
		return (
			<button
				type="button"
				onClick={onClick}
				data-hint={`${carry.length} re-encoded ${carry.length === 1 ? "song" : "songs"}: they can take their tags and playlists along`}
				aria-label={`${carry.length} re-encoded ${carry.length === 1 ? "song" : "songs"}`}
				className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-warning hover:bg-warning/15"
			>
				<Copy className="size-3.5" />
				{carry.length} re-encoded
			</button>
		);
	}
	const copies = extraCopies(groups);
	return (
		<button
			type="button"
			onClick={onClick}
			data-hint={`${copies} duplicate ${copies === 1 ? "file" : "files"}: songs stored more than once. Show them.`}
			aria-label={`${copies} duplicate ${copies === 1 ? "file" : "files"}`}
			className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-warning hover:bg-warning/15"
		>
			<Copy className="size-3.5" />
			{copies} {copies === 1 ? "duplicate" : "duplicates"}
		</button>
	);
}

function DuplicateList({ groups }: { groups: readonly DuplicateGroup[] }) {
	const trash = useFsTrash();
	const player = usePlayer();
	// The library's own record of each copy, which the player needs.
	const library = useTracks().data;
	const songs = useMemo(() => new Map((library ?? []).map((t) => [t.id, t])), [library]);
	const root = useLibraryRoot().data ?? "";
	const [error, setError] = useState<string | null>(null);
	return (
		<div className="space-y-4">
			<PanelIntro>
				<Facts
					label={`The same recording is stored in more than one file. The copies share their tags, beat grid and playlist entries, and playlists show them once. Keep one and move the others to the ${TRASH}.`}
				>
					<Fact>Same recording, several files</Fact>
					<Fact tone="kept">Tags, grid, playlists shared</Fact>
					<Fact tone="changed">Keep one, rest to {TRASH}</Fact>
				</Facts>
			</PanelIntro>
			{(error ?? (trash.isError ? String(trash.error) : null)) && (
				<ErrorLine>{error ?? String(trash.error)}</ErrorLine>
			)}
			{groups.map((g) => (
				<ProblemList
					key={g.audioFp}
					title={g.tracks[0]?.title ?? "Untitled"}
					description={`${g.tracks[0]?.artist ?? ""}${g.tracks[0]?.artist ? ", " : ""}${g.tracks.length} copies`}
				>
					{g.tracks.map((t) => (
						<RowMenu
							key={t.id}
							label={baseName(t.path)}
							render={<li />}
							className={cn(PROBLEM_ROW, "items-center")}
							items={[
								{
									label: "Play this copy",
									icon: <Play />,
									disabled: !songs.has(t.id),
									onSelect: () => {
										const song = songs.get(t.id);
										if (song) {
											player.play([song], 0);
										}
									},
								},
								"separator",
								...fileMenuEntries(t.path),
								"separator",
								{
									label: `Move to ${TRASH}…`,
									icon: <Trash2 />,
									destructive: true,
									disabled: trash.isPending,
									onSelect: async () => {
										setError(null);
										if (await confirmTrash([baseName(t.path)])) {
											trash.mutate([t.path]);
										}
									},
								},
							]}
						>
							{/* File name, then the folder it is in below the library: the full path on hover. */}
							<ProblemText
								name={baseName(t.path)}
								where={`${relSegments(root, t.path).slice(0, -1).join(" / ") || "Library folder"}, ${formatBytes(t.size)}`}
								hint={t.path}
							/>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`Show ${baseName(t.path)} in ${FILE_MANAGER}`}
								data-hint={`Show in ${FILE_MANAGER}`}
								onClick={() => {
									setError(null);
									fsReveal(t.path).catch((e) => setError(String(e)));
								}}
							>
								<FolderOpen />
							</Button>
							<ConfirmButton
								variant="outline"
								size="sm"
								destructive
								disabled={trash.isPending}
								confirmLabel={`Move “${baseName(t.path)}” to the ${TRASH}`}
								onConfirm={() => {
									setError(null);
									trash.mutate([t.path]);
								}}
							>
								Move to {TRASH}
							</ConfirmButton>
						</RowMenu>
					))}
				</ProblemList>
			))}
		</div>
	);
}

function CarryList({ items }: { items: readonly CarryCandidate[] }) {
	const decide = useCarryDecision();
	return (
		<div className="space-y-4">
			<PanelIntro>
				<Facts label="These songs have new audio (a re-encode, such as MP3 to FLAC), so the tags, playlists and hand-set tempo of the old audio no longer point at them. Carry them over to keep them.">
					<Fact tone="changed">Re-encoded audio</Fact>
					<Fact tone="warn">Tags, playlists, tempo left behind</Fact>
					<Fact tone="kept">Carry over to keep</Fact>
				</Facts>
			</PanelIntro>
			{decide.isError && <ErrorLine>{String(decide.error)}</ErrorLine>}
			<ProblemList title={`${items.length} re-encoded ${items.length === 1 ? "song" : "songs"}`}>
				{items.map((c) => (
					<li key={c.oldFp} className={cn(PROBLEM_ROW, "flex-col items-stretch gap-2")}>
						<ProblemText
							name={c.title}
							where={c.artist || baseName(c.path)}
							hint={c.oldPath ? `${c.oldPath} → ${c.path}` : c.path}
							notes={[
								{
									text: `Would keep ${[
										c.tags > 0 && `${c.tags} ${c.tags === 1 ? "tag" : "tags"}`,
										c.playlists > 0 &&
											`${c.playlists} ${c.playlists === 1 ? "playlist" : "playlists"}`,
										c.edits && "hand-set BPM, key or grid",
									]
										.filter(Boolean)
										.join(", ")}`,
									tone: "warning",
								},
							]}
						/>
						<div className="flex gap-2">
							<Button
								size="sm"
								disabled={decide.isPending}
								onClick={() => decide.mutate({ oldFp: c.oldFp, trackId: c.trackId })}
							>
								Carry over tags and playlists
							</Button>
							<Button
								variant="ghost"
								size="sm"
								disabled={decide.isPending}
								onClick={() => decide.mutate({ oldFp: c.oldFp, trackId: null })}
							>
								Leave them
							</Button>
						</div>
					</li>
				))}
			</ProblemList>
		</div>
	);
}

/** The side panel listing each group of songs with the same audio, and re-encoded songs. */
export function DuplicatesPanel() {
	const groups = useDuplicates().data ?? [];
	const carry = useCarryCandidates().data ?? [];
	return (
		<>
			<PanelBarTitle>Duplicates</PanelBarTitle>
			<div className="space-y-8">
				{carry.length > 0 && <CarryList items={carry} />}
				{groups.length > 0 ? (
					<DuplicateList groups={groups} />
				) : (
					carry.length === 0 && (
						<ProblemsCleared title="No duplicates">
							Every recording in the library is stored once.
						</ProblemsCleared>
					)
				)}
			</div>
		</>
	);
}
