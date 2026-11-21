import { useEffect, useRef } from "react";
import { type Beat, beatsBetween, type Grid } from "#/lib/beat-grid.ts";
import { createSmoothClock, tick } from "#/lib/smooth-clock.ts";

/** How far ahead clicks are put in the audio queue, in seconds. */
const LOOKAHEAD = 0.15;
/** How often more clicks are queued, in ms; well inside the lookahead. */
const INTERVAL_MS = 25;
/** A jump of the position further than this (a seek, a pause) drops the clicks queued. */
const JUMP = 0.3;
const CLICK_SECONDS = 0.03;
const DOWNBEAT_HZ = 1760;
const BEAT_HZ = 1175;

function click(ctx: AudioContext, when: number, downbeat: boolean, volume: number) {
	const tone = ctx.createOscillator();
	const envelope = ctx.createGain();
	tone.frequency.value = downbeat ? DOWNBEAT_HZ : BEAT_HZ;
	envelope.gain.setValueAtTime(volume, when);
	envelope.gain.exponentialRampToValueAtTime(0.0001, when + CLICK_SECONDS);
	tone.connect(envelope).connect(ctx.destination);
	tone.start(when);
	tone.stop(when + CLICK_SECONDS);
}

/**
 * The beats to queue clicks for when the song is at `now`, given clicks are queued up to
 * `queuedTo`. After a jump (a seek) the clicks start from where the song is, not where it was.
 */
export function beatsToQueue(
	grid: Grid,
	queuedTo: number,
	now: number,
): { beats: Beat[]; queuedTo: number } {
	const from = now < queuedTo - LOOKAHEAD - JUMP || now > queuedTo + JUMP ? now : queuedTo;
	const until = now + LOOKAHEAD;
	return {
		beats: beatsBetween(grid, Math.max(from, now), until),
		queuedTo: Math.max(from, until),
	};
}

/**
 * How long a sound queued on an audio context takes to be heard, as far as it reports: its own
 * processing plus the output device (Bluetooth headphones add a lot). Unreported parts count as 0.
 */
export function heardLatency(ctx: { baseLatency?: number; outputLatency?: number }): number {
	const part = (seconds: number | undefined) =>
		seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
	return part(ctx.baseLatency) + part(ctx.outputLatency);
}

/**
 * Clicks on every beat of the grid while the song plays, louder and higher on beat 1, so a grid
 * that drifts from the music is heard. The clicks are queued a little ahead on the audio clock,
 * against a smoothed reading of the song's position, so they land evenly. The song's position is
 * what is heard, so each click is queued earlier by the context's delay to the ears, plus
 * `earlierMs` for delay the device does not report.
 */
export function useMetronome({
	grid,
	position,
	playing,
	on,
	volume,
	earlierMs,
}: {
	grid: Grid;
	/** Seconds into the song right now. */
	position: () => number;
	playing: boolean;
	on: boolean;
	/** 0–1, the player's volume. */
	volume: number;
	/** How much earlier than the grid to play the clicks, in ms; negative plays them later. */
	earlierMs: number;
}) {
	// Read on each queueing pass, so edits to the grid are heard without starting over.
	const latest = useRef({ grid, position, volume, earlierMs });
	latest.current = { grid, position, volume, earlierMs };
	const context = useRef<AudioContext | null>(null);

	useEffect(() => {
		if (!(on && playing)) {
			return;
		}
		const ctx = context.current ?? new AudioContext();
		context.current = ctx;
		void ctx.resume();
		const clock = createSmoothClock(latest.current.position(), performance.now());
		let queuedTo = clock.shown;
		const queue = () => {
			// Where the song will be once a click queued now is heard.
			const now =
				tick(clock, latest.current.position(), performance.now(), true) +
				heardLatency(ctx) +
				latest.current.earlierMs / 1000;
			const next = beatsToQueue(latest.current.grid, queuedTo, now);
			queuedTo = next.queuedTo;
			const loudness = Math.max(0.0001, latest.current.volume);
			for (const beat of next.beats) {
				const when = ctx.currentTime + (beat.time - now);
				click(ctx, when, beat.downbeat, beat.downbeat ? loudness : loudness * 0.6);
			}
		};
		queue();
		const id = window.setInterval(queue, INTERVAL_MS);
		return () => window.clearInterval(id);
	}, [on, playing]);

	useEffect(
		() => () => {
			void context.current?.close();
			context.current = null;
		},
		[],
	);
}
