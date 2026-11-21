import {
	Check,
	ChevronRight,
	HardDrive,
	HardDriveDownload,
	ListMinus,
	ListMusic,
	ListPlus,
	type LucideIcon,
	Music,
	PencilLine,
	Sparkles,
	Tag,
	Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { AlbumArt } from "#/components/album-art.tsx";
import { LinkButton } from "#/components/check-list.tsx";
import { Hint } from "#/components/ui/hint.tsx";
import { pathArtUrl, type SongRef, type UsbDiff, type UsbMode } from "#/lib/api.ts";
import { plural } from "#/lib/export-selection.ts";
import { clock, formatBytes } from "#/lib/format.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { cn } from "#/lib/utils.ts";

type PlaylistChange = UsbDiff["playlists"][number];
type Kind = PlaylistChange["change"];

/** Where an exported playlist comes from; "drive" for one only the drive has. */
export type PlaylistSource = "playlist" | "tag" | "smart" | "drive";

const SHOWN = 200;

/** How each kind of change looks, here and in the footer's counts. */
const LOOK: Record<Kind, { icon: LucideIcon; title: string; tone: string }> = {
	added: { icon: ListPlus, title: "New on the drive", tone: "text-success" },
	updated: { icon: PencilLine, title: "Changed", tone: "text-primary" },
	removed: { icon: ListMinus, title: "Removed from the drive", tone: "text-destructive" },
	unchanged: { icon: Check, title: "Already up to date", tone: "text-muted-foreground" },
};

const SOURCE: Record<PlaylistSource, { icon: LucideIcon; hint: string }> = {
	playlist: { icon: ListMusic, hint: "Library playlist" },
	tag: { icon: Tag, hint: "Tag, exported as a playlist" },
	smart: { icon: Sparkles, hint: "Smart playlist" },
	drive: { icon: HardDrive, hint: "Only on the drive" },
};

const byArtist = (a: SongRef, b: SongRef) =>
	a.artist.localeCompare(b.artist, undefined, { sensitivity: "base" }) ||
	a.title.localeCompare(b.title, undefined, { sensitivity: "base" });

function SongArt({ song }: { song: SongRef }) {
	const [failed, setFailed] = useState(false);
	const box = "size-8 shrink-0 overflow-hidden rounded";
	if (song.trackId !== null) {
		return <AlbumArt trackId={song.trackId} className={box} />;
	}
	if (song.file && !failed) {
		return (
			<img
				src={pathArtUrl(song.file)}
				alt=""
				loading="lazy"
				className={cn(box, "bg-muted object-cover")}
				onError={() => setFailed(true)}
			/>
		);
	}
	return (
		<span className={cn(box, "grid place-items-center bg-muted text-muted-foreground")}>
			<Music className="size-3.5" />
		</span>
	);
}

/** BPM, key and length, in fixed columns so they line up down the list. */
const COLS = "grid grid-cols-[2.25rem_2rem_2.5rem] gap-x-2 text-right tabular-nums";

function SongRow({ song }: { song: SongRef }) {
	const sub = [song.artist, song.album].filter((s) => s !== "").join(" · ");
	return (
		<li className="flex min-w-0 items-center gap-2.5 rounded-md py-1 pr-1 pl-1.5 hover:bg-muted/60">
			<SongArt song={song} />
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm">{song.title || "Untitled"}</span>
				{sub && <span className="block truncate text-muted-foreground text-xs">{sub}</span>}
			</span>
			<span className={cn(COLS, "shrink-0 text-muted-foreground text-xs")}>
				<span>{song.bpm ? Math.round(song.bpm) : "–"}</span>
				<span>{song.key ?? "–"}</span>
				<span>{song.durationSecs ? clock(song.durationSecs) : "–"}</span>
			</span>
		</li>
	);
}

/**
 * A list of songs with cover, title, artist and album, then BPM, key and length. `tone` adds a
 * coloured bar and heading for songs going on or off the drive.
 */
function SongList({
	songs,
	tone,
	label,
	sort = false,
}: {
	songs: readonly SongRef[];
	tone?: "add" | "remove" | undefined;
	label?: string | undefined;
	/** By artist, for lists that have no order of their own. */
	sort?: boolean;
}) {
	const [all, setAll] = useState(false);
	const ordered = sort ? [...songs].sort(byArtist) : songs;
	// The same song can be listed twice, so its place makes the key unique.
	const keyed = (all ? ordered : ordered.slice(0, SHOWN)).map((song, place) => ({
		song,
		key: `${place}:${song.artist}:${song.title}`,
	}));
	return (
		<div className="border-t bg-muted/20 px-3 pt-1.5 pb-2">
			<div className="flex items-center justify-between gap-3 pt-1 pb-1 pl-1.5">
				<p
					className={cn(
						"font-medium text-xs",
						tone === "add" && "text-success",
						tone === "remove" && "text-destructive",
						!tone && "text-muted-foreground",
					)}
				>
					{label ?? plural(songs.length, "song")}
					{label && (
						<span className="pl-1.5 font-normal text-muted-foreground tabular-nums">
							{songs.length}
						</span>
					)}
				</p>
				<span className={cn(COLS, "pr-1 text-[0.6875rem] text-muted-foreground")}>
					<span>BPM</span>
					<span>Key</span>
					<span>Time</span>
				</span>
			</div>
			<ul
				className={cn(
					"max-h-80 space-y-px overflow-y-auto",
					tone && "border-l-2 pl-1.5",
					tone === "add" && "border-success/60",
					tone === "remove" && "border-destructive/60",
				)}
			>
				{keyed.map(({ song, key }) => (
					<SongRow key={key} song={song} />
				))}
			</ul>
			{!all && songs.length > SHOWN && (
				<LinkButton onClick={() => setAll(true)}>
					Show all {songs.length.toLocaleString()}
				</LinkButton>
			)}
		</div>
	);
}

/** A row that opens to more detail. */
function Row({ head, children }: { head: ReactNode; children: ReactNode }) {
	return (
		<details className="group/row">
			<summary className="flex min-h-9 cursor-pointer list-none items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-muted/50">
				{head}
				<ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open/row:rotate-90" />
			</summary>
			{children}
		</details>
	);
}

function UpdatedSongs({ p }: { p: PlaylistChange }) {
	const [whole, setWhole] = useState(false);
	return (
		<>
			{p.added.length > 0 && <SongList songs={p.added} tone="add" label="Added" sort />}
			{p.removed.length > 0 && <SongList songs={p.removed} tone="remove" label="Taken out" sort />}
			{whole ? (
				<SongList songs={p.tracks} label="Whole playlist" />
			) : (
				<div className="border-t px-4 py-1.5">
					<LinkButton onClick={() => setWhole(true)}>
						Show the whole playlist ({plural(p.tracks.length, "song")})
					</LinkButton>
				</div>
			)}
		</>
	);
}

function PlaylistRow({ p, source }: { p: PlaylistChange; source: PlaylistSource }) {
	const { icon: Icon, hint } = SOURCE[source];
	const removed = p.change === "removed";
	return (
		<Row
			head={
				<>
					<Hint label={hint}>
						<span className="shrink-0 text-muted-foreground">
							<Icon className="size-4" aria-label={hint} />
						</span>
					</Hint>
					<span className={cn("min-w-0 flex-1 truncate", removed && "text-muted-foreground")}>
						{p.name}
					</span>
					<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
						{p.change === "updated" ? (
							<span className="flex gap-1.5">
								{p.added.length > 0 && (
									<Hint label={`${plural(p.added.length, "song")} added`}>
										<span className="text-success">+{p.added.length}</span>
									</Hint>
								)}
								{p.removed.length > 0 && (
									<Hint label={`${plural(p.removed.length, "song")} taken out`}>
										<span className="text-destructive">−{p.removed.length}</span>
									</Hint>
								)}
							</span>
						) : (
							plural(p.songs, "song")
						)}
					</span>
				</>
			}
		>
			{p.change === "updated" ? (
				<UpdatedSongs p={p} />
			) : (
				<SongList
					songs={p.tracks}
					tone={p.change === "added" ? "add" : removed ? "remove" : undefined}
					label={removed ? "Leaves the drive with it" : undefined}
				/>
			)}
		</Row>
	);
}

/** Playlists with one kind of change, under a small heading in that change's colour. */
function ChangeGroup({
	kind,
	lists,
	sourceOf,
}: {
	kind: Kind;
	lists: readonly PlaylistChange[];
	sourceOf: (name: string) => PlaylistSource;
}) {
	const { icon: Icon, title, tone } = LOOK[kind];
	if (lists.length === 0) {
		return null;
	}
	const rows = lists.map((p) => (
		<PlaylistRow key={p.name} p={p} source={p.change === "removed" ? "drive" : sourceOf(p.name)} />
	));
	const heading = (
		<>
			<Icon className="size-3.5" aria-hidden="true" />
			{title}
			<span className="font-normal text-muted-foreground tabular-nums">{lists.length}</span>
		</>
	);
	if (kind === "unchanged") {
		return (
			<details className="group/same">
				<summary
					className={cn(
						"flex cursor-pointer list-none items-center gap-1.5 px-3 py-2.5 font-medium text-xs hover:bg-muted/50",
						tone,
					)}
				>
					{heading}
					<ChevronRight className="ml-auto size-4 transition-transform group-open/same:rotate-90" />
				</summary>
				<div className="divide-y border-t">{rows}</div>
			</details>
		);
	}
	return (
		<div>
			<p className={cn("flex items-center gap-1.5 px-3 pt-2.5 pb-1 font-medium text-xs", tone)}>
				{heading}
			</p>
			<div className="divide-y">{rows}</div>
		</div>
	);
}

function Card({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="space-y-2">
			<h3 className={typeScale.sectionTitle}>{title}</h3>
			<div className="divide-y overflow-hidden rounded-lg border">{children}</div>
		</section>
	);
}

/** One line of the Songs card: what happens, how many, how big. */
function SongsRow({
	icon: Icon,
	tone,
	label,
	empty,
	songs,
	bytes,
	listTone,
}: {
	icon: LucideIcon;
	tone: string;
	label: string;
	empty: string;
	songs: readonly SongRef[];
	bytes: number;
	listTone: "add" | "remove";
}) {
	if (songs.length === 0) {
		return (
			<div className="flex min-h-9 items-center gap-2.5 px-3 py-1.5 text-muted-foreground text-sm">
				<Icon className="size-4 shrink-0" />
				{empty}
			</div>
		);
	}
	return (
		<Row
			head={
				<>
					<Icon className={cn("size-4 shrink-0", tone)} />
					<span className="flex-1">
						{label} {plural(songs.length, "song")}
					</span>
					<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
						{formatBytes(bytes)}
					</span>
				</>
			}
		>
			<SongList songs={songs} tone={listTone} sort />
		</Row>
	);
}

/**
 * What an export is about to do to the drive, before anything is written: playlists grouped by
 * what happens to them, each opening to its songs, then songs copied and deleted.
 */
export function Review({
	diff,
	mode,
	serato,
	sourceOf,
}: {
	diff: UsbDiff;
	mode: UsbMode;
	/** The playlists are also written as Serato crates. */
	serato: boolean;
	/** Whether an exported playlist is a library playlist, a tag or a smart playlist. */
	sourceOf: (name: string) => PlaylistSource;
}) {
	const of = (kind: Kind) => diff.playlists.filter((p) => p.change === kind);
	return (
		<div className="space-y-5">
			<Card title="Playlists">
				{(["added", "updated", "removed"] as const).some((k) => of(k).length > 0) && (
					<div className="divide-y">
						<ChangeGroup kind="added" lists={of("added")} sourceOf={sourceOf} />
						<ChangeGroup kind="updated" lists={of("updated")} sourceOf={sourceOf} />
						<ChangeGroup kind="removed" lists={of("removed")} sourceOf={sourceOf} />
					</div>
				)}
				<ChangeGroup kind="unchanged" lists={of("unchanged")} sourceOf={sourceOf} />
				{mode === "add" && (
					<p className="px-3 py-2 text-muted-foreground text-xs">
						Other playlists on the drive stay as they are.
					</p>
				)}
				{serato && (
					<p className="px-3 py-2 text-muted-foreground text-xs">
						Each exported playlist is also written as a Serato crate
						{mode !== "add" && ", and removed playlists' crates go too"}.
					</p>
				)}
			</Card>
			<Card title="Songs">
				<SongsRow
					icon={HardDriveDownload}
					tone="text-success"
					label="Copy"
					empty="No new songs to copy"
					songs={diff.copy}
					bytes={diff.copyBytes}
					listTone="add"
				/>
				{mode === "replaceAll" && (
					<SongsRow
						icon={Trash2}
						tone="text-destructive"
						label="Delete"
						empty="No songs to delete"
						songs={diff.delete}
						bytes={diff.deleteBytes}
						listTone="remove"
					/>
				)}
			</Card>
			{mode !== "add" && (
				<p className="text-pretty text-muted-foreground text-xs">
					The drive's current library is backed up on the drive first.
					{mode === "replaceAll" && " Deleted song files are not backed up."}
				</p>
			)}
		</div>
	);
}

function Count({
	icon: Icon,
	n,
	tone,
	title,
}: {
	icon: LucideIcon;
	n: number;
	tone: string;
	title: string;
}) {
	return (
		<Hint label={title}>
			<button
				type="button"
				className={cn(
					"flex cursor-default items-center gap-1 rounded tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
					n === 0 ? "opacity-40" : tone,
				)}
			>
				<Icon className="size-3.5" aria-hidden="true" />
				<span className="sr-only">{title}: </span>
				{n.toLocaleString()}
			</button>
		</Hint>
	);
}

/** The review in figures for the footer: playlists new, changed, removed; songs in and out. */
export function ReviewCounts({ diff }: { diff: UsbDiff }) {
	const n = (kind: Kind) => diff.playlists.filter((p) => p.change === kind).length;
	const lists = (k: number, what: string) => `${plural(k, "playlist")} ${what}`;
	const songs = (k: number, what: string, bytes: number) =>
		`${plural(k, "song")} ${what}${k > 0 ? `, ${formatBytes(bytes)}` : ""}`;
	return (
		<span className="flex min-w-0 items-center gap-3 text-sm">
			<Count
				icon={ListPlus}
				n={n("added")}
				tone={LOOK.added.tone}
				title={lists(n("added"), "new on the drive")}
			/>
			<Count
				icon={PencilLine}
				n={n("updated")}
				tone={LOOK.updated.tone}
				title={lists(n("updated"), "changed")}
			/>
			<Count
				icon={ListMinus}
				n={n("removed")}
				tone={LOOK.removed.tone}
				title={lists(n("removed"), "removed from the drive")}
			/>
			<span className="h-4 w-px bg-border" aria-hidden="true" />
			<Count
				icon={HardDriveDownload}
				n={diff.copy.length}
				tone="text-success"
				title={songs(diff.copy.length, "to copy", diff.copyBytes)}
			/>
			{diff.delete.length > 0 && (
				<Count
					icon={Trash2}
					n={diff.delete.length}
					tone="text-destructive"
					title={songs(diff.delete.length, "to delete", diff.deleteBytes)}
				/>
			)}
		</span>
	);
}
