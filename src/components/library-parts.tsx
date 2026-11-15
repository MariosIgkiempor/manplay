import { useIsMutating } from "@tanstack/react-query";
import { AudioWaveform, FolderOpen, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { AlbumGrid } from "#/components/album-grid.tsx";
import { ArtistGrid } from "#/components/artist-grid.tsx";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { Button } from "#/components/ui/button.tsx";
import type { View } from "#/components/view-toggle.tsx";
import type { groupAlbums } from "#/lib/albums.ts";
import { openAnalysisDrawer } from "#/lib/analysis-drawer.ts";
import type { Track } from "#/lib/api.ts";
import { groupArtists } from "#/lib/artists.ts";
import { ANALYSIS_KEY } from "#/lib/queries.ts";

export function LibraryList({
	view,
	albums,
	tracks,
	targetCount,
	onOpen,
	onOpenArtist,
}: {
	view: View;
	albums: ReturnType<typeof groupAlbums>;
	tracks: Track[];
	targetCount: number;
	onOpen: (albumKey: string) => void;
	onOpenArtist: (name: string) => void;
}) {
	const artists = useMemo(() => groupArtists(tracks), [tracks]);
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
		<SelectableTrackList tracks={tracks} showDuration />
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
					variant="ghost"
					size="icon"
					aria-label={scanning ? "Scanning…" : "Rescan library"}
					title={scanning ? "Scanning…" : "Rescan library"}
					className="text-primary hover:bg-primary/15 hover:text-primary"
					onClick={() => onScan("saved")}
					disabled={scanning}
				>
					<RefreshCw className={scanning ? "animate-spin" : ""} />
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
		<Button
			variant="ghost"
			size="icon"
			aria-label={title}
			title={title}
			className="text-primary hover:bg-primary/15 hover:text-primary"
			onClick={openAnalysisDrawer}
		>
			<AudioWaveform className={running ? "animate-pulse" : ""} />
		</Button>
	);
}
