import { type PointerEvent, type RefObject, useCallback, useEffect, useRef } from "react";
import type { TrackAnalysis } from "#/lib/api.ts";
import type { Cue } from "#/lib/cues.ts";
import { createSmoothClock, type SmoothClock, tick } from "#/lib/smooth-clock.ts";
import { cn } from "#/lib/utils.ts";
import { drawDetail, drawOverview, renderOverview } from "#/lib/waveform-draw.ts";
import { clampZoom, wheelZoom } from "#/lib/waveform-zoom.ts";

/** Seconds shown either side of the playhead in the scrolling view, like a CDJ's zoom. */
const WINDOW = 4;

/** A canvas's size in device pixels, and how many of them make a CSS pixel. */
interface CanvasSize {
	w: number;
	h: number;
	scale: number;
}

type Draw = (ctx: CanvasRenderingContext2D, size: CanvasSize) => void;

/**
 * A canvas kept at its box's size in device pixels. `paint` draws into it. The box is measured
 * when it changes size, not on every paint: asking a canvas its size each frame makes the page
 * lay itself out each frame.
 */
function useCanvas() {
	const ref = useRef<HTMLCanvasElement>(null);
	const last = useRef<Draw | null>(null);
	const size = useRef<CanvasSize | null>(null);
	const paint = useCallback((draw: Draw) => {
		last.current = draw;
		const canvas = ref.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) {
			return;
		}
		size.current ??= measure(canvas);
		const { w, h } = size.current;
		if (w === 0 || h === 0) {
			return;
		}
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		ctx.clearRect(0, 0, w, h);
		draw(ctx, size.current);
	}, []);
	useEffect(() => {
		const canvas = ref.current;
		if (!canvas) {
			return;
		}
		const observer = new ResizeObserver(() => {
			size.current = measure(canvas);
			if (last.current) {
				paint(last.current);
			}
		});
		observer.observe(canvas);
		return () => observer.disconnect();
	}, [paint]);
	return { ref, paint };
}

function measure(canvas: HTMLCanvasElement): CanvasSize {
	const scale = window.devicePixelRatio || 1;
	return {
		w: Math.round(canvas.clientWidth * scale),
		h: Math.round(canvas.clientHeight * scale),
		scale,
	};
}

/**
 * Runs `frame` after every render (a render is how a new song, zoom, cue or position arrives),
 * and on every animation frame while `running`.
 */
function useFrames(frame: () => void, running: boolean) {
	const latest = useRef(frame);
	latest.current = frame;
	useEffect(() => {
		latest.current();
	});
	useEffect(() => {
		if (!running) {
			return;
		}
		let id = requestAnimationFrame(function loop() {
			latest.current();
			id = requestAnimationFrame(loop);
		});
		return () => cancelAnimationFrame(id);
	}, [running]);
}

/**
 * The whole track as a CDJ overview: played part bright, the rest dimmed. Click or drag to seek.
 * While `running` the playhead follows `position` every frame.
 */
export function WaveformSeek({
	analysis,
	position,
	running,
	duration,
	disabled,
	onSeek,
	cues,
	className,
}: {
	analysis: TrackAnalysis;
	/** Seconds; read every frame. */
	position: () => number;
	running: boolean;
	duration: number;
	disabled: boolean;
	onSeek: (seconds: number) => void;
	cues?: readonly Cue[];
	className?: string;
}) {
	const length = duration > 0 ? duration : analysis.duration;
	const { ref, paint } = useCanvas();
	const clock = useRef<SmoothClock>(createSmoothClock(position(), performance.now()));
	// The bars only change with the song or the size, so they are drawn once and copied.
	const bars = useRef<{ detail: readonly number[]; canvas: HTMLCanvasElement } | null>(null);
	useFrames(() => {
		const now = tick(clock.current, position(), performance.now(), running);
		paint((ctx, size) => {
			const kept = bars.current;
			const fresh =
				kept?.detail === analysis.detail &&
				kept.canvas.width === size.w &&
				kept.canvas.height === size.h
					? kept
					: { detail: analysis.detail, canvas: renderOverview(analysis, size.w, size.h) };
			bars.current = fresh;
			drawOverview(ctx, size, fresh.canvas, length > 0 ? now / length : 0, length, cues);
		});
	}, running);
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
				value={Math.min(position(), length || 0)}
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
/** WebKit's trackpad gesture event (pinch), which carries a cumulative `scale`. */
interface GestureEvent extends UIEvent {
	scale: number;
}

/**
 * Pinch-to-zoom on the canvas. WebKit (the macOS app) reports a pinch as gesture events with a
 * scale; Chromium-based webviews as a wheel event with ⌃ held. Both stop the page zooming too.
 */
function usePinch(
	ref: RefObject<HTMLCanvasElement | null>,
	onZoom: ((next: (window: number) => number) => void) | undefined,
) {
	const latest = useRef(onZoom);
	latest.current = onZoom;
	const enabled = onZoom !== undefined;
	useEffect(() => {
		const canvas = ref.current;
		if (!(canvas && enabled)) {
			return;
		}
		let last = 1;
		const onWheel = (e: WheelEvent) => {
			if (e.ctrlKey) {
				e.preventDefault();
				latest.current?.((w) => wheelZoom(w, e.deltaY));
			}
		};
		const onStart = (e: Event) => {
			e.preventDefault();
			last = 1;
		};
		const onChange = (e: Event) => {
			e.preventDefault();
			const scale = (e as GestureEvent).scale;
			if (scale > 0) {
				// Spreading the fingers (scale above 1) zooms in: a shorter window.
				const by = last / scale;
				last = scale;
				latest.current?.((w) => clampZoom(w * by));
			}
		};
		canvas.addEventListener("wheel", onWheel, { passive: false });
		canvas.addEventListener("gesturestart", onStart);
		canvas.addEventListener("gesturechange", onChange);
		return () => {
			canvas.removeEventListener("wheel", onWheel);
			canvas.removeEventListener("gesturestart", onStart);
			canvas.removeEventListener("gesturechange", onChange);
		};
	}, [ref, enabled]);
}

export function WaveformDetail({
	analysis,
	position,
	running,
	window = WINDOW,
	onScrub,
	cues,
	onZoom,
	className,
}: {
	analysis: TrackAnalysis;
	/** Seconds; read every frame. */
	position: () => number;
	running: boolean;
	/** Seconds shown either side of the centre. */
	window?: number;
	onScrub?: (seconds: number) => void;
	cues?: readonly Cue[];
	/**
	 * Pinching on a trackpad (or ⌃-scrolling): the new `window` from the old one. Without it the
	 * gesture is left to the page.
	 */
	onZoom?: (next: (window: number) => number) => void;
	className?: string;
}) {
	const { ref, paint } = useCanvas();
	usePinch(ref, onZoom);
	const clock = useRef<SmoothClock>(createSmoothClock(position(), performance.now()));
	const drag = useRef<{ x: number; from: number } | null>(null);
	useFrames(() => {
		const now = tick(clock.current, position(), performance.now(), running);
		paint((ctx, size) => drawDetail(ctx, size, analysis, now, window, cues));
	}, running);

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
