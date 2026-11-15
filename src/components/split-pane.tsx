import { type ReactNode, useEffect, useState } from "react";
import { AlbumPanel } from "#/components/album-panel.tsx";
import { ArtistPanel } from "#/components/artist-panel.tsx";
import { PanelBar } from "#/components/panel-header.tsx";
import { ResizeHandle } from "#/components/resize-handle.tsx";
import { SongPanel } from "#/components/song-panel.tsx";
import {
	PanelScopeContext,
	SplitScopeContext,
	type SplitView,
	useDetail,
} from "#/context/detail-context.ts";
import { StatusScopeContext, useStatusScopeHandlers } from "#/context/status-context.ts";
import { usePaneWidth } from "#/lib/use-pane-width.ts";

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

/** Leaves the page at least this much room. */
const PAGE_ROOM = 480;

/**
 * Right-hand split beside the page for one song, album or artist. The page stays usable next to it:
 * picking another song title swaps what the split shows.
 */
export function SplitPane(): ReactNode {
	const { split } = useDetail();
	const scopeHandlers = useStatusScopeHandlers("split");
	const [width, setWidth] = usePaneWidth({
		key: "manplay.split-width",
		initial: 420,
		min: 340,
		max: () => window.innerWidth - PAGE_ROOM,
	});
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
			<ResizeHandle
				edge="left"
				width={width}
				min={340}
				initial={420}
				label="Resize panel"
				onWidth={setWidth}
			/>
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
