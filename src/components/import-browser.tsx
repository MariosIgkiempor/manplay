import {
	Building2,
	CalendarDays,
	CheckSquare,
	ChevronRight,
	Clock,
	Disc3,
	FileArchive,
	ImageIcon,
	Loader2,
	Music,
	Pause,
	Play,
	Plus,
	Tag,
	Trash2,
} from "lucide-react";
import {
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { type MenuEntry, RowMenu } from "#/components/menu.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Input } from "#/components/ui/input.tsx";
import { audioUrl, type ImportGroup, type ImportTrack } from "#/lib/api.ts";
import { clock } from "#/lib/format.ts";
import { groupFacts, type Quality, qualityOf } from "#/lib/import-meta.ts";
import { allKeys, type Edit, newKeys, type Placement, trackKey } from "#/lib/import-state.ts";
import { TRASH } from "#/lib/platform.ts";
import type { Modifiers } from "#/lib/selection.ts";
import { cn } from "#/lib/utils.ts";

export interface Playback {
	/** Key of the track the player currently has loaded from this page. */
	activeKey: string | null;
	isPlaying: boolean;
	/** Key of the track being prepared (zip entries are extracted first). */
	loading: string | null;
	onToggle: (track: ImportTrack) => void;
}

const stateOf = (playback: Playback, track: ImportTrack) => {
	const key = trackKey(track);
	return {
		active: playback.activeKey === key,
		playing: playback.activeKey === key && playback.isPlaying,
		loading: playback.loading === key,
	};
};

const mods = (e: MouseEvent): Modifiers => ({ shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey });

/** Space picks the row, Enter plays it. */
function rowKeys(e: KeyboardEvent, pick: () => void, play: () => void) {
	if (e.target !== e.currentTarget) {
		return;
	}
	if (e.key === " ") {
		e.preventDefault();
		pick();
	} else if (e.key === "Enter") {
		e.preventDefault();
		play();
	}
}

/**
 * Columns shared by release and track rows, so figures line up down the list:
 * checkbox, expand / play, the name (with any status beside it), length and quality. The name
 * takes all the room that is left, so nothing sits empty on the right.
 */
const ROW_COLUMNS =
	"grid grid-cols-[1.25rem_1.75rem_minmax(0,1fr)] items-center gap-x-3 @2xl/import:grid-cols-[1.25rem_1.75rem_minmax(0,1fr)_3.5rem_6.5rem]";

// ---- pieces ------------------------------------------------------------------

/** A checkbox that can also show "some" for a release with part of its tracks picked. */
function Check({
	checked,
	some = false,
	disabled = false,
	label,
	onChange,
}: {
	checked: boolean;
	some?: boolean;
	disabled?: boolean;
	label: string;
	onChange: () => void;
}) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (ref.current) {
			ref.current.indeterminate = some && !checked;
		}
	}, [some, checked]);
	return (
		<input
			ref={ref}
			type="checkbox"
			className="size-4 accent-primary"
			aria-label={label}
			checked={checked}
			disabled={disabled}
			onClick={(e) => e.stopPropagation()}
			onChange={onChange}
		/>
	);
}

/** A file's bitrate or sample rate, amber when it is thin for playing out. */
function QualityChip({ quality }: { quality: Quality }) {
	return (
		<span
			title={quality.low ? "Low bitrate: may sound thin on a club system" : quality.label}
			className={cn(
				"inline-flex max-w-full truncate rounded px-1.5 py-px font-medium text-[11px] tabular-nums",
				quality.low ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground",
			)}
		>
			{quality.label}
		</span>
	);
}

/** One tagged figure in its column, faint when the file does not say. */
function Cell({ value, title }: { value: string | null; title: string }) {
	return (
		<span
			title={title}
			className={cn(
				"hidden text-right text-xs tabular-nums @2xl/import:block",
				value ? "text-muted-foreground" : "text-muted-foreground/30",
			)}
		>
			{value ?? "–"}
		</span>
	);
}

/** Length and quality columns for one track. */
function Figures({ track }: { track: ImportTrack | undefined }) {
	return (
		<>
			<Cell value={track?.durationMs ? clock(track.durationMs / 1000) : null} title="Length" />
			<span className="hidden justify-end @2xl/import:flex">
				{track && <QualityChip quality={qualityOf(track)} />}
			</span>
		</>
	);
}

