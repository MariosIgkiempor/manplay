import { Play } from "lucide-react";
import { AddToPlaylistMenu } from "#/components/add-to-playlist-menu.tsx";
import { AlbumArt } from "#/components/album-art.tsx";
import { ArtistLinks } from "#/components/artist-links.tsx";
import { LoadMore } from "#/components/load-more.tsx";
import { EmptyState } from "#/components/page.tsx";
import { SyncBadge } from "#/components/sync-badge.tsx";
import { usePlayer } from "#/context/player-context.ts";
import { type Album, syncState } from "#/lib/albums.ts";
import { useProgressive } from "#/lib/use-progressive.ts";

interface Props {
	albums: readonly Album[];
	targetCount: number;
	onOpen: (album: Album) => void;
}

function AlbumTile({
	album,
	targetCount,
	onOpen,
}: {
	album: Album;
	targetCount: number;
	onOpen: () => void;
}) {
	const player = usePlayer();
	return (
		<AddToPlaylistMenu
			tracks={album.tracks}
			label={`${album.album} · ${album.tracks.length} songs`}
		>
			{/* Lifts a little under the pointer; the cover grows inside its frame and Play rises in. */}
			<div className="group min-w-0">
				<div className="relative transition-transform duration-200 ease-out group-hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0">
					<button
						type="button"
						className="block w-full overflow-hidden rounded-lg border border-hairline shadow-black/40 shadow-sm outline-none transition-[box-shadow,scale] duration-200 ease-out focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-[0.98] group-hover:shadow-xl motion-reduce:transition-none"
						onClick={onOpen}
						onDoubleClick={() => player.play(album.tracks, 0)}
						aria-label={`Open ${album.album}`}
						title="Click to open, double-click to play"
					>
						<AlbumArt
							trackId={album.coverTrackId}
							className="w-full transition-[scale] duration-500 ease-out group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
						/>
					</button>
					<button
						type="button"
						aria-label={`Play ${album.album}`}
						className="absolute right-2 bottom-2 flex size-10 translate-y-1.5 scale-90 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition duration-200 ease-out hover:scale-105 focus-visible:translate-y-0 focus-visible:scale-100 focus-visible:opacity-100 active:scale-95 group-hover:translate-y-0 group-hover:scale-100 group-hover:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-none"
						onClick={() => player.play(album.tracks, 0)}
					>
						<Play className="size-5" />
					</button>
				</div>
				<div className="mt-2 flex items-start justify-between gap-2">
					<div className="min-w-0">
						<button
							type="button"
							className="block max-w-full truncate text-left font-medium text-sm hover:underline"
							title={album.album}
							onClick={onOpen}
						>
							{album.album}
						</button>
						<div className="truncate text-muted-foreground text-xs">
							<ArtistLinks artist={album.artist} />
						</div>
					</div>
					<SyncBadge state={syncState(album.tracks, targetCount)} />
				</div>
			</div>
		</AddToPlaylistMenu>
	);
}

export function AlbumGrid({ albums, targetCount, onOpen }: Props) {
	const { shown, more, loadMore } = useProgressive(albums, (a) => a.key);
	if (albums.length === 0) {
		return <EmptyState title="No albums">Clear the search to see everything.</EmptyState>;
	}
	return (
		<>
			<div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-x-4 gap-y-6">
				{shown.map((a) => (
					<AlbumTile key={a.key} album={a} targetCount={targetCount} onOpen={() => onOpen(a)} />
				))}
			</div>
			<LoadMore more={more} onMore={loadMore} />
		</>
	);
}
