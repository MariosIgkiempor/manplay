import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandGroupLabel,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ui-sdk/react/command";
import {
	AudioWaveform,
	Database,
	Download,
	FolderTree,
	Library,
	ListMusic,
	Mic2,
	Music,
	Plus,
	RefreshCw,
	Search,
	Settings,
	Sparkles,
	Tag,
	Upload,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AlbumArt } from "#/components/album-art.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { usePlayer } from "#/context/player-context.ts";
import { groupAlbums } from "#/lib/albums.ts";
import { listPlaylists, listTags, type Track, targetName } from "#/lib/api.ts";
import { groupArtists } from "#/lib/artists.ts";
import { type PaletteItem, rankMatches } from "#/lib/command-palette.ts";
import { useExitGhost } from "#/lib/exit-ghost.ts";
import { onOpenPalette } from "#/lib/open-palette.ts";
import { DIALOG_BACKDROP, DIALOG_FRAME } from "#/lib/page-layout.ts";
import { keyLabel } from "#/lib/platform.ts";
import { useScan, useSyncTargets, useTracks } from "#/lib/queries.ts";
import { useShortcut } from "#/lib/use-shortcuts.ts";
import { useSmartPlaylists } from "#/lib/use-smart.ts";
import { cn } from "#/lib/utils.ts";

/** What choosing a result does. */
type Target =
	| { kind: "go"; run: () => void; icon: ReactNode }
	| { kind: "song"; track: Track }
	| { kind: "album"; key: string; coverTrackId: number }
	| { kind: "artist"; name: string };

interface Group {
	label: string;
	items: PaletteItem<Target>[];
}

/** How many of each kind show at once; typing more narrows them. */
const LIMITS = { pages: 6, actions: 4, places: 5, artists: 4, albums: 5, songs: 8 } as const;

const go = (run: () => void, icon: ReactNode): Target => ({ kind: "go", run, icon });