/** The track number, or play / pause / loading for the one being previewed. */
function PlayCell({
	track,
	playback,
	number,
}: {
	track: ImportTrack;
	playback: Playback;
	number: number;
}) {
	const s = stateOf(playback, track);
	let icon: ReactNode = (
		<>
			<span className="group-hover/row:hidden">{number}</span>
			<Play className="hidden size-3.5 group-hover/row:block" />
		</>
	);
	if (s.loading) {
		icon = <Loader2 className="size-3.5 animate-spin" />;
	} else if (s.active) {
		icon = s.playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />;
	}
	return (
		<button
			type="button"
			aria-label={s.playing ? `Pause ${track.title}` : `Play ${track.title}`}
			onClick={(e) => {
				e.stopPropagation();
				playback.onToggle(track);
			}}
			onDoubleClick={(e) => e.stopPropagation()}
			className={cn(
				"grid size-7 place-items-center rounded text-xs tabular-nums hover:bg-background/60",
				s.active ? "text-primary" : "text-muted-foreground",
			)}
		>
			{icon}
		</button>
	);
}

/** Text that looks like a label until hovered or focused, then edits in place. */
function InlineField({
	label,
	list,
	value,
	onChange,
	className,
}: {
	label: string;
	list: string;
	value: string;
	onChange: (v: string) => void;
	className?: string;
}) {
	return (
		<Input
			aria-label={label}
			list={list}
			value={value}
			placeholder={label}
			onChange={(e) => onChange(e.target.value)}
			onClick={(e) => e.stopPropagation()}
			onDoubleClick={(e) => e.stopPropagation()}
			title={`${label}: click to edit`}
			className={cn(
				"h-6 min-w-0 border-transparent bg-transparent px-1 shadow-none hover:border-input focus-visible:bg-background dark:bg-transparent",
				className,
			)}
		/>
	);
}

/** A small cover for the release row; a tinted tile with an icon when the folder has none. */
function Thumb({ group }: { group: ImportGroup }) {
	const [broken, setBroken] = useState(false);
	const image = group.fromZip ? undefined : group.images[0];
	const Icon = group.fromZip ? FileArchive : group.kind === "single" ? Music : Disc3;
	if (image && !broken) {
		return (
			<img
				src={audioUrl(image.path)}
				alt=""
				draggable={false}
				onError={() => setBroken(true)}
				className="size-8 shrink-0 rounded object-cover ring-1 ring-foreground/10"
			/>
		);
	}
	return (
		<span className="grid size-8 shrink-0 place-items-center rounded bg-muted text-muted-foreground">
			<Icon className="size-4" />
		</span>
	);
}

const PLACEMENT: Record<Placement, string> = {
	existing: "Adds to album",
	"new album": "New album",
	"new artist": "New artist",
};

/** Year, genre, label and art for a release, as small icon figures. */
function ReleaseFacts({ group }: { group: ImportGroup }) {
	const f = groupFacts(group);
	const items: [ReactNode, string | null, string][] = [
		[<CalendarDays key="y" />, f.year, "Year"],
		[<Tag key="g" />, f.genre, "Genre"],
		[<Building2 key="l" />, f.label, "Label"],
	];
	return (
		<span className="hidden min-w-0 items-center gap-3 text-muted-foreground text-xs @xl/import:flex">
			{items.map(
				([icon, value, title]) =>
					value && (
						<span
							key={title}
							title={title}
							className="flex min-w-0 items-center gap-1 [&_svg]:size-3 [&_svg]:shrink-0 [&_svg]:opacity-60"
						>
							{icon}
							<span className="truncate">{value}</span>
						</span>
					),
			)}
			{f.embeddedArt && (
				<span title="Cover art inside the files" className="[&_svg]:size-3 [&_svg]:opacity-60">
					<ImageIcon />
				</span>
			)}
		</span>
	);
}

const STATUS: Record<Exclude<ImportTrack["status"], "new">, { label: string; hint: string }> = {
	inLibrary: { label: "In library", hint: "This exact file is already in your library." },
	sameAudio: {
		label: "Same audio",
		hint: "Your library has this recording under another name or tags",
	},
	duplicate: { label: "Repeat", hint: "The same audio appears earlier in Downloads." },
};

/** Why a track cannot be imported, with where the library has it on hover. */
function StatusBadge({ track }: { track: ImportTrack }) {
	if (track.status === "new") {
		return null;
	}
	const s = STATUS[track.status];
	const hint = track.sameAs ? `${s.hint}: ${track.sameAs}` : s.hint;
	return (
		<Badge variant="secondary" title={hint} className="shrink-0">
			{s.label}
		</Badge>
	);
}

// ---- rows --------------------------------------------------------------------

export interface ReleaseProps {
	group: ImportGroup;
	edit: Edit;
	onEdit: (next: { artist: string; album: string }) => void;
	selected: ReadonlySet<string>;
	onClick: (key: string, mods: Modifiers) => void;
	onToggle: (key: string) => void;
	onSetMany: (keys: readonly string[], on: boolean) => void;
	onImport: (keys: readonly string[]) => void;
	onTrash: (keys: readonly string[]) => void;
	busy: boolean;
	artistList: string;
	albums: string[];
	placement: Placement;
	playback: Playback;
}

