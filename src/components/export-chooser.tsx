import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ListMusic, Sparkles, Tag as TagIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CheckList, CheckRow, Filter, LinkButton, TagTree } from "#/components/check-list.tsx";
import { FrameSection } from "#/components/frame.tsx";
import { EmptyLine, ErrorLine } from "#/components/page.tsx";
import { SmartPicker } from "#/components/smart-playlists.tsx";
import { Fact, Facts } from "#/components/ui/facts.tsx";
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
	hint: ReactNode;
	allOn: boolean;
	noneOn: boolean;
	onAll: () => void;
	onClear: () => void;
}) {
	return (
		<div className="flex items-center justify-between gap-3 text-xs">
			<div className="text-muted-foreground">{hint}</div>
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
		return <EmptyLine>No playlists with songs yet</EmptyLine>;
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
				{shown.length === 0 && <EmptyLine>No playlist matches</EmptyLine>}
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
		return <EmptyLine>No tagged songs yet</EmptyLine>;
	}
	return (
		<div className="space-y-2">
			<PickerHeader
				hint={
					<Facts label="Each tag becomes a playlist of its songs, including tags below it">
						<Fact tone="changed">Each tag → a playlist</Fact>
						<Fact>Includes tags below it</Fact>
					</Facts>
				}
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
				<FrameSection key={folder} title={folder} count={lists.length}>
					<div>
						{lists.map((p, i) => (
							<details
								// biome-ignore lint/suspicious/noArrayIndexKey: names can repeat in a folder
								key={`${p.name}-${i}`}
								className="group border-hairline border-b last:border-b-0"
							>
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
				</FrameSection>
			))}
		</div>
	);
}

/**
 * What goes to a destination, for USB drives: library playlists,
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
			{playlists.isError && <ErrorLine>{String(playlists.error)}</ErrorLine>}
			{tags.isError && <ErrorLine>{String(tags.error)}</ErrorLine>}
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
	inPanel = false,
	children,
}: {
	/** A line of words, or figures such as the review's counts. */
	text: ReactNode;
	warn?: boolean;
	/** In the side panel rather than a drawer, whose scrolling area is padded differently. */
	inPanel?: boolean;
	children: ReactNode;
}) {
	// The drawer pads its scrolling area, and a sticky bar stops at that padding: the negative
	// offset takes it down to the drawer's edge, so no list shows underneath it. The side panel
	// pads only its sides.
	return (
		<div
			className={cn(
				"sticky z-10 mt-auto flex items-center gap-3 border-t py-3",
				// The side panel is narrow and sits on the canvas: the words get a line of their own
				// above the buttons, on a solid ground so the list never shows through them.
				inPanel
					? "-mx-5 bottom-0 flex-wrap justify-end bg-canvas px-5 [&>div:first-child]:basis-full"
					: "-mx-4 -mb-4 -bottom-4 bg-well px-4",
			)}
		>
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
