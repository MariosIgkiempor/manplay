import { useEffect, useRef, useState } from "react";
import type { TrackAnalysis } from "#/lib/api.ts";
import { drawDetail, drawOverview } from "#/lib/waveform-draw.ts";

/** Seconds shown either side of the playhead in the scrolling view, like a CDJ's zoom. */
const WINDOW = 4;

/** A canvas sized to its box in device pixels, redrawn by `draw` on every render. */
function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
	const ref = useRef<HTMLCanvasElement>(null);
	const [size, setSize] = useState({ w: 0, h: 0 });
	useEffect(() => {
		const canvas = ref.current;
		if (!canvas) {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			if (entry) {
				const dpr = window.devicePixelRatio || 1;
				setSize({
					w: Math.round(entry.contentRect.width * dpr),
					h: Math.round(entry.contentRect.height * dpr),
				});
			}
		});
		observer.observe(canvas);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		const canvas = ref.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx || size.w === 0) {
			return;
		}
		canvas.width = size.w;
		canvas.height = size.h;
		ctx.clearRect(0, 0, size.w, size.h);
		draw(ctx, size.w, size.h);
	});
	return ref;
}

/**
 * The player position, advanced every frame between the audio element's coarse time updates
 * so the scrolling waveform moves smoothly.
 */
function useSmoothTime(time: number, playing: boolean): number {
	const anchor = useRef({ time, at: performance.now() });
	const [now, setNow] = useState(time);
	useEffect(() => {
		anchor.current = { time, at: performance.now() };
		setNow(time);
	}, [time]);
	useEffect(() => {
		if (!playing) {
			return;
		}
		let frame = 0;
		const tick = () => {
			const { time: t, at } = anchor.current;
			setNow(t + (performance.now() - at) / 1000);
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [playing]);
	return now;
}

/** The whole track as a CDJ overview: played part bright, the rest dimmed. Click or drag to seek. */
export function WaveformSeek({
	analysis,
	time,
	duration,
	disabled,
	onSeek,
}: {
	analysis: TrackAnalysis;
	time: number;
	duration: number;
	disabled: boolean;
	onSeek: (seconds: number) => void;
}) {
	const length = duration > 0 ? duration : analysis.duration;
	const ref = useCanvas((ctx, w, h) => {
		drawOverview(ctx, w, h, analysis, length > 0 ? time / length : 0);
	});
	return (
		<div className="relative h-8 flex-1">
			<canvas ref={ref} className="pointer-events-none absolute inset-0 size-full" />
			<input
				type="range"
				aria-label="Seek"
				className="absolute inset-0 size-full cursor-pointer opacity-0"
				min={0}
				max={length > 0 ? length : 0}
				step={0.1}
				value={Math.min(time, length || 0)}
				disabled={disabled}
				onChange={(e) => onSeek(Number(e.target.value))}
			/>
		</div>
	);
}

/** The few seconds around the playhead with the beat grid, scrolling as the track plays. */
export function WaveformDetail({
	analysis,
	time,
	playing,
}: {
	analysis: TrackAnalysis;
	time: number;
	playing: boolean;
}) {
	const now = useSmoothTime(time, playing);
	const ref = useCanvas((ctx, w, h) => drawDetail(ctx, w, h, analysis, now, WINDOW));

	return (
		<canvas
			ref={ref}
			role="img"
			aria-label="Waveform and beat grid around the playhead"
			className="h-14 w-full bg-neutral-950"
		/>
	);
}