function TrackRow({
	track,
	number,
	edit,
	p,
}: {
	track: ImportTrack;
	number: number;
	edit: Edit;
	p: ReleaseProps;
}) {
	const key = trackKey(track);
	const isNew = track.status === "new";
	const picked = p.selected.has(key);
	const active = stateOf(p.playback, track).active;
	// Right-click acts on the whole selection when this row is part of it.
	const keys = picked && p.selected.size > 1 ? [...p.selected] : [key];
	return (
		<RowMenu
			label={keys.length > 1 ? `${keys.length} tracks` : track.title}
			items={[
				{ label: "Play", icon: <Play />, onSelect: () => p.playback.onToggle(track) },
				isNew && {
					label: keys.length > 1 ? "Import picked" : "Import",
					icon: <Plus />,
					disabled: p.busy,
					onSelect: () => p.onImport(keys),
				},
				"separator",
				{
					label: `Move to ${TRASH}…`,
					icon: <Trash2 />,
					destructive: true,
					onSelect: () => p.onTrash(keys),
				},
			]}
		>
			<div
				role="option"
				aria-selected={picked}
				tabIndex={0}
				onClick={(e) => p.onClick(key, mods(e))}
				onDoubleClick={() => p.playback.onToggle(track)}
				onKeyDown={(e) =>
					rowKeys(
						e,
						() => p.onToggle(key),
						() => p.playback.onToggle(track),
					)
				}
				className={cn(
					ROW_COLUMNS,
					"group/row h-8 cursor-default rounded-md px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
					picked ? "bg-primary/15" : "hover:bg-muted/50",
					active && !picked && "bg-muted",
					!isNew && "text-muted-foreground",
				)}
			>
				<Check checked={picked} label={`Pick ${track.title}`} onChange={() => p.onToggle(key)} />
				<PlayCell track={track} playback={p.playback} number={number} />
				<span className="flex min-w-0 items-center gap-2 pl-10" title={track.file}>
					<span className="truncate">{track.title}</span>
					{track.artist !== "" && track.artist !== edit.artist && (
						<span className="truncate text-muted-foreground text-xs">{track.artist}</span>
					)}
					<StatusBadge track={track} />
				</span>
				<Figures track={track} />
			</div>
		</RowMenu>
	);
}

/** Album and artist, editable in place, and what the release adds up to. */
function ReleaseName({ p, single }: { p: ReleaseProps; single: boolean }) {
	const { group, edit } = p;
	return (
		<div className="min-w-0 flex-1">
			<div className="flex min-w-0 items-center">
				<InlineField
					label="Album"
					list={`import-albums-${group.id}`}
					value={edit.album}
					onChange={(v) => p.onEdit({ artist: edit.artist, album: v })}
					className="max-w-[60%] font-medium text-sm md:text-sm"
				/>
				<span className="shrink-0 px-1 text-muted-foreground/50 text-xs">by</span>
				<InlineField
					label="Artist"
					list={p.artistList}
					value={edit.artist}
					onChange={(v) => p.onEdit({ artist: v, album: edit.album })}
					className="text-muted-foreground text-sm md:text-sm"
				/>
			</div>
			<div className="flex min-w-0 items-center gap-3 px-1 text-muted-foreground text-xs">
				<span className="shrink-0">{PLACEMENT[p.placement]}</span>
				{!single && <span className="shrink-0 tabular-nums">{group.tracks.length} tracks</span>}
				{group.fromZip && (
					<span title={group.origin} className="flex shrink-0 items-center gap-1">
						<FileArchive className="size-3" /> Zip
					</span>
				)}
				<ReleaseFacts group={group} />
			</div>
		</div>
	);
}

/** Imports every new track of the release, shown on hover. */
function ImportReleaseButton({ keys, p }: { keys: readonly string[]; p: ReleaseProps }) {
	return (
		<button
			type="button"
			disabled={p.busy || keys.length === 0}
			onClick={(e) => {
				e.stopPropagation();
				p.onImport(keys);
			}}
			title={`Import the ${keys.length} new ${keys.length === 1 ? "track" : "tracks"} of this release`}
			className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-primary text-xs opacity-0 outline-none transition-opacity hover:bg-primary/10 focus-visible:opacity-100 disabled:hidden group-hover/row:opacity-100 [&_svg]:size-3.5"
		>
			<Plus /> Import
		</button>
	);
}