/** Every page, action, playlist, tag, destination, artist, album and song the palette can find. */
function usePaletteGroups(query: string): Group[] {
	const navigate = useNavigate();
	const tracks = useTracks().data;
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists }).data;
	const smart = useSmartPlaylists().data;
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags }).data;
	const targets = useSyncTargets().data;
	const scan = useScan();

	const all = useMemo(() => {
		const songs = tracks ?? [];
		const pages: PaletteItem<Target>[] = [
			{
				id: "page:/",
				label: "Library",
				detail: "Songs, albums and artists",
				value: go(() => void navigate({ to: "/" }), <Library />),
			},
			{
				id: "page:/files",
				label: "Files",
				detail: "The library folder",
				value: go(() => void navigate({ to: "/files" }), <FolderTree />),
			},
			{
				id: "page:/metadata",
				label: "Metadata",
				detail: "Artists, genres, labels and tags",
				value: go(() => void navigate({ to: "/metadata" }), <Database />),
			},
			{
				id: "page:/import",
				label: "Import",
				detail: "Downloads and iTunes",
				value: go(() => void navigate({ to: "/import" }), <Download />),
			},
			{
				id: "page:/export",
				label: "Export",
				detail: "Destinations and drives",
				value: go(() => void navigate({ to: "/export" }), <Upload />),
			},
			{
				id: "page:/settings",
				label: "Settings",
				detail: "Library folder, shared library, lookup",
				value: go(() => void navigate({ to: "/settings" }), <Settings />),
			},
		];
		const actions: PaletteItem<Target>[] = [
			{
				id: "action:rescan",
				label: "Rescan the library",
				detail: "Look for added, changed and removed files",
				value: go(() => scan.mutate("saved"), <RefreshCw />),
			},
			{
				id: "action:analyse",
				label: "BPM and key analysis",
				detail: "In Settings: progress, notation and failures",
				value: go(
					() => void navigate({ to: "/settings", search: { section: "analysis" } }),
					<AudioWaveform />,
				),
			},
			{
				id: "action:add-destination",
				label: "Add a destination",
				detail: "Tailscale folder, R2, USB",
				value: go(() => void navigate({ to: "/export/add", search: {} }), <Plus />),
			},
		];
		const places: PaletteItem<Target>[] = [
			...(playlists ?? []).map((p) => ({
				id: `playlist:${p.id}`,
				label: p.name,
				detail: "Playlist",
				value: go(
					() => void navigate({ to: "/playlists/$id", params: { id: String(p.id) } }),
					<ListMusic />,
				),
			})),
			...(smart ?? []).map((p) => ({
				id: `smart:${p.id}`,
				label: p.name,
				detail: "Smart playlist",
				value: go(
					() => void navigate({ to: "/smart/$id", params: { id: String(p.id) } }),
					<Sparkles />,
				),
			})),
			...(tags ?? []).map((t) => ({
				id: `tag:${t.name}`,
				label: t.name,
				detail: `Tag, ${t.trackCount} ${t.trackCount === 1 ? "song" : "songs"}`,
				value: go(() => void navigate({ to: "/tags/$", params: { _splat: t.name } }), <Tag />),
			})),
			...(targets ?? []).map((t) => ({
				id: `target:${t.id}`,
				label: targetName(t),
				detail: "Destination",
				value: go(
					() => void navigate({ to: "/export/$targetId", params: { targetId: t.id } }),
					<Upload />,
				),
			})),
		];
		const artists = groupArtists(songs)
			.filter((a) => a.name !== "")
			.map((a) => ({
				id: `artist:${a.name}`,
				label: a.name,
				detail: `Artist, ${a.tracks.length} ${a.tracks.length === 1 ? "song" : "songs"}`,
				value: { kind: "artist", name: a.name } satisfies Target,
			}));
		const albums = groupAlbums(songs).map((a) => ({
			id: `album:${a.key}`,
			label: a.album || "Unknown album",
			detail: a.artist,
			value: { kind: "album", key: a.key, coverTrackId: a.coverTrackId } satisfies Target,
		}));
		const songItems = songs.map((t) => ({
			id: `song:${t.id}`,
			label: t.title,
			detail: [t.artist, t.album].filter((s) => s !== "").join(", "),
			value: { kind: "song", track: t } satisfies Target,
		}));
		return { pages, actions, places, artists, albums, songs: songItems };
	}, [tracks, playlists, smart, tags, targets, navigate, scan]);

	return useMemo(() => {
		const q = query.trim();
		// Before typing: where to go and what to do. Typing searches the whole library too.
		const groups: Group[] = [
			{ label: "Pages", items: rankMatches(all.pages, q, LIMITS.pages) },
			{ label: "Actions", items: rankMatches(all.actions, q, LIMITS.actions) },
		];
		if (q !== "") {
			groups.push(
				{
					label: "Playlists, tags and destinations",
					items: rankMatches(all.places, q, LIMITS.places),
				},
				{ label: "Artists", items: rankMatches(all.artists, q, LIMITS.artists) },
				{ label: "Albums", items: rankMatches(all.albums, q, LIMITS.albums) },
				{ label: "Songs", items: rankMatches(all.songs, q, LIMITS.songs) },
			);
		}
		return groups.filter((g) => g.items.length > 0);
	}, [all, query]);
}

function ResultIcon({ target }: { target: Target }) {
	switch (target.kind) {
		case "go":
			return (
				<span className="grid size-7 place-items-center text-muted-foreground">{target.icon}</span>
			);
		case "song":
			return <AlbumArt trackId={target.track.id} className="size-7 rounded" />;
		case "album":
			return <AlbumArt trackId={target.coverTrackId} className="size-7 rounded" />;
		case "artist":
			return (
				<span className="grid size-7 place-items-center rounded-full bg-foreground/[0.06] text-muted-foreground">
					<Mic2 />
				</span>
			);
	}
}

/** What Enter does to a result, shown at its right end while it is highlighted. */
const VERB: Record<Target["kind"], string> = {
	go: "Open",
	song: "Play",
	album: "Show",
	artist: "Show",
};

