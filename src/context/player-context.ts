import { createContext, useContext } from "react";
import type { Track } from "#/lib/api.ts";

export interface PlayerApi {
	current: Track | null;
	queue: readonly Track[];
	index: number;
	playing: boolean;
	duration: number;
	volume: number;
	error: string | null;
	/** Replace the queue and start playing `queue[index]`. */
	play: (queue: readonly Track[], index: number) => void;
	/** Load `queue[index]` without playing it, e.g. to edit its grid; a song already loaded stays. */
	load: (queue: readonly Track[], index: number) => void;
	/** Slot songs in right after the playing one; with nothing playing, play them. */
	playNext: (songs: readonly Track[]) => void;
	/** Add songs to the end of the queue; with nothing playing, play them. */
	addToQueue: (songs: readonly Track[]) => void;
	toggle: () => void;
	next: () => void;
	prev: () => void;
	seek: (seconds: number) => void;
	/** The audio element's position right now, finer than {@link usePlayerTime}. */
	getTime: () => number;
	setVolume: (volume: number) => void;
}

export const PlayerContext = createContext<PlayerApi | null>(null);

/**
 * The position as the audio element reports it, a few times a second while it plays. It has a
 * context of its own so that only what shows the time is drawn again on each report, not every
 * list that asks the player which song is on.
 */
export const PlayerTimeContext = createContext(0);

/** Seconds into the playing song, updated a few times a second. */
export function usePlayerTime(): number {
	return useContext(PlayerTimeContext);
}

export function usePlayer(): PlayerApi {
	const ctx = useContext(PlayerContext);
	if (ctx === null) {
		throw new Error("usePlayer must be used inside <PlayerProvider>");
	}
	return ctx;
}
