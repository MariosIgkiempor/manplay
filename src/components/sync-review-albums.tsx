import { ChevronDown, EyeOff, FileQuestion, Music } from "lucide-react";
import {
	type CSSProperties,
	type RefObject,
	type TransitionEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { AlbumArt } from "#/components/album-art.tsx";
import { CreditLine } from "#/components/credit-line.tsx";
import { TONE, type Tone } from "#/components/diff-view.tsx";
import {
	ItemRow,
	type ReviewControls,
	ThereChoicePicker,
	TickAll,
} from "#/components/sync-review-item.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ignoreAlbum } from "#/lib/sync-choices.ts";
import {
	type AlbumGroup,
	type AlbumKey,
	albumChips,
	type ChipKind,
	type FloatPlacement,
	floatPlacement,
	groupByAlbum,
	itemKey,
	MOSAIC_ROW_PX,
	REVIEW_END_ATTRIBUTE,
	type ReviewItem,
	type SharedThere,
	sharedThere,
	type TrackLookup,
	tickable,
} from "#/lib/sync-review-model.ts";
import { cn } from "#/lib/utils.ts";

const CARDS_PER_PAGE = 60;

/**
 * How a chip reads: ↑ changes the destination, ↓ changes the library, ⇄ needs a choice. `hint`
 * is the longer form, shown on hover.
 */
const CHIP: Record<ChipKind, { sign: string; tone: Tone | null; verb: string; hint: string }> = {
	new: { sign: "↑", tone: "add", verb: "Send", hint: "new to the destination" },
	retagged: { sign: "↑", tone: "change", verb: "Retag", hint: "tags changed on the destination" },
	changed: { sign: "↑", tone: "change", verb: "Replace", hint: "replaced on the destination" },
	moved: { sign: "↑", tone: "move", verb: "Move", hint: "moved on the destination" },
	editedThere: { sign: "↓", tone: "change", verb: "Update", hint: "updated in your library" },
	bothEdited: { sign: "⇄", tone: "remove", verb: "Choose", hint: "edited on both sides" },
	copyHere: { sign: "↓", tone: "add", verb: "Copy", hint: "copied into your library" },
	deleteThere: { sign: "↑", tone: "remove", verb: "Delete", hint: "deleted from the destination" },
	left: { sign: "·", tone: null, verb: "Leave", hint: "left as they are" },
};

/** `3`, or `1/3` when only some are ticked. */
const chipCount = (ticked: number, count: number) =>
	ticked === count || ticked === 0
		? count.toLocaleString()
		: `${ticked.toLocaleString()}/${count.toLocaleString()}`;

function Cover({ group }: { group: AlbumGroup }) {
	if (group.coverTrackId !== null) {
		return <AlbumArt trackId={group.coverTrackId} className="size-10 shrink-0 rounded-md" />;
	}
	const Icon = group.other ? FileQuestion : Music;
	return (
		<div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
			<Icon className="size-5" />
		</div>
	);
}

/**
 * What happens to an album's files: `↑ Send 3`, `↓ Update 1`, … A kind with nothing ticked is
 * greyed and struck through: this sync skips it. A choice still to make is never skipped.
 */
function Chips({ items, controls }: { items: readonly ReviewItem[]; controls: ReviewControls }) {
	return albumChips(items, controls.there, controls.picked).map((c) => {
		const { sign, tone, verb, hint } = CHIP[c.kind];
		const skipped = c.ticked === 0 && c.kind !== "bothEdited" && c.kind !== "left";
		return (
			<span
				key={c.kind}
				data-hint={`${chipCount(c.ticked, c.count)} ${hint}${skipped ? " (skipped)" : ""}`}
				className={cn(
					"rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums",
					skipped && "text-muted-foreground line-through opacity-60",
				)}
			>
				<span
					className={cn(
						"font-semibold",
						tone && !skipped ? TONE[tone].text : "text-muted-foreground",
					)}
				>
					{sign}
				</span>{" "}
				{verb} {chipCount(c.ticked, c.count)}
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

/** The album-wide controls of an open card: tick all, and one choice for files only there. */
function AlbumControls({
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
	const tick = tickable(group.items, controls.choiceOf).length > 0;
	if (!tick && shared === null) {
		return null;
	}
	return (
		<div className="mt-3 space-y-2 border-t pt-2.5 text-xs">
			{tick && (
				<TickAll items={group.items} controls={controls} label={`Tick all in ${title}`}>
					{(on, total) => `${on.toLocaleString()} of ${total.toLocaleString()} ticked`}
				</TickAll>
			)}
			{shared && (
				<div className="space-y-1.5">
					<div className="text-muted-foreground">
						All {shared.files.length.toLocaleString()} only on the destination
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<AlbumChoice shared={shared} controls={controls} album={title} />
						<Button
							variant="ghost"
							size="xs"
							data-hint="Stop offering this album, and songs added to it later. Undo under Ignored."
							onClick={() => controls.ignore(ignoreAlbum(shared.files))}
						>
							<EyeOff />
							Ignore album
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

/** An open album's files, beside or under its card, scrolling when there are more than fit. */
function FileList({
	group,
	shared,
	controls,
}: {
	group: AlbumGroup;
	shared: SharedThere | null;
	controls: ReviewControls;
}) {
	return (
		<ul className="max-h-[30rem] min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-2.5">
			{group.items.map((item) => (
				<li key={itemKey(item)}>
					<ItemRow item={item} controls={controls} shared={shared !== null} />
				</li>
			))}
		</ul>
	);
}

/** An open card's cell in the mosaic, in pixels, and where its file list goes. */
interface Cell {
	width: number;
	height: number;
	placement: FloatPlacement;
}

/** Measures an open card's place in the mosaic, again whenever the mosaic is resized. */
function useCell(ref: RefObject<HTMLDivElement | null>, open: boolean): Cell | null {
	const [cell, setCell] = useState<Cell | null>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		const grid = el?.parentElement;
		if (!(open && el && grid)) {
			setCell(null);
			return;
		}
		const measure = () =>
			setCell({
				width: el.offsetWidth,
				height: el.offsetHeight,
				placement: floatPlacement(el.offsetLeft, el.offsetWidth, grid.clientWidth),
			});
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(grid);
		return () => observer.disconnect();
	}, [ref, open]);
	return cell;
}

/** Closes an open card on Escape or a press outside it. */
function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
	useEffect(() => {
		if (!open) {
			return;
		}
		const key = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !e.defaultPrevented) {
				onClose();
			}
		};
		const press = (e: PointerEvent) => {
			if (e.target instanceof Node && !ref.current?.contains(e.target)) {
				onClose();
			}
		};
		document.addEventListener("keydown", key);
		document.addEventListener("pointerdown", press);
		return () => {
			document.removeEventListener("keydown", key);
			document.removeEventListener("pointerdown", press);
		};
	}, [ref, open, onClose]);
}

/** Room below a lifted card for its shadow (`shadow-lg`), so the scroll area does not cut it. */
const SHADOW_ROOM_PX = 24;

/**
 * Brings an open card into view. The card floats over whatever is under it, the lanes below
 * included, and moves none of it; only where it would hang past the end of the whole review is
 * room added there, so it can still be scrolled to.
 */
function useOverhang(cardRef: RefObject<HTMLElement | null>, open: boolean) {
	useEffect(() => {
		const card = cardRef.current;
		const end = card?.closest<HTMLElement>(`[${REVIEW_END_ATTRIBUTE}]`);
		if (!(open && card && end)) {
			return;
		}
		let room = 0;
		const measure = () => {
			const past =
				card.getBoundingClientRect().bottom +
				SHADOW_ROOM_PX -
				(end.getBoundingClientRect().bottom - room);
			room = Math.max(0, Math.ceil(past));
			end.style.paddingBottom = `${room}px`;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(card);
		const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const frame = requestAnimationFrame(() =>
			card.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" }),
		);
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
			end.style.paddingBottom = "";
		};
	}, [cardRef, open]);
}

const FLEX: Record<FloatPlacement["side"], CSSProperties["flexDirection"]> = {
	right: "row",
	left: "row-reverse",
	below: "column",
};

/**
 * An open card lifted out of the mosaic: its own corner stays over its cell and the file list
 * opens out from it, revealed from the card's edge.
 */
function floatStyle(cell: Cell, revealed: boolean): CSSProperties {
	const { side, panel, offset } = cell.placement;
	const rest = `calc(100% - ${cell.height}px)`;
	const start = {
		right: `inset(0 ${panel}px ${rest} 0 round 0.5rem)`,
		left: `inset(0 0 ${rest} ${panel}px round 0.5rem)`,
		below: `inset(0 ${panel - offset - cell.width}px ${rest} ${offset}px round 0.5rem)`,
	}[side];
	return {
		position: "absolute",
		top: 0,
		left: side === "left" ? -panel : -offset,
		width: side === "below" ? panel : cell.width + panel,
		minHeight: cell.height,
		flexDirection: FLEX[side],
		// The room around the card is for its shadow, which the clip would otherwise cut.
		clipPath: revealed ? "inset(-2rem round 0.5rem)" : start,
	};
}

const albumTitle = (group: AlbumGroup) => (group.other ? "Other files" : group.album || "No album");

/** Which way the chevron points: down when closed, toward the file list when open. */
const CHEVRON: Record<FloatPlacement["side"], string> = {
	right: "-rotate-90",
	left: "rotate-90",
	below: "rotate-180",
};

const EDGE: Record<FloatPlacement["side"], string> = {
	right: "border-l",
	left: "border-r",
	below: "border-t",
};

/** The card's cover, title and artist, as the button that opens and closes it. */
function CardHead({
	group,
	open,
	side,
	onToggle,
}: {
	group: AlbumGroup;
	open: boolean;
	side: FloatPlacement["side"] | null;
	onToggle: () => void;
}) {
	const subtitle = group.other ? "Not songs, or duplicates" : group.artist || "Unknown artist";
	return (
		<button
			type="button"
			aria-expanded={open}
			onClick={onToggle}
			className="flex min-w-0 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
		>
			<Cover group={group} />
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium text-sm" data-hint={albumTitle(group)}>
					{albumTitle(group)}
				</span>
				{group.other ? (
					<span className="block truncate text-muted-foreground text-xs">{subtitle}</span>
				) : (
					<CreditLine artist={subtitle} />
				)}
			</span>
			<ChevronDown
				aria-hidden="true"
				className={cn(
					"size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
					side && CHEVRON[side],
				)}
			/>
		</button>
	);
}

/** How long the file list takes to fold back into its card, with a little to spare. */
const FOLD_MS = 400;

/**
 * Lifts a card out of the mosaic while it is open, and keeps it lifted after it closes until its
 * file list has folded back into the card, so closing plays the opening in reverse.
 */
function useLift(cellRef: RefObject<HTMLDivElement | null>, open: boolean) {
	const [lifted, setLifted] = useState(open);
	const [revealed, setRevealed] = useState(false);
	const cell = useCell(cellRef, lifted);
	useEffect(() => {
		if (open) {
			setLifted(true);
			return;
		}
		setRevealed(false);
		const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const timer = setTimeout(() => setLifted(false), reduce ? 0 : FOLD_MS);
		return () => clearTimeout(timer);
	}, [open]);
	useEffect(() => {
		if (!(open && cell)) {
			return;
		}
		const frame = requestAnimationFrame(() => setRevealed(true));
		return () => cancelAnimationFrame(frame);
	}, [open, cell]);
	const onTransitionEnd = (e: TransitionEvent<HTMLElement>) => {
		if (!open && e.target === e.currentTarget && e.propertyName === "clip-path") {
			setLifted(false);
		}
	};
	return { cell, revealed, onTransitionEnd };
}

function AlbumCard({
	group,
	open,
	onToggle,
	onClose,
	controls,
}: {
	group: AlbumGroup;
	open: boolean;
	onToggle: () => void;
	onClose: () => void;
	controls: ReviewControls;
}) {
	const cellRef = useRef<HTMLDivElement>(null);
	const cardRef = useRef<HTMLElement>(null);
	const { cell, revealed, onTransitionEnd } = useLift(cellRef, open);
	useDismiss(cardRef, open, onClose);
	useOverhang(cardRef, cell !== null);
	const floating = cell !== null;
	const shared = group.other ? null : sharedThere(group.items, controls.there);
	const title = albumTitle(group);
	return (
		<div ref={cellRef} className="relative min-w-0">
			<article
				ref={cardRef}
				className={cn(
					"flex h-full min-w-0 overflow-hidden rounded-xl border border-hairline bg-well transition-colors",
					floating && (open ? "z-20" : "z-10"),
					floating &&
						"h-auto shadow-2xl transition-[clip-path] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
				)}
				style={floating ? floatStyle(cell, revealed) : undefined}
				onTransitionEnd={onTransitionEnd}
			>
				<div
					className="flex min-w-0 shrink-0 flex-col p-2.5"
					// Under a list across the mosaic, the head stays over its own cell.
					style={
						floating
							? {
									width: cell.width - 2,
									minHeight: cell.height - 2,
									marginLeft: cell.placement.offset,
								}
							: { width: "100%" }
					}
				>
					<CardHead
						group={group}
						open={open}
						side={floating && open ? cell.placement.side : null}
						onToggle={onToggle}
					/>
					<div className="mt-2 flex flex-wrap items-center gap-1">
						<Chips items={group.items} controls={controls} />
						{shared && !floating && (
							<AlbumChoice shared={shared} controls={controls} album={title} />
						)}
					</div>
					{floating && (
						<AlbumControls group={group} shared={shared} title={title} controls={controls} />
					)}
				</div>
				{floating && (
					<div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", EDGE[cell.placement.side])}>
						<FileList group={group} shared={shared} controls={controls} />
					</div>
				)}
			</article>
		</div>
	);
}

/**
 * The review as a mosaic of albums: one card each with its cover and counts. Opening a card
 * floats it over the mosaic, its file list opening out to the side, and the cards under it stay
 * where they are.
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
	const [open, setOpen] = useState<AlbumKey | null>(null);
	const [shown, setShown] = useState(CARDS_PER_PAGE);
	const close = useCallback(() => setOpen(null), []);
	return (
		<div className="px-[var(--diff-inset)] py-3">
			<div
				className="relative grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3"
				style={{ gridAutoRows: `${MOSAIC_ROW_PX}px` }}
			>
				{groups.slice(0, shown).map((g) => (
					<AlbumCard
						key={g.key}
						group={g}
						open={open === g.key}
						onToggle={() => setOpen(open === g.key ? null : g.key)}
						onClose={close}
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
