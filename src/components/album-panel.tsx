import { useMemo } from "react";
import { AlbumArt } from "#/components/album-art.tsx";
import { PanelHeader } from "#/components/panel-header.tsx";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { SyncBadge } from "#/components/sync-badge.tsx";
import { useDetailNav } from "#/context/detail-context.ts";
import { groupAlbums, syncState } from "#/lib/albums.ts";
import { useSyncTargets, useTracks } from "#/lib/queries.ts";

export function AlbumPanel({ albumKey }: { albumKey: string }) {
	const go = useDetailNav();
	const tracks = useTracks();
	const targets = useSyncTargets();
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
				subtitle={
					<button
						type="button"
						className="hover:underline"
						onClick={() => go({ kind: "artist", name: album.artist })}
					>
						{album.artist}
					</button>
				}
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
			<SelectableTrackList tracks={album.tracks} hideArt hideArtist hideAlbum showDuration />
		</div>
	);
}
