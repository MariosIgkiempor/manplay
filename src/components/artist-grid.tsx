import { Play } from "lucide-react";
import { AlbumArt } from "#/components/album-art.tsx";
import { EmptyState } from "#/components/page.tsx";
import { usePlayer } from "#/context/player-context.ts";
import type { Artist } from "#/lib/artists.ts";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function ArtistTile({ artist, onOpen }: { artist: Artist; onOpen: () => void }) {
	const player = usePlayer();
	const label = artist.name === "" ? "Unknown artist" : artist.name;
	return (
		<div className="group min-w-0 text-center">
			<div className="relative mx-auto w-full max-w-40">
				<button
					type="button"
					className="block w-full overflow-hidden rounded-full border"
					onClick={onOpen}
					aria-label={`Open ${label}`}
				>
					<AlbumArt
						trackId={artist.coverTrackId}
						className="w-full transition group-hover:scale-[1.03]"
					/>
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
				title={label}
				onClick={onOpen}
			>
				{label}
			</button>
			<div className="truncate text-muted-foreground text-xs">
				{plural(artist.albumCount, "album", "albums")},{" "}
				{plural(artist.tracks.length, "song", "songs")}
			</div>
		</div>
	);
}

export function ArtistGrid({
	artists,
	onOpen,
}: {
	artists: readonly Artist[];
	onOpen: (artist: Artist) => void;
}) {
	if (artists.length === 0) {
		return <EmptyState title="No artists">Clear the search to see everything.</EmptyState>;
	}
	return (
		<div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-x-4 gap-y-6">
			{artists.map((a) => (
				<ArtistTile key={a.name} artist={a} onOpen={() => onOpen(a)} />
			))}
		</div>
	);
}
