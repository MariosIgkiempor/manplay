import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ListMusic, Sparkles, Tag as TagIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CheckList, CheckRow, Filter, LinkButton, TagTree } from "#/components/check-list.tsx";
import { ErrorText } from "#/components/error-text.tsx";
import { SmartPicker } from "#/components/smart-playlists.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
import {
	type ExportSelection,
	listPlaylists,
	listTags,
	type Playlist,
	type Tag,
} from "#/lib/api.ts";
import { plural, tagPlaylistName } from "#/lib/export-selection.ts";
import { useSmartPlaylists } from "#/lib/use-smart.ts";
import { cn } from "#/lib/utils.ts";

export type ChooserTab = "playlists" | "tags" | "smart" | "destination";

/** A playlist as a destination holds it, for the destination tab. */
export interface HeldPlaylist {
	folders: string[];
	name: string;
	/** The export about to run takes it off the destination. */
	removed?: boolean;
	tracks: { title: string; artist: string }[];
}

function PickerHeader({
	hint,
	allOn,
	noneOn,
	onAll,
	onClear,
}: {
	hint: string;
	allOn: boolean;
	noneOn: boolean;
	onAll: () => void;
	onClear: () => void;
}) {
	return (
		<div className="flex items-center justify-between gap-3 text-xs">
			<p className="text-muted-foreground">{hint}</p>
			<div className="flex shrink-0 gap-3">
				<LinkButton disabled={allOn} onClick={onAll}>
					Select all
				</LinkButton>
				<LinkButton disabled={noneOn} onClick={onClear}>
					Clear
				</LinkButton>
			</div>
		</div>
	);
}

function PlaylistPicker({
	list,
	chosen,
	noteFor,
	onChange,
}: {
	list: readonly Playlist[];
	chosen: readonly number[];
	noteFor: (name: string) => string | undefined;
	onChange: (next: number[]) => void;
}) {
	const [filter, setFilter] = useState("");
	if (list.length === 0) {
		return (
			<p className="py-6 text-center text-muted-foreground text-sm">No playlists with songs yet.</p>
		);
	}
	const on = new Set(chosen);
	const count = list.filter((p) => on.has(p.id)).length;
	const needle = filter.trim().toLowerCase();
	const shown = list.filter((p) => p.name.toLowerCase().includes(needle));
	const toggle = (id: number, include: boolean) =>
		onChange(include ? [...chosen.filter((x) => x !== id), id] : chosen.filter((x) => x !== id));
	return (
		<div className="space-y-2">
			<PickerHeader
				hint={`${count} of ${list.length} chosen`}
				allOn={count === list.length}
				noneOn={count === 0}
				onAll={() => onChange(list.map((p) => p.id))}
				onClear={() => onChange([])}
			/>
			{list.length > 8 && <Filter value={filter} onChange={setFilter} label="Filter playlists" />}
			<CheckList>
				{shown.map((p) => (
					<CheckRow
						key={p.id}
						label={p.name}
						detail={plural(p.trackCount, "track")}
						note={noteFor(p.name)}
						icon={<ListMusic className="size-4" />}
						state={on.has(p.id) ? "on" : "off"}
						onChange={(include) => toggle(p.id, include)}
					/>
				))}
				{shown.length === 0 && (
					<p className="px-3 py-2 text-muted-foreground text-sm">No playlist matches.</p>
				)}
			</CheckList>
		</div>
	);
}

function TagPicker({
	tags,
	chosen,
	noteFor,
	onChange,
}: {
	tags: readonly Tag[];
	chosen: readonly string[];
	noteFor: (playlistName: string) => string | undefined;
	onChange: (next: string[]) => void;
}) {
	if (tags.length === 0) {
		return <p className="py-6 text-center text-muted-foreground text-sm">No tagged songs yet.</p>;
	}
	return (
		<div className="space-y-2">
			<PickerHeader
				hint="Each tag becomes a playlist of its songs, including tags below it"
				allOn={chosen.length >= tags.length}
				noneOn={chosen.length === 0}
				onAll={() => onChange(tags.map((t) => t.name))}
				onClear={() => onChange([])}
			/>
			<TagTree
				tags={tags}
				selected={chosen}
				onChange={onChange}
				noteFor={(n) => noteFor(tagPlaylistName(n.name))}
			/>
		</div>
	);
}

