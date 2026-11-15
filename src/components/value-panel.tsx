import { useQuery } from "@tanstack/react-query";
import { Hash, Tag, TextCursorInput } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "#/components/page.tsx";
import { Cover } from "#/components/page-header.tsx";
import { PanelHeader } from "#/components/panel-header.tsx";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { listTags } from "#/lib/api.ts";
import { duration } from "#/lib/format.ts";
import { useTracks } from "#/lib/queries.ts";
import { tagTargetFor } from "#/lib/tag-target.ts";
import { trackHasValue, valueField } from "#/lib/track-fields.ts";

const songs = (n: number) => `${n} ${n === 1 ? "song" : "songs"}`;

/** Every song holding one value of a tag field, opened from the Metadata screen. */
export function ValuePanel({ field, value }: { field: string; value: string }) {
	const tracks = useTracks();
	const { push } = useDetail();
	// Library tags live in the database, so a fresh tag list keeps counts honest after edits.
	useQuery({ queryKey: ["tags"], queryFn: listTags, enabled: field === "library" });
	const matching = useMemo(
		() => (tracks.data ?? []).filter((t) => trackHasValue(t, field, value)),
		[tracks.data, field, value],
	);
	const seconds = matching.reduce((n, t) => n + (t.durationMs ?? 0), 0) / 1000;
	const isTag = field === "library";
	const Icon = isTag ? Tag : Hash;

	return (
		<div className="space-y-6">
			<PanelHeader
				kind={
					<>
						<Icon /> {valueField(field)?.one ?? field}
					</>
				}
				title={value}
				meta={
					<>
						<span>{songs(matching.length)}</span>
						{seconds >= 1 && <span>{duration(seconds)}</span>}
					</>
				}
				art={<Cover tracks={matching} fallback={<Icon className="size-8" />} className="size-28" />}
				tracks={matching}
				actions={
					!isTag &&
					matching.length > 0 && (
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
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
				showDuration
				empty={
					<EmptyState title={tracks.isPending ? "Loading songs…" : "No songs use this yet"}>
						{!tracks.isPending &&
							"Values made on the Metadata screen show up here once a song uses them. A rescan picks up tags edited in other apps."}
					</EmptyState>
				}
			/>
		</div>
	);
}
