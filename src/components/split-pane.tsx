import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { DetailBody } from "#/components/detail-content.tsx";
import { PanelBar } from "#/components/panel-header.tsx";
import { ResizeHandle } from "#/components/resize-handle.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { useStatusScopeHandlers } from "#/context/status-context.ts";
import { detailViewKey } from "#/lib/detail-views.ts";
import { usePanePresence } from "#/lib/use-pane-presence.ts";
import { usePaneWidth } from "#/lib/use-pane-width.ts";

/** Songs, albums and artists are browsed beside the page, so Escape leaves them open. */
const BROWSED = new Set<string>(["song", "album", "artist"]);

function isTyping(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Leaves the page at least this much room. */
const PAGE_ROOM = 480;

/**
 * The side panel beside the page, where a detail card goes when it is pinned: songs, albums,
 * artists, tag values and tag editing, with back-history across all of them. The page stays
 * usable next to it: picking another song title swaps what the panel shows.
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
	const pinnedView = detail.pinned ? detail.view : null;
	const view = usePanePresence(pinnedView, paneRef);
	const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
	const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
	const barSlots = useMemo(
		() => ({ title: titleSlot, actions: actionsSlot }),
		[titleSlot, actionsSlot],
	);
	const key = view ? detailViewKey(view) : null;
	const closesOnEscape = pinnedView !== null && !BROWSED.has(pinnedView.kind);

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
			className="relative flex max-w-[70%] shrink-0 flex-col outline-none"
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
			{/* No card of its own: it sits on the canvas as the sidebar does. */}
			<div className="flex min-h-0 flex-1 justify-end overflow-hidden">
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
						<DetailBody view={view} slots={barSlots} />
					</div>
				</div>
			</div>
		</aside>
	);
}
