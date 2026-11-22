import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import { AlbumMosaic } from "#/components/sync-review-albums.tsx";
import { type ReviewControls, ThereChoicePicker, TickAll } from "#/components/sync-review-item.tsx";
import type { SyncDirection } from "#/lib/sync-choices.ts";
import {
	foldedLane,
	itemsByLane,
	LANES,
	type Lane,
	type ReviewItem,
	sharedThere,
	type TrackLookup,
} from "#/lib/sync-review-model.ts";
import { cn } from "#/lib/utils.ts";

/** Each section's icon, coloured like the Push only and Pull only buttons. */
const LANE: Record<
	Lane,
	{ icon: ReactNode; tint: string; title: (destination: string) => string }
> = {
	send: { icon: <ArrowUp />, tint: "text-primary", title: (d) => `To ${d}` },
	bring: { icon: <ArrowDown />, tint: "text-success", title: () => "Into your library" },
	there: { icon: <ArrowUpDown />, tint: "text-muted-foreground", title: (d) => `Only on ${d}` },
};

/** A section's bulk control: tick all its changes, or one choice for all its files only there. */
function LaneControl({
	lane,
	items,
	title,
	controls,
}: {
	lane: Lane;
	items: readonly ReviewItem[];
	title: string;
	controls: ReviewControls;
}) {
	if (lane !== "there") {
		return (
			<TickAll items={items} controls={controls} label={`Tick all ${title.toLowerCase()}`}>
				{(on, total) => (
					<span className="tabular-nums">
						{on.toLocaleString()}/{total.toLocaleString()}
					</span>
				)}
			</TickAll>
		);
	}
	const shared = sharedThere(items, controls.there);
	return (
		shared && (
			<ThereChoicePicker
				options={shared.options}
				value={shared.value}
				label={`What to do with every file ${title.toLowerCase()}`}
				onChange={(c) => controls.chooseThere(shared.files, c)}
			/>
		)
	);
}

/**
 * The album view split by which way files go: to the destination, into the library, and files
 * only on the destination. A one-way sync starts with the direction it leaves out folded.
 */
export function ReviewLanes({
	items,
	destination,
	direction,
	lookup,
	controls,
}: {
	items: readonly ReviewItem[];
	destination: string;
	direction: SyncDirection;
	lookup: TrackLookup;
	controls: ReviewControls;
}) {
	const [folded, setFolded] = useState<ReadonlySet<Lane>>(() => {
		const lane = foldedLane(direction);
		return new Set(lane ? [lane] : []);
	});
	const toggle = (lane: Lane) =>
		setFolded((s) => {
			const next = new Set(s);
			if (!next.delete(lane)) {
				next.add(lane);
			}
			return next;
		});
	const lanes = itemsByLane(items);
	return LANES.map((lane) => {
		const laneItems = lanes[lane];
		if (laneItems.length === 0) {
			return null;
		}
		const open = !folded.has(lane);
		const title = LANE[lane].title(destination);
		return (
			<section key={lane} aria-label={title} className="border-b last:border-b-0">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-[var(--diff-inset)] pt-3">
					<button
						type="button"
						aria-expanded={open}
						onClick={() => toggle(lane)}
						className="inline-flex min-w-0 items-center gap-1.5 rounded-md font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-4 [&_svg]:shrink-0"
					>
						<ChevronDown
							aria-hidden="true"
							className={cn(
								"text-muted-foreground transition-transform motion-reduce:transition-none",
								!open && "-rotate-90",
							)}
						/>
						<span className={LANE[lane].tint}>{LANE[lane].icon}</span>
						<span className="truncate">{title}</span>
						<span className="text-muted-foreground text-xs tabular-nums">
							{laneItems.length.toLocaleString()}
						</span>
					</button>
					<LaneControl lane={lane} items={laneItems} title={title} controls={controls} />
				</div>
				{open ? (
					<AlbumMosaic items={laneItems} lookup={lookup} controls={controls} />
				) : (
					<div className="pb-3" />
				)}
			</section>
		);
	});
}
