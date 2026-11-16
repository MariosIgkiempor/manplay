import { useMemo } from "react";
import { usePlayer } from "#/context/player-context.ts";
import type { Track } from "#/lib/api.ts";
import { isAudioName } from "#/lib/fs-path.ts";
import { useTracks } from "#/lib/queries.ts";
import type { TreeRow } from "#/lib/tree.ts";

/** A stand-in for a file the library has not scanned yet, named after the file. */
function looseTrack(row: TreeRow): Track {
	const dot = row.entry.name.lastIndexOf(".");
	return {
		id: -1,
		path: row.path,
		artist: "",
		album: "",
		title: dot > 0 ? row.entry.name.slice(0, dot) : row.entry.name,
		size: row.entry.size,
		tags: [],
		syncedCount: 0,
		fields: {},
		durationMs: null,
		bitrate: null,
		sampleRate: null,
		bpm: null,
		key: null,
		analyzed: false,
		edited: { bpm: false, key: false, grid: false },
	};
}

/**
 * Plays songs straight from the file browser. The queue is the songs shown in the pane, in the
 * order shown, so next and previous walk the folder.
 */
export function useFilePlay() {
	const player = usePlayer();
	const tracks = useTracks();
	const byPath = useMemo(() => new Map((tracks.data ?? []).map((t) => [t.path, t])), [tracks.data]);
	const current = player.current?.path ?? null;
	return {
		/** Path of the song the player has loaded, if any. */
		current,
		playing: player.playing,
		/** Plays `path`, or pauses / resumes it when it is already the one loaded. */
		toggle: (rows: readonly TreeRow[], path: string) => {
			if (current === path) {
				player.toggle();
				return;
			}
			const songs = rows.filter((r) => !r.entry.isDir && isAudioName(r.entry.name));
			const index = songs.findIndex((r) => r.path === path);
			if (index === -1) {
				return;
			}
			player.play(
				songs.map((r) => byPath.get(r.path) ?? looseTrack(r)),
				index,
			);
		},
	};
}
