import { useEffect, useRef } from "react";
import type { PlayerApi } from "#/context/player-context.ts";
import { artUrl } from "#/lib/api.ts";

/**
 * The keyboard's media keys, headphone buttons and the system's Now Playing controls (Control
 * Centre on a Mac, the media overlay on Windows) play, pause and step through the queue, and show
 * the playing song. Both webviews pass these to the page through the Media Session API.
 */
export function useMediaSession(player: PlayerApi) {
	const latest = useRef(player);
	latest.current = player;

	useEffect(() => {
		const session = typeof navigator === "undefined" ? undefined : navigator.mediaSession;
		if (!session) {
			return;
		}
		const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
			["play", () => latest.current.playing || latest.current.toggle()],
			["pause", () => latest.current.playing && latest.current.toggle()],
			["nexttrack", () => latest.current.next()],
			["previoustrack", () => latest.current.prev()],
			[
				"seekto",
				(details) => details.seekTime !== undefined && latest.current.seek(details.seekTime),
			],
		];
		for (const [action, handler] of handlers) {
			try {
				session.setActionHandler(action, handler);
			} catch {
				// This webview does not offer the action; the others still work.
			}
		}
		return () => {
			for (const [action] of handlers) {
				try {
					session.setActionHandler(action, null);
				} catch {
					// Never set.
				}
			}
		};
	}, []);

	const current = player.current;
	useEffect(() => {
		const session = typeof navigator === "undefined" ? undefined : navigator.mediaSession;
		if (!session || typeof MediaMetadata === "undefined") {
			return;
		}
		session.metadata =
			current === null
				? null
				: new MediaMetadata({
						title: current.title,
						artist: current.artist,
						album: current.album,
						artwork: [{ src: artUrl(current.id) }],
					});
	}, [current]);

	useEffect(() => {
		if (typeof navigator !== "undefined" && navigator.mediaSession) {
			navigator.mediaSession.playbackState =
				current === null ? "none" : player.playing ? "playing" : "paused";
		}
	}, [current, player.playing]);
}
