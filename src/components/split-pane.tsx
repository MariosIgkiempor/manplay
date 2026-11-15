import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useState } from "react";
import { AlbumPanel } from "#/components/album-panel.tsx";
import { ArtistPanel } from "#/components/artist-panel.tsx";
import { PanelBar } from "#/components/panel-header.tsx";
import { SongPanel } from "#/components/song-panel.tsx";
import {
	PanelScopeContext,
	SplitScopeContext,
	type SplitView,
	useDetail,
} from "#/context/detail-context.ts";
import { StatusScopeContext, useStatusScopeHandlers } from "#/context/status-context.ts";

function Content({ view }: { view: SplitView }) {
	switch (view.kind) {
		case "song":
			return <SongPanel trackId={view.trackId} requested={view.tab} list={view.list} />;
		case "album":
			return <AlbumPanel albumKey={view.key} />;
		case "artist":
			return <ArtistPanel name={view.name} />;
	}
}

/** Swapping song, album or artist keeps the pane's scroll at the top. */
const viewKey = (v: SplitView) =>
	v.kind === "song"
		? `song:${v.trackId}`
		: v.kind === "album"
			? `album:${v.key}`
			: `artist:${v.name}`;

const WIDTH_KEY = "manplay.split-width";
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 340;
/** Leaves the page at least this much room. */
const PAGE_ROOM = 480;

const clampWidth = (w: number) =>
	Math.round(Math.max(MIN_WIDTH, Math.min(w, window.innerWidth - PAGE_ROOM)));

function savedWidth(): number {
	try {
		const n = Number(localStorage.getItem(WIDTH_KEY));
		return n > 0 ? n : DEFAULT_WIDTH;
	} catch {
		return DEFAULT_WIDTH;
	}
}

/** The split's width, dragged on its left edge and remembered between launches. */
function useSplitWidth() {
	const [width, setWidth] = useState(DEFAULT_WIDTH);
	useEffect(() => setWidth(savedWidth()), []);
	const set = (w: number) => {
		const next = clampWidth(w);
		setWidth(next);
		try {
			localStorage.setItem(WIDTH_KEY, String(next));
		} catch {
			// Not remembered; the width still applies now.
		}
	};
	return [width, set] as const;
}

/** Drag to resize, arrow keys to step, double-click for the default width. */
function ResizeHandle({ width, onWidth }: { width: number; onWidth: (w: number) => void }) {
	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = width;
		const el = e.currentTarget;
		el.setPointerCapture(e.pointerId);
		document.body.style.cursor = "col-resize";
		const move = (ev: globalThis.PointerEvent) => onWidth(startW + (startX - ev.clientX));
		const up = () => {
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
			el.removeEventListener("pointercancel", up);
			document.body.style.cursor = "";
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
		el.addEventListener("pointercancel", up);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const step = e.shiftKey ? 64 : 16;
		if (e.key === "ArrowLeft") {
			e.preventDefault();
			onWidth(width + step);
		} else if (e.key === "ArrowRight") {
			e.preventDefault();
			onWidth(width - step);
		}
	};
	return (
		// biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA pattern for a splitter
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize panel"
			aria-valuenow={width}
			aria-valuemin={MIN_WIDTH}
			tabIndex={0}
			title="Drag to resize, double-click to reset"
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
			onDoubleClick={() => onWidth(DEFAULT_WIDTH)}
			className="group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize outline-none"
		>
			<div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary group-active:bg-primary" />
		</div>
	);
}

/**
 * Right-hand split beside the page for one song, album or artist. The page stays usable next to it:
 * picking another song title swaps what the split shows.
 */
export function SplitPane(): ReactNode {
	const { split } = useDetail();
	const scopeHandlers = useStatusScopeHandlers("split");
	const [width, setWidth] = useSplitWidth();
	const { view } = split;
	const [scroller, setScroller] = useState<HTMLElement | null>(null);
	const key = view ? viewKey(view) : null;

	// A different song, album or artist starts at the top; switching a song's tab does not.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the shown thing changes
	useEffect(() => {
		scroller?.scrollTo({ top: 0 });
	}, [scroller, key]);

	if (!view) {
		return null;
	}
	return (
		<aside
			aria-label="Details"
			{...scopeHandlers}
			style={{ width }}
			className="relative flex max-w-[60%] shrink-0 flex-col border-l bg-background"
		>
			<ResizeHandle width={width} onWidth={setWidth} />
			<PanelBar
				canGoBack={split.canGoBack}
				onBack={split.back}
				onClose={split.close}
				closeLabel="Close"
			/>
			<div ref={setScroller} className="@container/split min-h-0 flex-1 overflow-y-auto px-5 pt-5">
				<PanelScopeContext.Provider value>
					<SplitScopeContext.Provider value>
						<StatusScopeContext.Provider value="split">
							<split.UnsavedScope>
								<Content view={view} />
							</split.UnsavedScope>
						</StatusScopeContext.Provider>
					</SplitScopeContext.Provider>
				</PanelScopeContext.Provider>
			</div>
		</aside>
	);
}
