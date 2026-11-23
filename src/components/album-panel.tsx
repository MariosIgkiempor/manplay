import { Disc3, ListMusic, TextCursorInput } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { AlbumArt } from "#/components/album-art.tsx";
import { ArtistLinks } from "#/components/artist-links.tsx";
import { CoverPicker } from "#/components/cover-picker.tsx";
import { EmptyState } from "#/components/page.tsx";
import { PANEL_ART, PanelHeader } from "#/components/panel-header.tsx";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { SyncBadge } from "#/components/sync-badge.tsx";
import { TagEditor } from "#/components/tag-editor.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { albumKey, groupAlbums, syncState } from "#/lib/albums.ts";
import { songFacts } from "#/lib/panel-facts.tsx";
import { usePanelTabs, useSyncTargets, useTracks } from "#/lib/queries.ts";
import { tagTargetFor } from "#/lib/tag-target.ts";

export function AlbumPanel({ albumKey: key }: { albumKey: string }) {
	const tracks = useTracks();
	const targets = useSyncTargets();
	const { replace } = useDetail();
	const { tabs, setTab } = usePanelTabs();
	const album = useMemo(
		() => groupAlbums(tracks.data ?? []).find((a) => a.key === key),
		[tracks.data, key],
	);
	const paths = useMemo(() => album?.tracks.map((t) => t.path) ?? [], [album]);
	const target = useMemo(() => {
		const t = tagTargetFor(album?.tracks ?? []);
		return t && { ...t, kind: "Album" };
	}, [album]);

	// Saving a new album or artist name changes the album's key: follow its songs to the new one.
	const lastPaths = useRef<readonly string[]>([]);
	if (album) {
		lastPaths.current = paths;
	}
	useEffect(() => {
		if (album || !tracks.data) {
			return;
		}
		const moved = tracks.data.find((t) => lastPaths.current.includes(t.path));
		if (moved) {
			replace({ kind: "album", key: albumKey(moved.artist, moved.album) });
		}
	}, [album, tracks.data, replace]);

	if (!album) {
		return <EmptyState title={tracks.isPending ? "Loading album…" : "Album not found"} />;
	}
	return (
		<div className="space-y-6 pb-8">
			<PanelHeader
				kind={
					<>
						<Disc3 /> Album
					</>
				}
				title={album.album}
				subtitle={<ArtistLinks artist={album.artist} icon />}
				badge={<SyncBadge state={syncState(album.tracks, targets.data?.length ?? 0)} showLabel />}
				facts={songFacts(album.tracks)}
				art={
					<CoverPicker paths={paths} name={album.album}>
						<AlbumArt trackId={album.coverTrackId} className={PANEL_ART} />
					</CoverPicker>
				}
				tracks={album.tracks}
				tabs={
					<Segmented
						ruled={false}
						value={tabs.album}
						onChange={(v) => setTab("album", v)}
						label="Album view"
						items={[
							{ value: "songs", label: "Songs", icon: <ListMusic /> },
							{ value: "metadata", label: "Metadata", icon: <TextCursorInput /> },
						]}
					/>
				}
			/>
			{tabs.album === "songs" ? (
				<SelectableTrackList
					tracks={album.tracks}
					listOrder="Album order"
					hideArt
					hideArtist
					hideAlbum
				/>
			) : (
				target && <TagEditor key={paths.join("\n")} target={target} embedded />
			)}
		</div>
	);
}
