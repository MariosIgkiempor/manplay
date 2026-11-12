import {
	ChevronDown,
	ChevronRight,
	Disc3,
	FileArchive,
	Loader2,
	Music,
	Pause,
	Play,
	Plus,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { audioUrl, type ImportGroup, type ImportTrack } from "#/lib/api.ts";
import { formatBytes, timeAgo } from "#/lib/format.ts";
import { type Edit, type Placement, trackKey } from "#/lib/import-state.ts";

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

// ---- cover -------------------------------------------------------------------

/** A quiet tint derived from the album name, so cover-less albums are told apart at a glance. */
function tintFor(name: string): string {
	let h = 0;
	for (const c of name) {
		h = (h * 31 + c.charCodeAt(0)) % 360;
	}
	return `oklch(0.32 0.04 ${h})`;
}

function OverlayIcon({ state }: { state: ReturnType<typeof stateOf> | null }) {
	if (state?.loading) {
		return <Loader2 className="size-5 animate-spin" />;
	}
	return state?.playing ? <Pause className="size-5" /> : <Play className="size-5" />;
}

function Cover({
	group,
	playback,
	target,
}: {
	group: ImportGroup;
	playback: Playback;
	target: ImportTrack | undefined;
}) {
	const [broken, setBroken] = useState(false);
	const image = group.fromZip ? undefined : group.images[0];
	const Icon = group.fromZip ? FileArchive : group.kind === "single" ? Music : Disc3;
	const state = target ? stateOf(playback, target) : null;
	const show = state?.active ?? false;
	return (
		<div
			className="group/cover relative size-24 shrink-0 overflow-hidden rounded-lg border"
			style={{ backgroundColor: tintFor(group.album || group.origin) }}
		>
			{image && !broken ? (
				<img
					src={audioUrl(image.path)}
					alt=""
					draggable={false}
					className="size-full object-cover"
					onError={() => setBroken(true)}
				/>
			) : (
				<div className="grid size-full place-items-center text-white/50">
					<Icon className="size-8" />
				</div>
			)}
			{target && (
				<button
					type="button"
					aria-label={`Play ${target.title}`}
					onClick={() => playback.onToggle(target)}
					className={`absolute inset-0 grid place-items-center bg-black/45 text-white transition-opacity focus-visible:opacity-100 group-hover/cover:opacity-100 ${show ? "opacity-100" : "opacity-0"}`}
				>
					<OverlayIcon state={state} />
				</button>
			)}
		</div>
	);
}

// ---- tracks ------------------------------------------------------------------

function TrackRow({
	track,
	index,
	hideArtist,
	checked,
	onToggle,
	playback,
}: {
	track: ImportTrack;
	index: number;
	hideArtist: boolean;
	checked: boolean;
	onToggle: () => void;
	playback: Playback;
}) {
	const isNew = track.status === "new";
	const s = stateOf(playback, track);
	let lead = (
		<>
			<span className="group-hover/row:hidden">{index + 1}</span>
			<Play className="hidden size-3.5 group-hover/row:block" />
		</>
	);
	if (s.loading) {
		lead = <Loader2 className="size-3.5 animate-spin" />;
	} else if (s.active) {
		lead = s.playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />;
	}
	return (
		<div
			className={`group/row flex items-center gap-3 rounded-md py-1 pr-2 text-sm ${s.active ? "bg-muted" : "hover:bg-muted/50"} ${isNew ? "" : "text-muted-foreground"}`}
		>
			<button
				type="button"
				aria-label={`Play ${track.title}`}
				onClick={() => playback.onToggle(track)}
				className={`grid size-8 shrink-0 place-items-center text-xs tabular-nums ${s.active ? "text-foreground" : "text-muted-foreground"}`}
			>
				{lead}
			</button>
			<span className="min-w-0 flex-1 truncate">
				{track.title}
				{!hideArtist && track.artist !== "" && (
					<span className="ml-2 text-muted-foreground text-xs">{track.artist}</span>
				)}
			</span>
			{!isNew && (
				<Badge variant="secondary">
					{track.status === "inLibrary" ? "in library" : "duplicate"}
				</Badge>
			)}
			<span className="w-16 shrink-0 text-right text-muted-foreground text-xs tabular-nums">
				{formatBytes(track.size)}
			</span>
			<input
				type="checkbox"
				className="size-4 shrink-0 accent-primary"
				aria-label={`Include ${track.title}`}
				checked={isNew && checked}
				disabled={!isNew}
				onChange={onToggle}
			/>
		</div>
	);
}

// ---- card --------------------------------------------------------------------

/** Text that looks like a label until you hover or focus it, then behaves like an input. */
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
	className: string;
}) {
	return (
		<Input
			aria-label={label}
			list={list}
			value={value}
			placeholder={label}
			onChange={(e) => onChange(e.target.value)}
			title="Click to edit"
			className={`-ml-2 h-7 w-full border-transparent bg-transparent px-2 shadow-none hover:border-input focus-visible:bg-background dark:bg-transparent ${className}`}
		/>
	);
}

