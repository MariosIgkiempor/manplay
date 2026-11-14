import { TextCursorInput } from "lucide-react";
import { useMemo } from "react";
import { AlbumArt } from "#/components/album-art.tsx";
import { ArtistLinks } from "#/components/artist-links.tsx";
import { PanelHeader } from "#/components/panel-header.tsx";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { SyncBadge } from "#/components/sync-badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { groupAlbums, syncState } from "#/lib/albums.ts";
import { useSyncTargets, useTracks } from "#/lib/queries.ts";
import { tagTargetFor } from "#/lib/tag-target.ts";

export function AlbumPanel({ albumKey }: { albumKey: string }) {
	const tracks = useTracks();
	const targets = useSyncTargets();
	const { push } = useDetail();
	const album = useMemo(
		() => groupAlbums(tracks.data ?? []).find((a) => a.key === albumKey),
		[tracks.data, albumKey],
	);

	if (!album) {
		return <p className="text-muted-foreground text-sm">Album not found.</p>;
	}
	return (
		<div className="space-y-6">
			<PanelHeader
				title={album.album}
				subtitle={<ArtistLinks artist={album.artist} />}
				meta={
					<>
						{album.tracks.length} tracks
						<SyncBadge state={syncState(album.tracks, targets.data?.length ?? 0)} showLabel />
					</>
				}
				art={
					<AlbumArt
						trackId={album.coverTrackId}
						className="size-40 shrink-0 rounded-lg shadow-lg"
					/>
				}
				tracks={album.tracks}
			/>
			<Button
				variant="outline"
				size="sm"
				onClick={() => {
					const target = tagTargetFor(album.tracks);
					if (target) {
						push({ kind: "edit", target: { ...target, kind: "Album" }, fromAlbum: true });
					}
				}}
			>
				<TextCursorInput /> Edit album tags
			</Button>
			<SelectableTrackList tracks={album.tracks} hideArt hideArtist hideAlbum showDuration />
		</div>
	);
}
