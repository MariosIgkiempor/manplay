import { Mic2 } from "lucide-react";
import { useMemo } from "react";
import { AlbumGrid } from "#/components/album-grid.tsx";
import { EmptyState, Section } from "#/components/page.tsx";
import { Cover } from "#/components/page-header.tsx";
import { PanelHeader } from "#/components/panel-header.tsx";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { groupAlbums } from "#/lib/albums.ts";
import { splitNames } from "#/lib/names.ts";
import { useSyncTargets, useTracks } from "#/lib/queries.ts";

export function ArtistPanel({ name }: { name: string }) {
	const { push } = useDetail();
	const tracks = useTracks();
	const targets = useSyncTargets();
	const artistTracks = useMemo(
		() => (tracks.data ?? []).filter((t) => splitNames(t.artist).includes(name)),
		[tracks.data, name],
	);
	const albums = useMemo(() => groupAlbums(artistTracks), [artistTracks]);

	if (artistTracks.length === 0) {
		return (
			<EmptyState title="No songs by this artist">
				The artist may have been renamed. Close this panel and open it again from the library.
			</EmptyState>
		);
	}
	return (
		<div className="space-y-6">
			<PanelHeader
				kind={
					<>
						<Mic2 /> Artist
					</>
				}
				title={name === "" ? "Unknown artist" : name}
				meta={
					<>
						<span>
							{albums.length} {albums.length === 1 ? "album" : "albums"}
						</span>
						<span>
							{artistTracks.length} {artistTracks.length === 1 ? "song" : "songs"}
						</span>
					</>
				}
				art={<Cover tracks={artistTracks} fallback={<Mic2 className="size-8" />} />}
				tracks={artistTracks}
			/>
			<Section title="Albums" count={albums.length}>
				<AlbumGrid
					albums={albums}
					targetCount={targets.data?.length ?? 0}
					onOpen={(a) => push({ kind: "album", key: a.key })}
				/>
			</Section>
			<Section title="Songs" count={artistTracks.length}>
				<SelectableTrackList tracks={artistTracks} hideArtist showDuration />
			</Section>
		</div>
	);
}
