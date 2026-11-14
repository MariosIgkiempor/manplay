import { useMemo } from "react";
import { AlbumGrid } from "#/components/album-grid.tsx";
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
		return <p className="text-muted-foreground text-sm">No tracks for this artist.</p>;
	}
	return (
		<div className="space-y-6">
			<PanelHeader
				title={name === "" ? "Unknown artist" : name}
				meta={`${albums.length} albums · ${artistTracks.length} tracks`}
				tracks={artistTracks}
			/>
			<section className="space-y-3">
				<h3 className="font-semibold">Albums</h3>
				<AlbumGrid
					albums={albums}
					targetCount={targets.data?.length ?? 0}
					onOpen={(a) => push({ kind: "album", key: a.key })}
				/>
			</section>
			<section className="space-y-3">
				<h3 className="font-semibold">Tracks</h3>
				<SelectableTrackList tracks={artistTracks} hideArtist showDuration />
			</section>
		</div>
	);
}
