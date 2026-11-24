import { Popover } from "@ui-sdk/react/popover";
import { Check, ListPlus, Plus, Tag as TagIcon } from "lucide-react";
import { type KeyboardEvent, useId, useState } from "react";
import { PopoverPopup } from "#/components/ui/popup.tsx";
import { usePlayer } from "#/context/player-context.ts";
import type { Track } from "#/lib/api.ts";
import { FLOATING_FRAME, WELL } from "#/lib/page-layout.ts";
import { NOW_PLAYING_ATTRIBUTE, type PickRow, pickerKey, pickRows } from "#/lib/playing-picker.ts";
import { type Point, pointerInWindow } from "#/lib/pointer.ts";
import { useAddToPlaylist } from "#/lib/use-add-to-playlist.ts";
import { useShortcut } from "#/lib/use-shortcuts.ts";
import { useTagTracks } from "#/lib/use-tag-tracks.ts";
import { cn } from "#/lib/utils.ts";

/** Where the picker opens: at the pointer, or over the playing song in the player bar. */
type Place = { kind: "pointer"; point: Point } | { kind: "song" };

function anchorFor(place: Place) {
	return {
		getBoundingClientRect: () => {
			if (place.kind === "pointer") {
				return new DOMRect(place.point.x, place.point.y, 0, 0);
			}
			const song = document.querySelector(`[${NOW_PLAYING_ATTRIBUTE}]`);
			return song?.getBoundingClientRect() ?? new DOMRect(16, window.innerHeight - 16, 0, 0);
		},
	};
}

const doneKey = (kind: PickRow["kind"], name: string) => `${kind}:${name.toLowerCase()}`;
const rowKey = (row: PickRow) => `${doneKey(row.kind, row.name)}${row.isNew ? "+" : ""}`;

function rowIcon(row: PickRow) {
	if (row.isNew) {
		return <Plus className="text-primary" />;
	}
	return row.kind === "playlist" ? (
		<ListPlus className="text-muted-foreground" />
	) : (
		<TagIcon className="text-muted-foreground" />
	);
}

function rowText(row: PickRow): string {
	return row.isNew ? `New ${row.kind} “${row.name}”` : row.name;
}

/** One playlist or tag in the list; the field keeps focus, so a press picks without moving it. */
function PickerRow({
	row,
	id,
	active,
	onPick,
	onHover,
}: {
	row: PickRow;
	id: string;
	active: boolean;
	onPick: () => void;
	onHover: () => void;
}) {
	return (
		<div
			id={id}
			role="option"
			aria-selected={active}
			tabIndex={-1}
			onMouseDown={(e) => {
				e.preventDefault();
				onPick();
			}}
			onMouseEnter={onHover}
			className={cn(
				"flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm [&_svg]:size-4 [&_svg]:shrink-0",
				active && "bg-muted",
			)}
		>
			{rowIcon(row)}
			<span className="min-w-0 flex-1 truncate">{rowText(row)}</span>
			{row.checked && <Check className="text-primary" />}
			{row.count !== null && (
				<span className="text-muted-foreground text-xs tabular-nums">{row.count}</span>
			)}
		</div>
	);
}

/** The search field and the playlists and tags it finds, for one song. */
function PickerBody({ track, onClose }: { track: Track; onClose: () => void }) {
	const tracks = [track];
	const { playlists, add } = useAddToPlaylist(tracks);
	const { tags, tag } = useTagTracks(tracks);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	// Picked while the picker is open, ticked at once; the picker stays open for more.
	const [done, setDone] = useState<ReadonlySet<string>>(new Set());
	const listId = useId();

	const rows = pickRows(
		query,
		playlists.map((p) => ({
			name: p.name,
			count: p.trackCount,
			checked: done.has(doneKey("playlist", p.name)),
		})),
		tags.map((t) => ({
			name: t.name,
			count: t.count,
			checked: t.checked || done.has(doneKey("tag", t.name)),
		})),
	);
	const at = Math.max(0, Math.min(active, rows.length - 1));

	const pick = (row: PickRow | undefined) => {
		if (!row) {
			return;
		}
		if (row.kind === "playlist") {
			add(row.name, row.isNew);
		} else {
			tag(row.name);
		}
		setDone((prev) => new Set(prev).add(doneKey(row.kind, row.name)));
		setQuery("");
		setActive(0);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		const key = pickerKey(e);
		if (key === null) {
			return;
		}
		e.preventDefault();
		if (key.kind === "step") {
			setActive((at + key.by + rows.length) % Math.max(rows.length, 1));
		} else if (key.kind === "pick") {
			pick(rows[at]);
		} else {
			// Escape empties the field first, then closes, as every search field does.
			e.stopPropagation();
			if (query === "") {
				onClose();
			} else {
				setQuery("");
			}
		}
	};

	return (
		<div className={cn(WELL, "w-72 p-1")}>
			<div className="truncate px-2 pt-1 pb-1.5 text-muted-foreground text-xs">
				Add “{track.title}” to
			</div>
			<input
				// biome-ignore lint/a11y/noAutofocus: the picker opens from a key, to type into at once
				autoFocus
				value={query}
				onChange={(e) => {
					setQuery(e.target.value);
					setActive(0);
				}}
				onKeyDown={onKeyDown}
				placeholder="Search or create a playlist or tag…"
				aria-label="Search or create a playlist or tag"
				role="combobox"
				aria-expanded
				aria-controls={listId}
				aria-activedescendant={rows[at] ? `${listId}-${at}` : undefined}
				spellCheck={false}
				autoComplete="off"
				className="mb-1 h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:border-ring"
			/>
			<div id={listId} role="listbox" className="max-h-72 overflow-y-auto">
				{rows.map((row, i) => (
					<PickerRow
						key={rowKey(row)}
						row={row}
						id={`${listId}-${i}`}
						active={i === at}
						onPick={() => pick(row)}
						onHover={() => setActive(i)}
					/>
				))}
				{rows.length === 0 && (
					<div className="px-2 py-1.5 text-muted-foreground text-sm">
						Type a name to make a playlist or tag.
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * The playing song's playlist and tag picker, on its key (A at first) from anywhere: it opens at
 * the pointer, or over the song in the player bar when the pointer is outside the window. Type to
 * find or make a playlist or tag, Enter to add the song; it stays open for more until Escape.
 */
export function PlayingPicker() {
	const { current } = usePlayer();
	const [place, setPlace] = useState<Place | null>(null);
	useShortcut("addPlaying", () => {
		if (current === null) {
			return;
		}
		const point = pointerInWindow();
		setPlace(point ? { kind: "pointer", point } : { kind: "song" });
	});
	const open = place !== null && current !== null;
	return (
		<Popover open={open} onOpenChange={(next) => !next && setPlace(null)}>
			{open && (
				<PopoverPopup
					anchor={anchorFor(place)}
					side={place.kind === "song" ? "top" : "bottom"}
					align="start"
					sideOffset={place.kind === "song" ? 8 : 4}
					collisionPadding={12}
					aria-label="Add the playing song to a playlist or tag"
					className={FLOATING_FRAME}
				>
					<PickerBody track={current} onClose={() => setPlace(null)} />
				</PopoverPopup>
			)}
		</Popover>
	);
}
