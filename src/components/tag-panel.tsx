import { Tag } from "lucide-react";
import { useMemo } from "react";
import { PanelHeader } from "#/components/panel-header.tsx";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { useTracks } from "#/lib/queries.ts";

export function TagPanel({ name }: { name: string }) {
	const tracks = useTracks();
	const tagged = useMemo(
		() =>
			(tracks.data ?? []).filter((t) => t.tags.some((x) => x.toLowerCase() === name.toLowerCase())),
		[tracks.data, name],
	);

	return (
		<div className="space-y-6">
			<PanelHeader
				title={name}
				subtitle={
					<span className="inline-flex items-center gap-1.5 text-base">
						<Tag className="size-4" /> Tag
					</span>
				}
				meta={`${tagged.length} tracks`}
				tracks={tagged}
			/>
			<SelectableTrackList tracks={tagged} />
		</div>
	);
}
