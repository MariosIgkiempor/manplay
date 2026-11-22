import type { PlayerApi } from "#/context/player-context.ts";
import type { Track } from "#/lib/api.ts";
import { setWaveformShown } from "#/lib/use-waveform-shown.ts";

/**
 * Puts a song on the deck to edit its grid and cues: loaded paused (the songs of `list` after it
 * queued), with the waveform shown. A song already loaded keeps playing.
 */
export function loadForEditing(
	player: PlayerApi,
	song: Track,
	list: readonly number[] | undefined,
	tracks: readonly Track[],
) {
	setWaveformShown(true);
	if (player.current?.id === song.id) {
		return;
	}
	const byId = new Map(tracks.map((t) => [t.id, t]));
	const queue = (list ?? []).flatMap((id) => byId.get(id) ?? []);
	const index = queue.findIndex((t) => t.id === song.id);
	if (index >= 0) {
		player.load(queue, index);
	} else {
		player.load([song], 0);
	}
}
