import { Disc3, TextCursorInput } from "lucide-react";
import { useMemo } from "react";
import { AlbumArt } from "#/components/album-art.tsx";
import { ArtistLinks } from "#/components/artist-links.tsx";
import { EmptyState } from "#/components/page.tsx";
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
		return <EmptyState title="Album not found" />;
	}
	return (
		<div className="space-y-6">
			<PanelHeader
				kind={
					<>
						<Disc3 /> Album
					</>
				}
				title={album.album}
				subtitle={<ArtistLinks artist={album.artist} />}
				meta={
					<>
						<span>
							{album.tracks.length} {album.tracks.length === 1 ? "song" : "songs"}
						</span>
						<SyncBadge state={syncState(album.tracks, targets.data?.length ?? 0)} showLabel />
					</>
				}
				art={
					<AlbumArt
						trackId={album.coverTrackId}
						className="size-36 shrink-0 rounded-lg shadow-lg ring-1 ring-foreground/10"
					/>
				}
				tracks={album.tracks}
				actions={
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
						<TextCursorInput /> Edit metadata
					</Button>
				}
			/>
			<SelectableTrackList tracks={album.tracks} hideArt hideArtist hideAlbum showDuration />
		</div>
	);
}
