import { useQuery } from "@tanstack/react-query";
import { Hash, ListMusic, Tag, TextCursorInput } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "#/components/page.tsx";
import { Cover } from "#/components/page-header.tsx";
import { PANEL_ART, PanelHeader } from "#/components/panel-header.tsx";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { TagEditor } from "#/components/tag-editor.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
import { listTags, type Track } from "#/lib/api.ts";
import { songFacts } from "#/lib/panel-facts.tsx";
import { useTracks } from "#/lib/queries.ts";
import { tagTargetFor } from "#/lib/tag-target.ts";
import { trackHasValue, valueField } from "#/lib/track-fields.ts";

type ValueTab = "songs" | "metadata";

/**
 * Every song holding one value of a tag field, opened from the Metadata screen. The songs are
 * fixed when the panel opens: editing the value in the metadata tab moves them out of the value
 * but they stay here, so one edit session covers all of them.
 */
export function ValuePanel({ field, value }: { field: string; value: string }) {
	const tracks = useTracks();
	if (!tracks.data) {
		return <EmptyState title="Loading songs…" />;
	}
	return (
		<PinnedValuePanel
			key={`${field}\u0000${value}`}
			field={field}
			value={value}
			all={tracks.data}
		/>
	);
}

function PinnedValuePanel({
	field,
	value,
	all,
}: {
	field: string;
	value: string;
	all: readonly Track[];
}) {
	// Library tags live in the database, so a fresh tag list keeps counts honest after edits.
	useQuery({ queryKey: ["tags"], queryFn: listTags, enabled: field === "library" });
	const [pinnedPaths] = useState(
		() => new Set(all.filter((t) => trackHasValue(t, field, value)).map((t) => t.path)),
	);
	const [tab, setTab] = useState<ValueTab>("songs");
	const matching = useMemo(() => all.filter((t) => pinnedPaths.has(t.path)), [all, pinnedPaths]);
	const isTag = field === "library";
	const Icon = isTag ? Tag : Hash;
	const kind = valueField(field)?.one ?? field;
	const target = useMemo(() => {
		const t = tagTargetFor(matching);
		return t?.paths ? { ...t, name: value, kind } : t;
	}, [matching, value, kind]);
	const editable = !isTag && target !== null;

	return (
		<div className="space-y-6 pb-8">
			<PanelHeader
				kind={
					<>
						<Icon /> {kind}
					</>
				}
				title={value}
				facts={songFacts(matching)}
				art={
					<Cover tracks={matching} fallback={<Icon className="size-8" />} className={PANEL_ART} />
				}
				tracks={matching}
				tabs={
					editable && (
						<Segmented
							ruled={false}
							value={tab}
							onChange={setTab}
							label={`${kind} view`}
							items={[
								{ value: "songs", label: "Songs", icon: <ListMusic /> },
								{ value: "metadata", label: "Metadata", icon: <TextCursorInput /> },
							]}
						/>
					)
				}
			/>
			{tab === "metadata" && editable ? (
				<TagEditor key={[...pinnedPaths].join("\n")} target={target} embedded />
			) : (
				<SelectableTrackList
					tracks={matching}
					empty={<EmptyState title="No songs use this yet" />}
				/>
			)}
		</div>
	);
}
