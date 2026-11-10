import { ArrowLeft, Play } from "lucide-react";
import { AlbumArt } from "#/components/album-art.tsx";
import { SyncBadge } from "#/components/sync-badge.tsx";
import { TrackList } from "#/components/track-list.tsx";
import { Button } from "#/components/ui/button.tsx";
import { usePlayer } from "#/context/player-context.ts";
import { type Album, syncState } from "#/lib/albums.ts";
import type { Track } from "#/lib/api.ts";

interface Props {
	album: Album;
	targetCount: number;
	onBack: () => void;
	onRemoveTag: (track: Track, tag: string) => void;
}

export function AlbumDetail({ album, targetCount, onBack, onRemoveTag }: Props) {
	const player = usePlayer();
	return (
		<div className="space-y-6">
			<Button variant="ghost" size="sm" onClick={onBack}>
				<ArrowLeft /> All albums
			</Button>
			<div className="flex items-end gap-6">
				<AlbumArt trackId={album.coverTrackId} className="size-48 shrink-0 rounded-lg shadow-lg" />
				<div className="min-w-0 space-y-2">
					<h2 className="truncate font-bold text-3xl">{album.album}</h2>
					<p className="text-lg text-muted-foreground">{album.artist}</p>
					<p className="flex items-center gap-3 text-muted-foreground text-sm">
						{album.tracks.length} tracks
						<SyncBadge state={syncState(album.tracks, targetCount)} showLabel />
					</p>
					<Button onClick={() => player.play(album.tracks, 0)}>
						<Play /> Play
					</Button>
				</div>
			</div>
			<TrackList
				tracks={album.tracks}
				targetCount={targetCount}
				hideArt
				onRemoveTag={onRemoveTag}
			/>
		</div>
	);
}
