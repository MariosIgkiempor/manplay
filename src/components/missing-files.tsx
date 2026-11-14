import { TriangleAlert } from "lucide-react";
import { Drawer } from "#/components/drawer.tsx";
import { Button } from "#/components/ui/button.tsx";
import { timeAgo } from "#/lib/format.ts";
import { useLibraryStatus, useMissingTracks, useRemoveMissing } from "#/lib/queries.ts";

/** Status bar notice: files vanished from disk. Hidden when nothing is missing. */
export function MissingIndicator({ onClick }: { onClick: () => void }) {
	const missing = useLibraryStatus().data?.missing ?? 0;
	if (missing === 0) {
		return null;
	}
	return (
		<button
			type="button"
			onClick={onClick}
			title="Show the files missing from disk"
			className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-warning hover:bg-warning/15"
		>
			<TriangleAlert className="size-3.5" />
			{missing} missing {missing === 1 ? "file" : "files"}
		</button>
	);
}

function MissingList() {
	const missing = useMissingTracks(true);
	if (missing.isError) {
		return <p className="text-destructive text-sm">{String(missing.error)}</p>;
	}
	if (!missing.data) {
		return <p className="text-muted-foreground text-sm">Loading…</p>;
	}
	const now = Date.now() / 1000;
	return (
		<ul className="divide-y">
			{missing.data.map((t) => (
				<li key={t.id} className="space-y-0.5 py-2.5">
					<div className="truncate font-medium text-sm" title={t.title}>
						{t.title}
					</div>
					<div className="truncate text-muted-foreground text-xs">
						{[t.artist, t.album].filter((x) => x !== "").join(", ")}
					</div>
					<div className="break-all text-muted-foreground text-xs" title={t.path}>
						{t.path}
					</div>
					<div className="text-warning text-xs">
						{t.removedAt <= now ? "Removed on the next sync" : `Removed ${timeAgo(t.removedAt)}`}
					</div>
				</li>
			))}
		</ul>
	);
}

function MissingBody({ onEmpty }: { onEmpty: () => void }) {
	const status = useLibraryStatus().data;
	const remove = useRemoveMissing();
	if (!status || status.missing === 0) {
		return <p className="text-muted-foreground text-sm">No files are missing.</p>;
	}
	return (
		<div className="space-y-4">
			<p className="text-sm">
				These files are gone from disk. They are hidden, keep their playlists and tags, and come
				back if the files return. After {status.graceDays} days they are removed here and from sync
				destinations.
			</p>
			<Button
				variant="outline"
				size="sm"
				disabled={remove.isPending}
				onClick={() => {
					if (
						window.confirm(
							`Remove ${status.missing} missing tracks now, including their copies on sync destinations?`,
						)
					) {
						remove.mutate(undefined, { onSuccess: onEmpty });
					}
				}}
			>
				Remove now
			</Button>
			{remove.isError && <p className="text-destructive text-sm">{String(remove.error)}</p>}
			<MissingList />
		</div>
	);
}

/** Slide-over listing the missing files, with when each goes. */
export function MissingDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
	return (
		<Drawer open={open} onClose={onClose} title="Missing files">
			<MissingBody onEmpty={onClose} />
		</Drawer>
	);
}
