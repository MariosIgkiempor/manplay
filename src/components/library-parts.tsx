import { FolderOpen, RefreshCw } from "lucide-react";
import { AlbumGrid } from "#/components/album-grid.tsx";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { Button } from "#/components/ui/button.tsx";
import type { View } from "#/components/view-toggle.tsx";
import type { groupAlbums } from "#/lib/albums.ts";
import type { Track } from "#/lib/api.ts";

export function LibraryList({
	view,
	albums,
	tracks,
	targetCount,
	onOpen,
}: {
	view: View;
	albums: ReturnType<typeof groupAlbums>;
	tracks: Track[];
	targetCount: number;
	onOpen: (albumKey: string) => void;
}) {
	return view === "albums" ? (
		<>
			<AlbumGrid albums={albums} targetCount={targetCount} onOpen={(a) => onOpen(a.key)} />
			<StatusBar>
				<Stat label="Albums" value={albums.length} />
				<Stat label="Songs" value={tracks.length} />
			</StatusBar>
		</>
	) : (
		<SelectableTrackList tracks={tracks} />
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
