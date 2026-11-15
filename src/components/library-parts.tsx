import { useIsMutating } from "@tanstack/react-query";
import { AudioWaveform, FolderOpen, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { AlbumGrid } from "#/components/album-grid.tsx";
import { ArtistGrid } from "#/components/artist-grid.tsx";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { SortMenu } from "#/components/sort-menu.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { Button } from "#/components/ui/button.tsx";
import type { View } from "#/components/view-toggle.tsx";
import type { groupAlbums } from "#/lib/albums.ts";
import { openAnalysisDrawer } from "#/lib/analysis-drawer.ts";
import type { Track } from "#/lib/api.ts";
import { groupArtists } from "#/lib/artists.ts";
import type { LibrarySorts } from "#/lib/library-sorts.ts";
import { ANALYSIS_KEY } from "#/lib/queries.ts";
import { ALBUM_SORTS, ARTIST_SORTS, SONG_SORTS, sortArtists } from "#/lib/sorting.ts";

/** The sort menu for whichever view the library shows. */
export function LibrarySortMenu({
	view,
	sorts,
	segment = false,
}: {
	view: View;
	sorts: LibrarySorts;
	/** Shown as the search bar's right-hand segment. */
	segment?: boolean;
}) {
	const className = segment
		? "h-full rounded-none rounded-r-[calc(var(--radius-lg)-1px)] px-2.5 text-sm"
		: undefined;
	if (view === "albums") {
		return (
			<SortMenu
				options={ALBUM_SORTS}
				value={sorts.albums}
				onChange={sorts.setAlbums}
				className={className}
			/>
		);
	}
	if (view === "artists") {
		return (
			<SortMenu
				options={ARTIST_SORTS}
				value={sorts.artists}
				onChange={sorts.setArtists}
				className={className}
			/>
		);
	}
	return (
		<SortMenu
			options={SONG_SORTS}
			value={sorts.songs}
			onChange={sorts.setSongs}
			className={className}
		/>
	);
}

export function LibraryList({
	view,
	albums,
	tracks,
	targetCount,
	sorts,
	onOpen,
	onOpenArtist,
}: {
	view: View;
	albums: ReturnType<typeof groupAlbums>;
	tracks: Track[];
	targetCount: number;
	sorts: LibrarySorts;
	onOpen: (albumKey: string) => void;
	onOpenArtist: (name: string) => void;
}) {
	const artists = useMemo(
		() => sortArtists(groupArtists(tracks), sorts.artists),
		[tracks, sorts.artists],
	);
	if (view === "artists") {
		return (
			<>
				<ArtistGrid artists={artists} onOpen={(a) => onOpenArtist(a.name)} />
				<StatusBar>
					<Stat label="Artists" value={artists.length} />
					<Stat label="Songs" value={tracks.length} />
				</StatusBar>
			</>
		);
	}
	return view === "albums" ? (
		<>
			<AlbumGrid albums={albums} targetCount={targetCount} onOpen={(a) => onOpen(a.key)} />
			<StatusBar>
				<Stat label="Albums" value={albums.length} />
				<Stat label="Songs" value={tracks.length} />
			</StatusBar>
		</>
	) : (
		<SelectableTrackList
			tracks={tracks}
			sort={sorts.songs}
			onSortChange={sorts.setSongs}
			hideSortMenu
		/>
	);
}

export function ScanButtons({
	hasRoot,
	scanning,
	onScan,
}: {
	hasRoot: boolean;
	scanning: boolean;
	onScan: (mode: "saved" | "pick") => void;
}) {
	return (
		<>
			{hasRoot && (
				<Button
					variant="outline"
					title="Look for added, changed and removed files"
					onClick={() => onScan("saved")}
					disabled={scanning}
				>
					<RefreshCw className={scanning ? "animate-spin" : ""} />
					{scanning ? "Scanning…" : "Rescan"}
				</Button>
			)}
			{!hasRoot && (
				<Button variant="outline" onClick={() => onScan("pick")} disabled={scanning}>
					<FolderOpen />
					Choose folder
				</Button>
			)}
		</>
	);
}

/** Opens the BPM and key analysis drawer; pulses while an analysis runs. */
export function AnalyzeButton({ tracks }: { tracks: readonly Track[] }) {
	const running = useIsMutating({ mutationKey: ANALYSIS_KEY }) > 0;
	const pending = tracks.filter((t) => !t.analyzed).length;
	const title = running
		? "BPM & key analysis (running)"
		: pending === 0
			? "BPM & key analysis"
			: `BPM & key analysis (${pending} ${pending === 1 ? "song" : "songs"} not analyzed yet)`;
	return (
		<Button variant="outline" title={title} onClick={openAnalysisDrawer}>
			<AudioWaveform className={running ? "animate-pulse" : ""} />
			BPM & key
			{pending > 0 && !running && (
				<span className="rounded-full bg-primary/15 px-1.5 text-primary text-xs tabular-nums">
					{pending}
				</span>
			)}
		</Button>
	);
}
