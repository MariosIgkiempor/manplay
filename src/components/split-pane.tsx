import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AlbumPanel } from "#/components/album-panel.tsx";
import { ArtistPanel } from "#/components/artist-panel.tsx";
import { DuplicatesPanel } from "#/components/duplicates.tsx";
import { EditTagsPanel } from "#/components/edit-tags-panel.tsx";
import { IssuesPanel } from "#/components/issues-drawer.tsx";
import { MissingPanel } from "#/components/missing-files.tsx";
import { PanelBar } from "#/components/panel-header.tsx";
import { ResizeHandle } from "#/components/resize-handle.tsx";
import { SongPanel } from "#/components/song-panel.tsx";
import { ValuePanel } from "#/components/value-panel.tsx";
import { type DetailView, PanelScopeContext, useDetail } from "#/context/detail-context.ts";
import { PanelBarContext } from "#/context/panel-bar.tsx";
import { StatusScopeContext, useStatusScopeHandlers } from "#/context/status-context.ts";
import { CARD } from "#/lib/page-layout.ts";
import { usePanePresence } from "#/lib/use-pane-presence.ts";
import { usePaneWidth } from "#/lib/use-pane-width.ts";
import { cn } from "#/lib/utils.ts";

function Content({ view }: { view: DetailView }) {
	switch (view.kind) {
		case "song":
			return <SongPanel trackId={view.trackId} list={view.list} />;
		case "album":
			return <AlbumPanel albumKey={view.key} />;
		case "artist":
			return <ArtistPanel name={view.name} />;
		case "value":
			return <ValuePanel field={view.field} value={view.value} />;
		case "edit":
			return <EditTagsPanel target={view.target} />;
		case "missing":
			return <MissingPanel />;
		case "issues":
			return <IssuesPanel />;
		case "duplicates":
			return <DuplicatesPanel />;
	}
}

/** Swapping what the panel shows keeps its scroll at the top; a song's tab or list does not count. */
const viewKey = (v: DetailView) =>
	v.kind === "song"
		? `song:${v.trackId}`
		: v.kind === "album"
			? `album:${v.key}`
			: v.kind === "artist"
				? `artist:${v.name}`
				: JSON.stringify(v);

/** Songs, albums and artists are browsed beside the page, so Escape leaves them open. */
const BROWSED = new Set<string>(["song", "album", "artist"]);

function isTyping(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Leaves the page at least this much room. */
const PAGE_ROOM = 480;

/**
 * The one side panel beside the page: songs, albums, artists, tag values and tag editing, with
 * back-history across all of them. The page stays usable next to it:
 * picking another song title swaps what the panel shows.
 */
export function SplitPane(): ReactNode {
	const detail = useDetail();
	const { close } = detail;
	const scopeHandlers = useStatusScopeHandlers("panel");
	const [width, setWidth] = usePaneWidth({
		key: "manplay.split-width",
		initial: 420,
		min: 340,
		max: () => window.innerWidth - PAGE_ROOM,
	});
	const [scroller, setScroller] = useState<HTMLElement | null>(null);
	// Slides open and shut; while shutting it keeps showing the last view.
	const paneRef = useRef<HTMLElement>(null);
	const view = usePanePresence(detail.view, paneRef, width);
	const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
	const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
	const barSlots = useMemo(
		() => ({ title: titleSlot, actions: actionsSlot }),
		[titleSlot, actionsSlot],
	);
	const key = view ? viewKey(view) : null;
	const closesOnEscape = detail.view !== null && !BROWSED.has(detail.view.kind);

	// A different thing starts at the top; switching a song's tab does not.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the shown thing changes
	useEffect(() => {
		scroller?.scrollTo({ top: 0 });
	}, [scroller, key]);

	useEffect(() => {
		if (!closesOnEscape) {
			return;
		}
		const onKey = (e: KeyboardEvent) => {
			if (
				e.key === "Escape" &&
				!e.defaultPrevented &&
				!isTyping(e.target) &&
				!document.querySelector("[role=dialog]")
			) {
				close();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [closesOnEscape, close]);

	if (!view) {
		return null;
	}
	return (
		<aside
			ref={paneRef}
			aria-label="Details"
			data-detail-panel
			tabIndex={-1}
			{...scopeHandlers}
			style={{ width }}
			className={cn(CARD, "relative flex max-w-[70%] shrink-0 flex-col outline-none")}
		>
			<ResizeHandle
				edge="left"
				inGap
				width={width}
				min={340}
				initial={420}
				label="Resize panel"
				onWidth={setWidth}
			/>
			{/* Clips to the card's corners; the handle sits outside it, in the gap. The content keeps
			    its width while the card opens and shuts, held to the right as if sliding in. */}
			<div className="flex min-h-0 flex-1 justify-end overflow-hidden rounded-[inherit]">
				<div style={{ width }} className="flex min-h-0 max-w-none shrink-0 flex-col">
					<PanelBar
						canGoBack={detail.canGoBack}
						onBack={detail.back}
						onClose={close}
						closeLabel="Close"
						onTitleSlot={setTitleSlot}
						onActionsSlot={setActionsSlot}
					/>
					<div
						ref={setScroller}
						className="@container/split min-h-0 flex-1 overflow-y-auto px-5 pt-5"
					>
						<PanelBarContext.Provider value={barSlots}>
							<PanelScopeContext.Provider value>
								<StatusScopeContext.Provider value="panel">
									<detail.UnsavedScope>
										{/* Each new thing eases in; switching a song's tab does not. */}
										<div
											key={key}
											className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none"
										>
											<Content view={view} />
										</div>
									</detail.UnsavedScope>
								</StatusScopeContext.Provider>
							</PanelScopeContext.Provider>
						</PanelBarContext.Provider>
					</div>
				</div>
			</div>
		</aside>
	);
}
