import { Play } from "lucide-react";
import { AddToPlaylistMenu } from "#/components/add-to-playlist-menu.tsx";
import { AlbumArt } from "#/components/album-art.tsx";
import { LoadMore } from "#/components/load-more.tsx";
import { EmptyState } from "#/components/page.tsx";
import { usePlayer } from "#/context/player-context.ts";
import type { Artist } from "#/lib/artists.ts";
import {
	GROW_CELL_ATTRIBUTE,
	GROW_FROM_ATTRIBUTE,
	GROW_OPENER_ATTRIBUTE,
} from "#/lib/grow-card.ts";
import { GRID_PAGE_SIZE, useProgressive } from "#/lib/use-progressive.ts";
import { GRID_ITEM_ATTRIBUTE, useTileGridKeys } from "#/lib/use-tile-grid-keys.ts";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function ArtistTile({ artist, onOpen }: { artist: Artist; onOpen: () => void }) {
	const player = usePlayer();
	const label = artist.name === "" ? "Unknown artist" : artist.name;
	return (
		<AddToPlaylistMenu
			tracks={artist.tracks}
			label={`${label} · ${plural(artist.tracks.length, "song", "songs")}`}
		>
			<div className="group min-w-0 text-center" {...{ [GROW_CELL_ATTRIBUTE]: "" }}>
				<div className="relative mx-auto w-full max-w-40">
					<button
						type="button"
						className="block w-full overflow-hidden rounded-full border"
						onClick={onOpen}
						aria-label={`Open ${label}`}
						{...{ [GRID_ITEM_ATTRIBUTE]: "" }}
					>
						<span className="block" {...{ [GROW_FROM_ATTRIBUTE]: "" }}>
							<AlbumArt
								trackId={artist.coverTrackId}
								className="w-full transition group-hover:scale-[1.03]"
							/>
						</span>
					</button>
					<button
						type="button"
						aria-label={`Play ${label}`}
						className="absolute right-1 bottom-1 flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition focus-visible:opacity-100 group-hover:opacity-100"
						onClick={() => player.play(artist.tracks, 0)}
					>
						<Play className="size-5" />
					</button>
				</div>
				<button
					type="button"
					className="mx-auto mt-2 block max-w-full truncate text-center font-medium text-sm hover:underline"
					data-hint={label}
					onClick={onOpen}
					{...{ [GROW_OPENER_ATTRIBUTE]: "" }}
				>
					{label}
				</button>
				<div className="truncate text-muted-foreground text-xs">
					{plural(artist.albumCount, "album", "albums")},{" "}
					{plural(artist.tracks.length, "song", "songs")}
				</div>
			</div>
		</AddToPlaylistMenu>
	);
}

export function ArtistGrid({
	artists,
	onOpen,
}: {
	artists: readonly Artist[];
	onOpen: (artist: Artist) => void;
}) {
	const { shown, more, loadMore } = useProgressive(artists, (a) => a.name, GRID_PAGE_SIZE);
	const keys = useTileGridKeys({ more, loadMore });
	if (artists.length === 0) {
		return (
			<EmptyState kind="search" title="No artists">
				Clear the search to see everything.
			</EmptyState>
		);
	}
	return (
		<>
			<div
				ref={keys.ref}
				{...keys.props}
				className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-x-4 gap-y-6"
			>
				{shown.map((a) => (
					<ArtistTile key={a.name} artist={a} onOpen={() => onOpen(a)} />
				))}
			</div>
			<LoadMore more={more} onMore={loadMore} />
		</>
	);
}
