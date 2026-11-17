import { Copy } from "lucide-react";
import { useState } from "react";
import { Drawer } from "#/components/drawer.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { type CarryCandidate, confirmTrash, type DuplicateGroup, fsReveal } from "#/lib/api.ts";
import { extraCopies } from "#/lib/duplicates.ts";
import { formatBytes } from "#/lib/format.ts";
import { TRASH } from "#/lib/platform.ts";
import { useCarryCandidates, useCarryDecision, useDuplicates, useFsTrash } from "#/lib/queries.ts";

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
				title="Songs that were re-encoded can take their tags and playlists along"
				className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-warning hover:bg-warning/15"
			>
				<Copy className="size-3.5" />
				{carry.length} re-encoded {carry.length === 1 ? "song" : "songs"}
			</button>
		);
	}
	const copies = extraCopies(groups);
	return (
		<button
			type="button"
			onClick={onClick}
			title="Show songs stored more than once"
			className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-warning hover:bg-warning/15"
		>
			<Copy className="size-3.5" />
			{copies} duplicate {copies === 1 ? "file" : "files"}
		</button>
	);
}

function DuplicateList({ groups }: { groups: readonly DuplicateGroup[] }) {
	const trash = useFsTrash();
	const [error, setError] = useState<string | null>(null);
	return (
		<div className="space-y-4">
			<p className="text-muted-foreground text-sm">
				Copies of one recording share their tags, beat grid and playlist entries, and playlists show
				them once. Keep one and move the others to the {TRASH}.
			</p>
			{(error ?? (trash.isError ? String(trash.error) : null)) && (
				<ErrorLine>{error ?? String(trash.error)}</ErrorLine>
			)}
			<ul className="space-y-4">
				{groups.map((g) => (
					<li key={g.audioFp} className="rounded-md border">
						<div className="truncate border-b px-3 py-2 font-medium text-sm">
							{g.tracks[0]?.title}
							<span className="ml-2 font-normal text-muted-foreground text-xs">
								{g.tracks[0]?.artist}
							</span>
						</div>
						<ul className="divide-y">
							{g.tracks.map((t) => (
								<li key={t.id} className="flex items-center gap-2 px-3 py-2">
									<div className="min-w-0 flex-1">
										<div className="break-all text-xs" title={t.path}>
											{t.path}
										</div>
										<div className="text-muted-foreground text-xs">{formatBytes(t.size)}</div>
									</div>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => {
											setError(null);
											fsReveal(t.path).catch((e) => setError(String(e)));
										}}
									>
										Reveal
									</Button>
									<Button
										variant="outline"
										size="sm"
										disabled={trash.isPending}
										onClick={async () => {
											setError(null);
											if (await confirmTrash([t.path.split(/[\\/]/).pop() ?? t.path])) {
												trash.mutate([t.path]);
											}
										}}
									>
										Move to {TRASH}
									</Button>
								</li>
							))}
						</ul>
					</li>
				))}
			</ul>
		</div>
	);
}

function CarryList({ items }: { items: readonly CarryCandidate[] }) {
	const decide = useCarryDecision();
	return (
		<div className="space-y-4">
			<p className="text-muted-foreground text-sm">
				These songs have new audio (a re-encode, such as MP3 to FLAC), so the tags, playlists and
				hand-set tempo of the old audio no longer point at them. Carry them over to keep them.
			</p>
			{decide.isError && <ErrorLine>{String(decide.error)}</ErrorLine>}
			<ul className="space-y-3">
				{items.map((c) => (
					<li key={c.oldFp} className="rounded-md border px-3 py-2">
						<div className="truncate font-medium text-sm">
							{c.title}
							<span className="ml-2 font-normal text-muted-foreground text-xs">{c.artist}</span>
						</div>
						<div className="break-all text-muted-foreground text-xs" title={c.path}>
							{c.oldPath ? `${c.oldPath} → ` : ""}
							{c.path}
						</div>
						<div className="mt-1 text-xs">
							{[
								c.tags > 0 && `${c.tags} ${c.tags === 1 ? "tag" : "tags"}`,
								c.playlists > 0 && `${c.playlists} ${c.playlists === 1 ? "playlist" : "playlists"}`,
								c.edits && "hand-set BPM, key or grid",
							]
								.filter(Boolean)
								.join(", ")}
						</div>
						<div className="mt-2 flex gap-2">
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
			</ul>
		</div>
	);
}

/** Slide-over listing each group of songs with the same audio, and re-encoded songs. */
export function DuplicatesDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
	const groups = useDuplicates().data ?? [];
	const carry = useCarryCandidates().data ?? [];
	return (
		<Drawer open={open} onClose={onClose} title="Duplicates">
			<div className="space-y-8">
				{carry.length > 0 && <CarryList items={carry} />}
				{groups.length > 0 ? (
					<DuplicateList groups={groups} />
				) : (
					carry.length === 0 && (
						<p className="text-muted-foreground text-sm">No song is stored twice.</p>
					)
				)}
			</div>
		</Drawer>
	);
}
