import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Tag } from "lucide-react";
import { useMemo } from "react";
import { PanelHeader } from "#/components/panel-header.tsx";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { listTags } from "#/lib/api.ts";
import { useTracks } from "#/lib/queries.ts";
import { TAG_SEP, tagLeaf, tagWithin, trackHasTag } from "#/lib/tag-tree.ts";

/** Songs of a library tag and every tag below it, with links up and down the hierarchy. */
export function TagPanel({ name }: { name: string }) {
	const tracks = useTracks();
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const { push } = useDetail();
	const tagged = useMemo(
		() => (tracks.data ?? []).filter((t) => trackHasTag(t, name)),
		[tracks.data, name],
	);
	const depth = name.split(TAG_SEP).length;
	const children = (tags.data ?? []).filter(
		(t) => tagWithin(t.name, name) && t.name.split(TAG_SEP).length === depth + 1,
	);
	const parents = name
		.split(TAG_SEP)
		.slice(0, -1)
		.map((_, i, parts) => parts.slice(0, i + 1).join(TAG_SEP));

	return (
		<div className="space-y-6">
			<PanelHeader
				title={tagLeaf(name)}
				subtitle={
					<span className="inline-flex flex-wrap items-center gap-1.5 text-base">
						<Tag className="size-4" /> Tag
						{parents.map((p) => (
							<span key={p} className="inline-flex items-center gap-1.5">
								<ChevronRight className="size-3.5" />
								<button
									type="button"
									className="hover:text-foreground hover:underline"
									onClick={() => push({ kind: "tag", name: p })}
								>
									{tagLeaf(p)}
								</button>
							</span>
						))}
					</span>
				}
				meta={`${tagged.length} tracks`}
				tracks={tagged}
			/>
			{children.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{children.map((c) => (
						<button
							key={c.id}
							type="button"
							className="rounded-full bg-muted px-2.5 py-1 text-xs hover:bg-muted/70 hover:text-foreground"
							onClick={() => push({ kind: "tag", name: c.name })}
						>
							{tagLeaf(c.name)} <span className="text-muted-foreground">{c.trackCount}</span>
						</button>
					))}
				</div>
			)}
			<SelectableTrackList tracks={tagged} />
		</div>
	);
}
