import { useQuery } from "@tanstack/react-query";
import { Hash, Tag, TextCursorInput } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "#/components/page.tsx";
import { Cover } from "#/components/page-header.tsx";
import { PANEL_ART, PanelHeader } from "#/components/panel-header.tsx";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useDetail, useDetailNav } from "#/context/detail-context.ts";
import { listTags } from "#/lib/api.ts";
import { songFacts } from "#/lib/panel-facts.tsx";
import { useTracks } from "#/lib/queries.ts";
import { tagTargetFor } from "#/lib/tag-target.ts";
import { trackHasValue, valueField } from "#/lib/track-fields.ts";

/** Every song holding one value of a tag field, opened from the Metadata screen. */
export function ValuePanel({ field, value }: { field: string; value: string }) {
	const tracks = useTracks();
	const { push } = useDetail();
	const go = useDetailNav();
	// Library tags live in the database, so a fresh tag list keeps counts honest after edits.
	useQuery({ queryKey: ["tags"], queryFn: listTags, enabled: field === "library" });
	const matching = useMemo(
		() => (tracks.data ?? []).filter((t) => trackHasValue(t, field, value)),
		[tracks.data, field, value],
	);
	const isTag = field === "library";
	const Icon = isTag ? Tag : Hash;

	return (
		<div className="space-y-8 pb-8">
			<PanelHeader
				kind={
					<>
						<Icon /> {valueField(field)?.one ?? field}
					</>
				}
				title={value}
				facts={songFacts(matching)}
				art={
					<Cover tracks={matching} fallback={<Icon className="size-8" />} className={PANEL_ART} />
				}
				tracks={matching}
				actions={
					!isTag &&
					matching.length > 0 && (
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								const only = matching.length === 1 ? matching[0] : undefined;
								if (only) {
									go({ kind: "song", trackId: only.id, tab: "metadata" });
									return;
								}
								const target = tagTargetFor(matching);
								if (target) {
									push({ kind: "edit", target });
								}
							}}
						>
							<TextCursorInput /> Edit {matching.length === 1 ? "song" : "all"}
						</Button>
					)
				}
			/>
			<SelectableTrackList
				tracks={matching}
				empty={<EmptyState title={tracks.isPending ? "Loading songs…" : "No songs use this yet"} />}
			/>
		</div>
	);
}
