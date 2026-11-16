import { type ReactNode, useEffect, useState } from "react";
import { AddDestinationPanel } from "#/components/add-destination-panel.tsx";
import { AlbumPanel } from "#/components/album-panel.tsx";
import { ArtistPanel } from "#/components/artist-panel.tsx";
import { DownloadsPanel } from "#/components/downloads-source.tsx";
import { EditTagsPanel } from "#/components/edit-tags-panel.tsx";
import { ItunesPanel } from "#/components/itunes-source.tsx";
import { PanelBar } from "#/components/panel-header.tsx";
import { RekordboxPanel } from "#/components/rekordbox-source.tsx";
import { ResizeHandle } from "#/components/resize-handle.tsx";
import { SongPanel } from "#/components/song-panel.tsx";
import { TargetPanel } from "#/components/target-detail.tsx";
import { UsbDrivePanel } from "#/components/usb-drives.tsx";
import { ValuePanel } from "#/components/value-panel.tsx";
import { type DetailView, PanelScopeContext, useDetail } from "#/context/detail-context.ts";
import { StatusScopeContext, useStatusScopeHandlers } from "#/context/status-context.ts";
import type { ServiceId } from "#/lib/api.ts";
import { usePaneWidth } from "#/lib/use-pane-width.ts";

/** Services with a panel of their own; export folders, buckets and drives open one each. */
const SERVICE_PANELS: Partial<Record<ServiceId, () => ReactNode>> = {
	downloads: DownloadsPanel,
	itunes: ItunesPanel,
	rekordbox: RekordboxPanel,
};

function Content({ view }: { view: DetailView }) {
	switch (view.kind) {
		case "song":
			return <SongPanel trackId={view.trackId} requested={view.tab} list={view.list} />;
		case "album":
			return <AlbumPanel albumKey={view.key} />;
		case "artist":
			return <ArtistPanel name={view.name} />;
		case "service": {
			const Panel = SERVICE_PANELS[view.service];
			return Panel ? <Panel /> : null;
		}
		case "target":
			return <TargetPanel id={view.id} />;
		case "usb":
			return <UsbDrivePanel mount={view.mount} />;
		case "add-destination":
			return <AddDestinationPanel service={view.service} />;
		case "value":
			return <ValuePanel field={view.field} value={view.value} />;
		case "edit":
			return <EditTagsPanel target={view.target} />;
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

/** A drive's library browser needs room for its playlists beside their songs. */
const USB_MIN_WIDTH = 720;

/**
 * The one side panel beside the page: songs, albums, artists, tag values, tag editing, sources,
 * destinations and drives, with back-history across all of them. The page stays usable next to it:
 * picking another song title swaps what the panel shows.
 */
export function SplitPane(): ReactNode {
	const detail = useDetail();
	const { view, close } = detail;
	const scopeHandlers = useStatusScopeHandlers("panel");
	const [width, setWidth] = usePaneWidth({
		key: "manplay.split-width",
		initial: 420,
		min: 340,
		max: () => window.innerWidth - PAGE_ROOM,
	});
	const [scroller, setScroller] = useState<HTMLElement | null>(null);
	const key = view ? viewKey(view) : null;
	const closesOnEscape = view !== null && !BROWSED.has(view.kind);

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
			aria-label="Details"
			data-detail-panel
			tabIndex={-1}
			{...scopeHandlers}
			style={{ width, minWidth: view.kind === "usb" ? USB_MIN_WIDTH : undefined }}
			className="relative flex max-w-[70%] shrink-0 flex-col border-l bg-background outline-none"
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
				canGoBack={detail.canGoBack}
				onBack={detail.back}
				onClose={close}
				closeLabel="Close"
			/>
			<div ref={setScroller} className="@container/split min-h-0 flex-1 overflow-y-auto px-5 pt-5">
				<PanelScopeContext.Provider value>
					<StatusScopeContext.Provider value="panel">
						<detail.UnsavedScope>
							<Content view={view} />
						</detail.UnsavedScope>
					</StatusScopeContext.Provider>
				</PanelScopeContext.Provider>
			</div>
		</aside>
	);
}