/**
 * ⌘K from anywhere: one search over pages, actions, playlists, tags, destinations, artists,
 * albums and songs. Enter opens a page, runs an action, plays a song or shows an album or artist.
 */
export function CommandPalette() {
	const overlay = useExitGhost();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const groups = usePaletteGroups(query);
	const detail = useDetail();
	const player = usePlayer();

	useShortcut("palette", () => setOpen((o) => !o));
	useEffect(() => onOpenPalette(() => setOpen(true)), []);

	useEffect(() => {
		if (!open) {
			setQuery("");
		}
	}, [open]);

	if (!open) {
		return null;
	}
	const byId = new Map(groups.flatMap((g) => g.items.map((i) => [i.id, i.value] as const)));
	const run = (id: string) => {
		const target = byId.get(id);
		if (!target) {
			return;
		}
		setOpen(false);
		if (target.kind === "go") {
			target.run();
		} else if (target.kind === "song") {
			player.play([target.track], 0);
		} else if (target.kind === "album") {
			detail.open({ kind: "album", key: target.key });
		} else {
			detail.open({ kind: "artist", name: target.name });
		}
	};

	return (
		<div ref={overlay} className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
			<div aria-hidden="true" className={DIALOG_BACKDROP} onMouseDown={() => setOpen(false)} />
			<div
				role="dialog"
				data-exit
				aria-label="Search everything"
				className={cn(DIALOG_FRAME, "w-[36rem] max-w-[calc(100%-2rem)] p-1")}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						setOpen(false);
					}
				}}
			>
				<Command
					query={query}
					onQueryChange={(q) => setQuery(q)}
					filter={false}
					onAction={run}
					className="flex flex-col"
				>
					<div className="flex h-11 items-center gap-2 px-3">
						<Search className="size-4 shrink-0 text-muted-foreground" />
						<CommandInput
							autoFocus
							aria-label="Search everything"
							placeholder="Search songs, albums, artists, playlists, pages…"
							className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
						/>
						<kbd className="shrink-0 rounded border border-hairline px-1.5 text-[11px] text-muted-foreground/70">
							esc
						</kbd>
					</div>
					<div className="max-h-[min(28rem,60vh)] overflow-y-auto rounded-xl border border-hairline bg-well p-1 empty:hidden">
						<CommandList className="outline-none">
							{groups.map((g) => (
								<CommandGroup key={g.label} className="py-1">
									<CommandGroupLabel className="px-2.5 pt-1.5 pb-1 font-medium text-muted-foreground/70 text-xs">
										{g.label}
									</CommandGroupLabel>
									{g.items.map((item) => (
										<CommandItem
											key={item.id}
											value={item.id}
											label={item.label}
											className="group flex cursor-default items-center gap-3 rounded-lg px-2 py-1.5 text-sm outline-none transition-colors data-highlighted:bg-foreground/[0.06] [&_svg]:size-4"
										>
											<ResultIcon target={item.value} />
											<span className="min-w-0 flex-1">
												<span className="block truncate">{item.label}</span>
												{item.detail !== "" && (
													<span className="block truncate text-muted-foreground text-xs">
														{item.detail}
													</span>
												)}
											</span>
											<span className="shrink-0 text-muted-foreground text-xs opacity-0 group-data-highlighted:opacity-100">
												{VERB[item.value.kind]} ↵
											</span>
										</CommandItem>
									))}
								</CommandGroup>
							))}
						</CommandList>
						<CommandEmpty className="flex items-center justify-center gap-2 px-3 py-8 text-muted-foreground text-sm">
							<Music className="size-4" />
							Nothing matches “{query.trim()}”
						</CommandEmpty>
					</div>
					<p className="flex items-center gap-3 px-3 pt-2 pb-1 text-muted-foreground/70 text-xs">
						<span>↑↓ to move, ↵ to choose</span>
						<span className="ml-auto">{keyLabel("⌘F")} searches this page</span>
					</p>
				</Command>
			</div>
		</div>
	);
}
