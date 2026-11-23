import { History, ListMusic, Sparkles, Tag } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState, ErrorLine, Page } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Fact, Facts } from "#/components/ui/facts.tsx";
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
		<li className="space-y-1 border-b py-3">
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
		</li>
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
					<Facts label="Tags and playlists deleted from the shared library stay here for 90 days.">
						<Fact tone="kept">Shared tags and playlists</Fact>
						<Fact icon={<History />}>90 days</Fact>
					</Facts>
				</EmptyState>
			) : (
				<ul className="border-t">
					{items.map((item) => (
						<Row key={`${item.kind}/${item.uid}`} item={item} />
					))}
				</ul>
			)}
		</Page>
	);
}