function PlacementBadge({ placement }: { placement: Placement }) {
	if (placement === "existing") {
		return <Badge variant="secondary">adds to existing album</Badge>;
	}
	return <Badge variant="outline">{placement}</Badge>;
}

export interface GroupCardProps {
	group: ImportGroup;
	edit: Edit;
	onEdit: (next: { artist: string; album: string }) => void;
	unchecked: Set<string>;
	onToggle: (key: string) => void;
	onAdd: () => void;
	adding: boolean;
	busy: boolean;
	artistList: string;
	albums: string[];
	placement: Placement;
	playback: Playback;
}

function meta(g: ImportGroup, fresh: number, picked: number): string {
	const parts = [timeAgo(g.modified)];
	if (g.kind === "album") {
		parts.push(`${g.tracks.length} tracks`);
	}
	if (fresh !== g.tracks.length) {
		parts.push(`${g.tracks.length - fresh} already in library`);
	}
	if (picked !== fresh) {
		parts.push(`${picked} of ${fresh} selected`);
	}
	return parts.join(" · ");
}

export function GroupCard(p: GroupCardProps) {
	const { group, edit } = p;
	const [open, setOpen] = useState(false);
	const fresh = group.tracks.filter((t) => t.status === "new");
	const picked = fresh.filter((t) => !p.unchecked.has(trackKey(t))).length;
	const albumList = `import-albums-${group.id}`;
	const expandable = group.tracks.length > 1;
	const ToggleIcon = open ? ChevronDown : ChevronRight;
	return (
		<section className="rounded-xl border bg-card p-3">
			<div className="flex items-center gap-4">
				<Cover group={group} playback={p.playback} target={fresh[0] ?? group.tracks[0]} />
				<div className="min-w-0 flex-1">
					<InlineField
						label="Album"
						list={albumList}
						value={edit.album}
						onChange={(v) => p.onEdit({ artist: edit.artist, album: v })}
						className="font-semibold text-base md:text-base"
					/>
					<InlineField
						label="Artist"
						list={p.artistList}
						value={edit.artist}
						onChange={(v) => p.onEdit({ artist: v, album: edit.album })}
						className="text-muted-foreground text-sm md:text-sm"
					/>
					<div className="flex items-center gap-2 pt-1.5 text-muted-foreground text-xs">
						<PlacementBadge placement={p.placement} />
						<span className="truncate" title={group.origin}>
							{group.fromZip && <FileArchive className="mr-1 inline size-3 align-[-2px]" />}
							{meta(group, fresh.length, picked)}
						</span>
					</div>
				</div>
				<Button size="lg" onClick={p.onAdd} disabled={p.busy || picked === 0}>
					{p.adding ? <Loader2 className="animate-spin" /> : <Plus />}
					{p.adding ? "Adding…" : `Add ${picked}`}
				</Button>
			</div>
			<datalist id={albumList}>
				{p.albums.map((a) => (
					<option key={a} value={a} />
				))}
			</datalist>
			{expandable && (
				<Button
					variant="ghost"
					size="xs"
					className="mt-2 text-muted-foreground"
					aria-expanded={open}
					onClick={() => setOpen(!open)}
				>
					<ToggleIcon />
					{open ? "Hide tracks" : "Show tracks"}
				</Button>
			)}
			{expandable && open && (
				<div className="mt-1 border-t pt-2">
					{group.tracks.map((t, i) => (
						<TrackRow
							key={trackKey(t)}
							track={t}
							index={i}
							hideArtist={t.artist === "" || t.artist === edit.artist}
							checked={!p.unchecked.has(trackKey(t))}
							onToggle={() => p.onToggle(trackKey(t))}
							playback={p.playback}
						/>
					))}
				</div>
			)}
		</section>
	);
}
