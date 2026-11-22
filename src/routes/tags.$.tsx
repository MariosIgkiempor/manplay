import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Tag } from "lucide-react";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import type { Shareable } from "#/components/item-sharing.tsx";
import { useJellyfinMenu } from "#/components/jellyfin-menu.tsx";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { CollectionHeader } from "#/components/page-header.tsx";
import {
	HeaderSongSort,
	SelectableTrackList,
	useSongSort,
} from "#/components/selectable-track-list.tsx";
import { SharingControl } from "#/components/sharing-control.tsx";
import { listTags, migrateLibraryTags, type Tag as TagItem } from "#/lib/api.ts";
import { useTracks } from "#/lib/queries.ts";
import { TAG_SEP, tagLeaf, tagWithin, trackHasTag } from "#/lib/tag-tree.ts";

export const Route = createFileRoute("/tags/$")({ component: TagPage });

const songs = (n: number) => `${n} ${n === 1 ? "song" : "songs"}`;

type Ask = { kind: "delete" } | { kind: "merge"; to: string };

/** The tag's row as the Shared / Private switch needs it; null while it has none. */
function shareableTag(tags: readonly TagItem[], name: string): Shareable | null {
	const own = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
	return own ? { kind: "tag", id: own.id, name: own.name, scope: own.scope ?? "shared" } : null;
}

/** One library tag: its songs, and the means to rename or delete it. Subtags follow along. */
function TagPage() {
	const { _splat } = Route.useParams();
	const name = _splat ?? "";
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const tracks = useTracks();
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const [ask, setAsk] = useState<Ask | null>(null);

	const tagged = useMemo(
		() => (tracks.data ?? []).filter((t) => trackHasTag(t, name)),
		[tracks.data, name],
	);
	const tagRow = shareableTag(tags.data ?? [], name);
	const jellyfinMenu = useJellyfinMenu(name ? { kind: "tag", name } : null);
	const depth = name.split(TAG_SEP).length;
	const subtags = (tags.data ?? []).filter(
		(t) => tagWithin(t.name, name) && t.name.split(TAG_SEP).length === depth + 1,
	);
	const parents = name
		.split(TAG_SEP)
		.slice(0, -1)
		.map((_, i, parts) => parts.slice(0, i + 1).join(TAG_SEP));
	const parentPath = parents.at(-1);

	const migrate = useMutation({
		mutationFn: (to: string | null) => migrateLibraryTags([name], to),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["tags"] });
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["playlist-tracks"] });
		},
	});

	const rename = (leaf: string) => {
		const to = parentPath ? `${parentPath}${TAG_SEP}${leaf}` : leaf;
		if (to === name) {
			return;
		}
		const taken = (tags.data ?? []).some(
			(t) =>
				t.name.toLowerCase() === to.toLowerCase() && t.name.toLowerCase() !== name.toLowerCase(),
		);
		if (taken) {
			setAsk({ kind: "merge", to });
			return;
		}
		void move(to);
	};
	const move = async (to: string) => {
		setAsk(null);
		try {
			await migrate.mutateAsync(to);
			await navigate({ to: "/tags/$", params: { _splat: to }, replace: true });
		} catch {
			// The error line under the header reports it.
		}
	};
	const destroy = async () => {
		setAsk(null);
		try {
			await migrate.mutateAsync(null);
			await (parentPath
				? navigate({ to: "/tags/$", params: { _splat: parentPath } })
				: navigate({ to: "/" }));
		} catch {
			// The error line under the header reports it.
		}
	};

	const sort = useSongSort(tagged);
	return (
		<main>
			<CollectionHeader
				sort={<HeaderSongSort songs={tagged.length} sort={sort} />}
				kind={
					<>
						<Tag className="size-3.5" /> Tag
						{parents.map((p) => (
							<span key={p} className="inline-flex items-center gap-1.5">
								<ChevronRight className="size-3.5" />
								<Link
									to="/tags/$"
									params={{ _splat: p }}
									className="hover:text-foreground hover:underline"
								>
									{tagLeaf(p)}
								</Link>
							</span>
						))}
					</>
				}
				title={tagLeaf(name)}
				meta={<span>{songs(tagged.length)}</span>}
				tracks={sort.sorted}
				fallbackIcon={<Tag className="size-10" />}
				onRename={rename}
				onDelete={() => setAsk({ kind: "delete" })}
				menuExtra={jellyfinMenu}
				sharing={<SharingControl item={tagRow} />}
			>
				{subtags.length > 0 && (
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="text-muted-foreground text-xs">Subtags</span>
						{subtags.map((c) => (
							<Link
								key={c.id}
								to="/tags/$"
								params={{ _splat: c.name }}
								className="rounded-full bg-muted px-2.5 py-1 text-xs hover:bg-muted/70"
							>
								{tagLeaf(c.name)} <span className="text-muted-foreground">{c.trackCount}</span>
							</Link>
						))}
					</div>
				)}
			</CollectionHeader>
			<div className="space-y-3 p-6">
				{migrate.isError && <ErrorLine>{String(migrate.error)}</ErrorLine>}
				{tagged.length === 0 && !tracks.isPending ? (
					<EmptyState icon={<Tag />} title="No songs have this tag">
						Right-click songs in the library to tag them.
					</EmptyState>
				) : (
					<SelectableTrackList
						tracks={tagged}
						sort={sort.sort}
						onSortChange={sort.setSort}
						hideSortMenu
					/>
				)}
			</div>
			{ask?.kind === "delete" && (
				<ConfirmDialog
					title={`Delete tag “${name}”?`}
					confirmLabel="Delete tag"
					destructive
					onCancel={() => setAsk(null)}
					onConfirm={() => void destroy()}
				>
					It is removed from {songs(tagged.length)}
					{subtags.length > 0 && ", and its subtags are deleted with it"}. The songs stay in your
					library.
				</ConfirmDialog>
			)}
			{ask?.kind === "merge" && (
				<ConfirmDialog
					title={`Merge into “${ask.to}”?`}
					confirmLabel="Merge"
					onCancel={() => setAsk(null)}
					onConfirm={() => void move(ask.to)}
				>
					“{ask.to}” already exists. {songs(tagged.length)} move to it and this tag is removed.
				</ConfirmDialog>
			)}
		</main>
	);
}