/** The destination's playlists grouped by folder, each opening to its songs. */
export function HeldPlaylists({
	playlists,
	empty,
}: {
	playlists: readonly HeldPlaylist[];
	empty: string;
}) {
	const groups = new Map<string, HeldPlaylist[]>();
	for (const p of playlists) {
		const key = p.folders.join(" › ") || "Top level";
		groups.set(key, [...(groups.get(key) ?? []), p]);
	}
	if (groups.size === 0) {
		return <p className="text-muted-foreground text-sm">{empty}</p>;
	}
	return (
		<div className="space-y-4">
			{[...groups].map(([folder, lists]) => (
				<div key={folder} className="space-y-1">
					<p className="px-1 text-muted-foreground text-xs">{folder}</p>
					<div className="rounded-lg border">
						{lists.map((p, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: names can repeat in a folder
							<details key={`${p.name}-${i}`} className="group border-b last:border-b-0">
								<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm">
									<ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
									<span
										className={cn(
											"min-w-0 flex-1 truncate",
											p.removed && "text-muted-foreground line-through",
										)}
									>
										{p.name}
									</span>
									{p.removed && (
										<span className="shrink-0 text-destructive text-xs">Removed on export</span>
									)}
									<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
										{plural(p.tracks.length, "track")}
									</span>
								</summary>
								<ol className="max-h-64 space-y-0.5 overflow-y-auto pr-3 pb-3 pl-9 text-muted-foreground text-xs">
									{p.tracks.length === 0 && <li>Empty</li>}
									{p.tracks.map((t, j) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: a song can repeat in a playlist
										<li key={j} className="truncate">
											{t.artist ? `${t.artist} – ${t.title}` : t.title}
										</li>
									))}
								</ol>
							</details>
						))}
					</div>
				</div>
			))}
		</div>
	);
}

/**
 * What goes to a destination, the same for the rekordbox file and USB drives: library playlists,
 * tags as playlists, smart playlists, and a tab with what the destination holds now.
 */
export function ExportChooser({
	selection,
	onChange,
	tab,
	onTab,
	destination,
	replaces,
	onLeave,
}: {
	selection: ExportSelection;
	onChange: (next: ExportSelection) => void;
	tab: ChooserTab;
	onTab: (tab: ChooserTab) => void;
	destination: { label: string; icon: ReactNode; content: ReactNode };
	/** Closes the drawer, before going to another page (a smart playlist's). */
	onLeave: () => void;
	/** Names of the destination's playlists that an export of the same name replaces. */
	replaces: ReadonlySet<string>;
}) {
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const smart = useSmartPlaylists();
	const smartCount = chosenCount(selection, smart.data);
	const list = (playlists.data ?? []).filter((p) => p.trackCount > 0);
	const tagList = (tags.data ?? []).filter((t) => t.trackCount > 0);
	const on = new Set(selection.playlists);
	const chosenNames = new Set(list.filter((p) => on.has(p.id)).map((p) => p.name));
	const replaceNote = (name: string) =>
		replaces.has(name) ? "Replaces the one already there" : undefined;
	return (
		<div className="space-y-3">
			<Segmented
				value={tab}
				onChange={onTab}
				label="What to export"
				items={[
					{
						value: "playlists",
						label: "Playlists",
						icon: <ListMusic />,
						count: list.filter((p) => on.has(p.id)).length,
					},
					{ value: "tags", label: "Tags", icon: <TagIcon />, count: selection.tags.length },
					{ value: "smart", label: "Smart", icon: <Sparkles />, count: smartCount },
					{ value: "destination", label: destination.label, icon: destination.icon },
				]}
			/>
			{playlists.isError && <ErrorText message={String(playlists.error)} />}
			{tags.isError && <ErrorText message={String(tags.error)} />}
			{tab === "playlists" && playlists.isSuccess && (
				<PlaylistPicker
					list={list}
					chosen={selection.playlists}
					noteFor={replaceNote}
					onChange={(next) => onChange({ ...selection, playlists: next })}
				/>
			)}
			{tab === "tags" && tags.isSuccess && (
				<TagPicker
					tags={tagList}
					chosen={selection.tags}
					noteFor={(name) =>
						chosenNames.has(name) ? "Same name as a chosen playlist" : replaceNote(name)
					}
					onChange={(next) => onChange({ ...selection, tags: next })}
				/>
			)}
			{tab === "smart" && (
				<SmartPicker
					chosen={selection.smart}
					onChosen={(next) => onChange({ ...selection, smart: next })}
					onLeave={onLeave}
				/>
			)}
			{tab === "destination" && destination.content}
		</div>
	);
}

/** How many of the chosen smart playlists still exist. */
function chosenCount(selection: ExportSelection, lists: readonly { id: number }[] | undefined) {
	const on = new Set(selection.smart);
	return (lists ?? []).filter((p) => on.has(p.id)).length;
}

/** The drawer's bottom bar: what the choice adds up to, then the buttons. */
export function ExportFooter({
	text,
	warn = false,
	children,
}: {
	/** A line of words, or figures such as the review's counts. */
	text: ReactNode;
	warn?: boolean;
	children: ReactNode;
}) {
	return (
		<div className="-mx-4 -mb-4 sticky bottom-0 z-10 mt-auto flex items-center gap-3 border-t bg-background/85 px-4 py-3 backdrop-blur-md">
			<div
				className={cn(
					"min-w-0 flex-1 truncate text-sm tabular-nums",
					warn ? "text-destructive" : "text-muted-foreground",
				)}
			>
				{text}
			</div>
			{children}
		</div>
	);
}
