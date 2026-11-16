import { Copy } from "lucide-react";
import { useState } from "react";
import { Drawer } from "#/components/drawer.tsx";
import { Button } from "#/components/ui/button.tsx";
import { confirmTrash, type DuplicateGroup, fsReveal } from "#/lib/api.ts";
import { extraCopies } from "#/lib/duplicates.ts";
import { formatBytes } from "#/lib/format.ts";
import { TRASH } from "#/lib/platform.ts";
import { useDuplicates, useFsTrash } from "#/lib/queries.ts";

/** Status bar notice: the same audio is stored in more than one file. Hidden when it is not. */
export function DuplicatesIndicator({ onClick }: { onClick: () => void }) {
	const groups = useDuplicates().data ?? [];
	if (groups.length === 0) {
		return null;
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
				<p className="text-destructive text-sm">{error ?? String(trash.error)}</p>
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

/** Slide-over listing each group of songs with the same audio. */
export function DuplicatesDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
	const groups = useDuplicates().data ?? [];
	return (
		<Drawer open={open} onClose={onClose} title="Duplicates">
			{groups.length === 0 ? (
				<p className="text-muted-foreground text-sm">No song is stored twice.</p>
			) : (
				<DuplicateList groups={groups} />
			)}
		</Drawer>
	);
}
