import { History, ListMusic, Sparkles, Tag } from "lucide-react";
import type { ReactNode } from "react";
import { WellCard } from "#/components/frame.tsx";
import { EmptyState, ErrorLine, Page } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import type { DeletedItem, ItemKind } from "#/lib/api.ts";
import { timeAgo } from "#/lib/format.ts";
import { useRecentlyDeleted, useRestoreDeleted } from "#/lib/queries.ts";

const ICON: Record<ItemKind, ReactNode> = {
	tag: <Tag />,
	playlist: <ListMusic />,
	smart_playlist: <Sparkles />,
};

function detail(item: DeletedItem): string {
	const songs = item.songs === 1 ? "1 song" : `${item.songs} songs`;
	const when = `${item.by}, ${timeAgo(item.at)}`;
	return item.kind === "smart_playlist" ? when : `${when} · ${songs}`;
}

function Row({ item }: { item: DeletedItem }) {
	const restore = useRestoreDeleted();
	return (
		<div className="space-y-1 px-4 py-3">
			<div className="flex items-center gap-2">
				<span className="text-muted-foreground [&_svg]:size-4">{ICON[item.kind]}</span>
				<div className="min-w-0 flex-1">
					<div className="truncate font-medium text-sm">{item.name}</div>
					<div className="truncate text-muted-foreground text-xs">{detail(item)}</div>
				</div>
				<Button
					size="xs"
					variant="outline"
					disabled={restore.isPending}
					onClick={() => restore.mutate({ kind: item.kind, uid: item.uid })}
				>
					Restore
				</Button>
			</div>
			{restore.isError && <ErrorLine>{String(restore.error)}</ErrorLine>}
		</div>
	);
}

/**
 * Shared tags, playlists and smart playlists someone deleted in the last 90 days. Restoring one
 * brings it back for everyone, with its songs.
 */
export function RecentlyDeleted() {
	const deleted = useRecentlyDeleted();
	const items = deleted.data ?? [];
	return (
		<Page
			title="Recently deleted"
			meta={
				items.length > 0 && <span>{items.length === 1 ? "1 item" : `${items.length} items`}</span>
			}
		>
			{items.length === 0 ? (
				<EmptyState icon={<History />} title="Nothing deleted">
					Shared tags and playlists stay here for 90 days after they are deleted.
				</EmptyState>
			) : (
				<WellCard rows>
					{items.map((item) => (
						<Row key={`${item.kind}/${item.uid}`} item={item} />
					))}
				</WellCard>
			)}
		</Page>
	);
}
