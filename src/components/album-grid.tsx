import { Play } from "lucide-react";
import { AddToPlaylistMenu } from "#/components/add-to-playlist-menu.tsx";
import { AlbumArt } from "#/components/album-art.tsx";
import { ArtistLinks } from "#/components/artist-links.tsx";
import { SyncBadge } from "#/components/sync-badge.tsx";
import { usePlayer } from "#/context/player-context.ts";
import { type Album, syncState } from "#/lib/albums.ts";

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
			<div className="group min-w-0">
				<div className="relative">
					<button
						type="button"
						className="block w-full overflow-hidden rounded-lg border"
						onClick={onOpen}
						aria-label={`Open ${album.album}`}
					>
						<AlbumArt
							trackId={album.coverTrackId}
							className="w-full transition group-hover:scale-[1.03]"
						/>
					</button>
					<button
						type="button"
						aria-label={`Play ${album.album}`}
						className="absolute right-2 bottom-2 flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition focus-visible:opacity-100 group-hover:opacity-100"
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
	if (albums.length === 0) {
		return <p className="py-8 text-center text-muted-foreground text-sm">No albums.</p>;
	}
	return (
		<div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-x-4 gap-y-6">
			{albums.map((a) => (
				<AlbumTile key={a.key} album={a} targetCount={targetCount} onOpen={() => onOpen(a)} />
			))}
		</div>
	);
}
