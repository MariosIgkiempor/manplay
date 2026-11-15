import { type PointerEvent, useCallback, useEffect, useRef } from "react";
import type { TrackAnalysis } from "#/lib/api.ts";
import type { Cue } from "#/lib/cues.ts";
import { type SmoothClock, tick } from "#/lib/smooth-clock.ts";
import { cn } from "#/lib/utils.ts";
import { drawDetail, drawOverview } from "#/lib/waveform-draw.ts";

/** Seconds shown either side of the playhead in the scrolling view, like a CDJ's zoom. */
const WINDOW = 4;

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

/**
 * A canvas kept at its box's size in device pixels. `paint` draws into it; the backing store is
 * only resized (which clears and reallocates it) when the box changes size.
 */
function useCanvas() {
	const ref = useRef<HTMLCanvasElement>(null);
	const last = useRef<Draw | null>(null);
	const paint = useCallback((draw: Draw) => {
		last.current = draw;
		const canvas = ref.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) {
			return;
		}
		const dpr = window.devicePixelRatio || 1;
		const w = Math.round(canvas.clientWidth * dpr);
		const h = Math.round(canvas.clientHeight * dpr);
		if (w === 0 || h === 0) {
			return;
		}
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		ctx.clearRect(0, 0, w, h);
		draw(ctx, w, h);
	}, []);
	useEffect(() => {
		const canvas = ref.current;
		if (!canvas) {
			return;
		}
		const observer = new ResizeObserver(() => last.current && paint(last.current));
		observer.observe(canvas);
		return () => observer.disconnect();
	}, [paint]);
	return { ref, paint };
}

/** The whole track as a CDJ overview: played part bright, the rest dimmed. Click or drag to seek. */
export function WaveformSeek({
	analysis,
	time,
	duration,
	disabled,
	onSeek,
	cues,
	className,
}: {
	analysis: TrackAnalysis;
	time: number;
	duration: number;
	disabled: boolean;
	onSeek: (seconds: number) => void;
	cues?: readonly Cue[];
	className?: string;
}) {
	const length = duration > 0 ? duration : analysis.duration;
	const { ref, paint } = useCanvas();
	useEffect(() => {
		paint((ctx, w, h) => drawOverview(ctx, w, h, analysis, length > 0 ? time / length : 0, cues));
	}, [paint, analysis, time, length, cues]);
	return (
		<div className={cn("relative h-8 flex-1", className)}>
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

/**
 * The few seconds around a position with the beat grid, CDJ style. While `running` it redraws
 * every frame from `position`, smoothed so it glides; otherwise whenever its inputs change.
 * With `onScrub`, dragging moves the position (left drags later, like moving a record).
 */
export function WaveformDetail({
	analysis,
	position,
	running,
	window = WINDOW,
	onScrub,
	revision,
	cues,
	className,
}: {
	analysis: TrackAnalysis;
	/** Seconds; read every frame. */
	position: () => number;
	running: boolean;
	/** Seconds shown either side of the centre. */
	window?: number;
	onScrub?: (seconds: number) => void;
	/** Anything that changes when a still picture should be redrawn, e.g. a seek while paused. */
	revision?: unknown;
	cues?: readonly Cue[];
	className?: string;
}) {
	const { ref, paint } = useCanvas();
	const clock = useRef<SmoothClock>({ shown: position(), at: performance.now() });
	const drag = useRef<{ x: number; from: number } | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `revision` only asks for a redraw
	useEffect(() => {
		const frame = () => {
			const now = tick(clock.current, position(), performance.now(), running);
			paint((ctx, w, h) => drawDetail(ctx, w, h, analysis, now, window, cues));
		};
		frame();
		if (!running) {
			return;
		}
		let id = requestAnimationFrame(function loop() {
			frame();
			id = requestAnimationFrame(loop);
		});
		return () => cancelAnimationFrame(id);
	}, [paint, analysis, position, running, window, revision, cues]);

	const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
		if (!onScrub) {
			return;
		}
		e.currentTarget.setPointerCapture(e.pointerId);
		drag.current = { x: e.clientX, from: position() };
	};
	const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
		const d = drag.current;
		if (!(d && onScrub)) {
			return;
		}
		const perPixel = (2 * window) / e.currentTarget.clientWidth;
		onScrub(Math.max(0, Math.min(analysis.duration, d.from - (e.clientX - d.x) * perPixel)));
	};

	return (
		<canvas
			ref={ref}
			role="img"
			aria-label="Waveform and beat grid"
			className={cn(
				"h-14 w-full bg-neutral-950",
				onScrub && "cursor-grab active:cursor-grabbing",
				className,
			)}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={() => {
				drag.current = null;
			}}
		/>
	);
}
