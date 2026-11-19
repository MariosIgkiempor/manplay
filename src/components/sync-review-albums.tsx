import { ChevronDown, FileQuestion, Music } from "lucide-react";
import { useState } from "react";
import { AlbumArt } from "#/components/album-art.tsx";
import { TONE, type Tone } from "#/components/diff-view.tsx";
import {
	ItemRow,
	type ReviewControls,
	ThereChoicePicker,
	TickAll,
} from "#/components/sync-review-item.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	type AlbumGroup,
	type AlbumKey,
	albumChips,
	type ChipKind,
	groupByAlbum,
	itemKey,
	MOSAIC_ROW_PX,
	openSpan,
	type ReviewItem,
	type SharedThere,
	sharedThere,
	type ThereLookup,
	type TrackLookup,
	tickable,
} from "#/lib/sync-review-model.ts";
import { cn } from "#/lib/utils.ts";

const CARDS_PER_PAGE = 60;

const CHIP: Record<ChipKind, { sign: string; tone: Tone | null; label: string }> = {
	new: { sign: "+", tone: "add", label: "new" },
	retagged: { sign: "~", tone: "change", label: "retagged" },
	changed: { sign: "~", tone: "change", label: "changed" },
	moved: { sign: "→", tone: "move", label: "moved" },
	editedThere: { sign: "↓", tone: "change", label: "edited there" },
	bothEdited: { sign: "⇄", tone: "remove", label: "both edited" },
	copyHere: { sign: "↓", tone: "add", label: "copy here" },
	deleteThere: { sign: "−", tone: "remove", label: "delete there" },
	left: { sign: "·", tone: null, label: "left" },
};

function Cover({ group }: { group: AlbumGroup }) {
	if (group.coverTrackId !== null) {
		return <AlbumArt trackId={group.coverTrackId} className="size-14 shrink-0 rounded-md" />;
	}
	const Icon = group.other ? FileQuestion : Music;
	return (
		<div className="flex size-14 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
			<Icon className="size-5" />
		</div>
	);
}

/** Counts of what happens to an album's files: `+3 new`, `~1 retagged`, … */
function Chips({ items, there }: { items: readonly ReviewItem[]; there: ThereLookup }) {
	return albumChips(items, there).map((c) => {
		const { sign, tone, label } = CHIP[c.kind];
		return (
			<span
				key={c.kind}
				className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] tabular-nums"
			>
				<span className={cn("font-semibold", tone ? TONE[tone].text : "text-muted-foreground")}>
					{sign}
					{c.count.toLocaleString()}
				</span>{" "}
				{label}
			</span>
		);
	});
}

function AlbumChoice({
	shared,
	controls,
	album,
}: {
	shared: SharedThere;
	controls: ReviewControls;
	album: string;
}) {
	return (
		<ThereChoicePicker
			options={shared.options}
			value={shared.value}
			label={`What to do with the ${shared.files.length} files of ${album} only on the destination`}
			onChange={(c) => controls.chooseThere(shared.files, c)}
		/>
	);
}

/** An open album's files under its cover, scrolling when there are more than fit. */
function FileList({
	group,
	shared,
	title,
	controls,
}: {
	group: AlbumGroup;
	shared: SharedThere | null;
	title: string;
	controls: ReviewControls;
}) {
	const head = shared !== null || tickable(group.items, controls.choiceOf).length > 0;
	return (
		<div className="mt-2 flex min-h-0 flex-1 flex-col border-t pt-2">
			{head && (
				<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
					<TickAll items={group.items} controls={controls} label={`Tick all in ${title}`}>
						{(on, total) => `${on.toLocaleString()} of ${total.toLocaleString()} ticked`}
					</TickAll>
					{shared && (
						<span className="flex items-center gap-2 text-muted-foreground text-xs">
							For all {shared.files.length.toLocaleString()} only there
							<AlbumChoice shared={shared} controls={controls} album={title} />
						</span>
					)}
				</div>
			)}
			<ul className="-mr-1 min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1">
				{group.items.map((item) => (
					<li key={itemKey(item)}>
						<ItemRow item={item} controls={controls} shared={shared !== null} />
					</li>
				))}
			</ul>
		</div>
	);
}

function AlbumCard({
	group,
	open,
	onOpen,
	controls,
}: {
	group: AlbumGroup;
	open: boolean;
	onOpen: () => void;
	controls: ReviewControls;
}) {
	const shared = group.other ? null : sharedThere(group.items, controls.there);
	const title = group.other ? "Other files" : group.album || "No album";
	const subtitle = group.other ? "Not songs, or duplicates" : group.artist || "Unknown artist";
	return (
		<article
			className={cn(
				"flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-card p-2.5",
				open && "border-primary/45 shadow-md",
			)}
			style={open ? { gridRow: `span ${openSpan(group.items, shared !== null)}` } : undefined}
		>
			<button
				type="button"
				aria-expanded={open}
				onClick={onOpen}
				className="flex min-w-0 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
			>
				<Cover group={group} />
				<span className="min-w-0 flex-1">
					<span className="line-clamp-2 break-words font-medium text-sm">{title}</span>
					<span className="block truncate text-muted-foreground text-xs">{subtitle}</span>
				</span>
				<ChevronDown
					aria-hidden="true"
					className={cn(
						"size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
						open && "rotate-180",
					)}
				/>
			</button>
			<div className="mt-2 flex flex-wrap items-center gap-1">
				<Chips items={group.items} there={controls.there} />
				{shared && !open && <AlbumChoice shared={shared} controls={controls} album={title} />}
			</div>
			{open && <FileList group={group} shared={shared} title={title} controls={controls} />}
		</article>
	);
}

/**
 * The review as a mosaic of albums: one card each with its cover and counts. Opening a card
 * makes it span more rows to list its files, and the other cards flow around it.
 */
export function AlbumMosaic({
	items,
	lookup,
	controls,
}: {
	items: readonly ReviewItem[];
	lookup: TrackLookup;
	controls: ReviewControls;
}) {
	const groups = groupByAlbum(items, lookup);
	const [open, setOpen] = useState<ReadonlySet<AlbumKey>>(new Set());
	const [shown, setShown] = useState(CARDS_PER_PAGE);
	const toggle = (key: AlbumKey) =>
		setOpen((s) => {
			const next = new Set(s);
			if (!next.delete(key)) {
				next.add(key);
			}
			return next;
		});
	return (
		<div className="px-[var(--diff-inset)] py-3">
			<div
				className="grid grid-flow-dense grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3"
				style={{ gridAutoRows: `${MOSAIC_ROW_PX}px` }}
			>
				{groups.slice(0, shown).map((g) => (
					<AlbumCard
						key={g.key}
						group={g}
						open={open.has(g.key)}
						onOpen={() => toggle(g.key)}
						controls={controls}
					/>
				))}
			</div>
			{groups.length > shown && (
				<Button
					variant="ghost"
					size="sm"
					className="mt-2"
					onClick={() => setShown(shown + CARDS_PER_PAGE)}
				>
					Show more albums ({(groups.length - shown).toLocaleString()} hidden)
				</Button>
			)}
		</div>
	);
}