/** A single's own figures, or an album's total length and shared quality. */
function ReleaseFigures({
	group,
	single,
}: {
	group: ImportGroup;
	single: ImportTrack | undefined;
}) {
	if (single) {
		return <Figures track={single} />;
	}
	const f = groupFacts(group);
	return (
		<>
			<Cell value={f.seconds !== null ? clock(f.seconds) : null} title="Total length" />
			<span className="hidden justify-end @2xl/import:flex">
				{f.quality && <QualityChip quality={f.quality} />}
			</span>
		</>
	);
}

/** Opens and closes an album's track list. */
function Expand({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			aria-label={open ? "Hide tracks" : "Show tracks"}
			aria-expanded={open}
			onClick={(e) => {
				e.stopPropagation();
				onToggle();
			}}
			className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-background/60"
		>
			<ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
		</button>
	);
}

/** Right-click items for a release row. */
function releaseMenu(
	p: ReleaseProps,
	keys: readonly string[],
	fresh: readonly string[],
): MenuEntry[] {
	return [
		fresh.length > 0 && {
			label: `Import ${fresh.length} new ${fresh.length === 1 ? "track" : "tracks"}`,
			icon: <Plus />,
			disabled: p.busy,
			onSelect: () => p.onImport(fresh),
		},
		{ label: "Pick all", icon: <CheckSquare />, onSelect: () => p.onSetMany(keys, true) },
		"separator",
		{
			label: `Move ${p.group.fromZip ? "zip" : "release"} to ${TRASH}…`,
			icon: <Trash2 />,
			destructive: true,
			onSelect: () => p.onTrash(keys),
		},
	];
}

/**
 * A release (album folder, zip or single file) as one row with its tracks under it. Its checkbox
 * picks every new track in it; a single shows its own figures and has nothing to expand.
 */
export function ReleaseRows(p: ReleaseProps) {
	const { group, edit } = p;
	const single = group.tracks.length === 1 ? group.tracks[0] : undefined;
	const [open, setOpen] = useState(!single);
	const keys = allKeys(group);
	const fresh = newKeys(group);
	const picked = keys.filter((k) => p.selected.has(k)).length;
	const all = picked > 0 && picked === keys.length;
	const pickAll = () => p.onSetMany(keys, !all);
	return (
		<div className="@container/import">
			<RowMenu label={edit.album || group.origin} items={releaseMenu(p, keys, fresh)}>
				<div
					role="option"
					aria-selected={all}
					tabIndex={0}
					onClick={(e) => (single && keys[0] ? p.onClick(keys[0], mods(e)) : setOpen(!open))}
					onDoubleClick={() => single && p.playback.onToggle(single)}
					onKeyDown={(e) =>
						rowKeys(e, pickAll, () => (single ? p.playback.onToggle(single) : setOpen(!open)))
					}
					className={cn(
						ROW_COLUMNS,
						"group/row min-h-11 cursor-default rounded-md px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
						single && all ? "bg-primary/15" : "hover:bg-muted/50",
					)}
				>
					<Check
						checked={all}
						some={picked > 0}
						label={`Pick every track of ${edit.album || "this release"}`}
						onChange={pickAll}
					/>
					{single ? (
						<PlayCell track={single} playback={p.playback} number={1} />
					) : (
						<Expand open={open} onToggle={() => setOpen(!open)} />
					)}
					<div className="flex min-w-0 items-center gap-2">
						<Thumb group={group} />
						<ReleaseName p={p} single={single !== undefined} />
						{single ? (
							<StatusBadge track={single} />
						) : (
							picked > 0 && (
								<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
									{picked} of {keys.length}
								</span>
							)
						)}
						<ImportReleaseButton keys={fresh} p={p} />
					</div>
					<ReleaseFigures group={group} single={single} />
				</div>
			</RowMenu>
			<datalist id={`import-albums-${group.id}`}>
				{p.albums.map((a) => (
					<option key={a} value={a} />
				))}
			</datalist>
			{open &&
				!single &&
				group.tracks.map((t, i) => (
					<TrackRow key={trackKey(t)} track={t} number={t.track ?? i + 1} edit={edit} p={p} />
				))}
		</div>
	);
}

/** Column names over the list, in the same grid as the rows. */
export function BrowserHeader() {
	const cols: [string, ReactNode][] = [
		["Time", <Clock key="t" />],
		["Quality", null],
	];
	return (
		<div className="@container/import">
			<div
				className={cn(ROW_COLUMNS, "h-7 border-b px-2 font-medium text-muted-foreground text-xs")}
			>
				<span />
				<span />
				<span>Release</span>
				{cols.map(([label, icon]) => (
					<span
						key={label}
						className="hidden items-center justify-end gap-1 @2xl/import:flex [&_svg]:size-3"
					>
						{icon}
						{label}
					</span>
				))}
			</div>
		</div>
	);
}
