import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type PlayerApi, PlayerContext } from "#/context/player-context.ts";
import { audioUrl, type Track } from "#/lib/api.ts";

const RESTART_THRESHOLD_SECONDS = 3;

function describeError(e: unknown): string | null {
	// Starting a new track aborts the previous play() promise; that is not an error.
	if (e instanceof DOMException && e.name === "AbortError") {
		return null;
	}
	return e instanceof Error ? e.message : String(e);
}

export function PlayerProvider({ children }: { children: ReactNode }) {
	const audioRef = useRef<HTMLAudioElement>(null);
	const [queue, setQueue] = useState<readonly Track[]>([]);
	const [index, setIndex] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [time, setTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const [volume, setVolumeState] = useState(0.9);
	const [error, setError] = useState<string | null>(null);

	const current = queue[index] ?? null;
	const currentPath = current?.path ?? null;

	const start = useCallback(() => {
		audioRef.current?.play().catch((e: unknown) => setError(describeError(e)));
	}, []);

	useEffect(() => {
		const audio = audioRef.current;
		if (audio === null || currentPath === null) {
			return;
		}
		setError(null);
		audio.src = audioUrl(currentPath);
		start();
	}, [currentPath, start]);

	useEffect(() => {
		if (audioRef.current) {
			audioRef.current.volume = volume;
		}
	}, [volume]);

	const play = useCallback(
		(nextQueue: readonly Track[], startIndex: number) => {
			const target = nextQueue[startIndex];
			if (target === undefined) {
				return;
			}
			setQueue(nextQueue);
			setIndex(startIndex);
			// Same file again: the src effect will not fire, so restart it by hand.
			if (audioRef.current && target.path === currentPath) {
				audioRef.current.currentTime = 0;
				start();
			}
		},
		[currentPath, start],
	);

	const toggle = useCallback(() => {
		const audio = audioRef.current;
		if (audio === null || currentPath === null) {
			return;
		}
		if (audio.paused) {
			start();
		} else {
			audio.pause();
		}
	}, [currentPath, start]);

	const next = useCallback(() => {
		setIndex((i) => (i + 1 < queue.length ? i + 1 : i));
	}, [queue.length]);

	const prev = useCallback(() => {
		const audio = audioRef.current;
		if (audio && audio.currentTime > RESTART_THRESHOLD_SECONDS) {
			audio.currentTime = 0;
			return;
		}
		setIndex((i) => Math.max(0, i - 1));
	}, []);

	const seek = useCallback((seconds: number) => {
		if (audioRef.current) {
			audioRef.current.currentTime = seconds;
		}
	}, []);

	const onEnded = useCallback(() => {
		if (index + 1 < queue.length) {
			setIndex(index + 1);
		} else {
			setPlaying(false);
		}
	}, [index, queue.length]);

	const value = useMemo<PlayerApi>(
		() => ({
			current,
			queue,
			index,
			playing,
			time,
			duration,
			volume,
			error,
			play,
			toggle,
			next,
			prev,
			seek,
			setVolume: setVolumeState,
		}),
		[current, queue, index, playing, time, duration, volume, error, play, toggle, next, prev, seek],
	);

	return (
		<PlayerContext.Provider value={value}>
			{children}
			{/* biome-ignore lint/a11y/useMediaCaption: music playback has no captions */}
			<audio
				ref={audioRef}
				onPlay={() => setPlaying(true)}
				onPause={() => setPlaying(false)}
				onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
				onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
				onEnded={onEnded}
				onError={() => setError("Could not play this file")}
			/>
		</PlayerContext.Provider>
	);
}
