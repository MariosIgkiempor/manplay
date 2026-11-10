import { createContext, useContext } from "react";
import type { Track } from "#/lib/api.ts";

export interface PlayerApi {
	current: Track | null;
	queue: readonly Track[];
	index: number;
	playing: boolean;
	time: number;
	duration: number;
	volume: number;
	error: string | null;
	/** Replace the queue and start playing `queue[index]`. */
	play: (queue: readonly Track[], index: number) => void;
	toggle: () => void;
	next: () => void;
	prev: () => void;
	seek: (seconds: number) => void;
	setVolume: (volume: number) => void;
}

export const PlayerContext = createContext<PlayerApi | null>(null);

export function usePlayer(): PlayerApi {
	const ctx = useContext(PlayerContext);
	if (ctx === null) {
		throw new Error("usePlayer must be used inside <PlayerProvider>");
	}
	return ctx;
}
