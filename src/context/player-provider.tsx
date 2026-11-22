import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type PlayerApi, PlayerContext, PlayerTimeContext } from "#/context/player-context.ts";
import { playableUrl, type Track } from "#/lib/api.ts";
import { withAdded, withNext } from "#/lib/queue.ts";

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
		let stale = false;
		playableUrl(currentPath)
			.then((src) => {
				if (!stale) {
					audio.src = src;
					start();
				}
			})
			.catch((e: unknown) => {
				if (!stale) {
					setError(describeError(e));
				}
			});
		return () => {
			stale = true;
		};
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

	const playNext = useCallback(
		(songs: readonly Track[]) => {
			if (current === null) {
				play(songs, 0);
			} else {
				setQueue((q) => withNext(q, index, songs));
			}
		},
		[current, index, play],
	);

	const addToQueue = useCallback(
		(songs: readonly Track[]) => {
			if (current === null) {
				play(songs, 0);
			} else {
				setQueue((q) => withAdded(q, index, songs));
			}
		},
		[current, index, play],
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

	const getTime = useCallback(() => audioRef.current?.currentTime ?? 0, []);

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
			duration,
			volume,
			error,
			play,
			playNext,
			addToQueue,
			toggle,
			next,
			prev,
			seek,
			getTime,
			setVolume: setVolumeState,
		}),
		[
			current,
			queue,
			index,
			playing,
			duration,
			volume,
			error,
			play,
			playNext,
			addToQueue,
			toggle,
			next,
			prev,
			seek,
			getTime,
		],
	);

	return (
		<PlayerContext.Provider value={value}>
			<PlayerTimeContext.Provider value={time}>{children}</PlayerTimeContext.Provider>
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
