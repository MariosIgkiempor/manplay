import { type ReactNode, useRef, useState } from "react";
import { CommandPalette } from "#/components/command-palette.tsx";
import { PlayerBar } from "#/components/player-bar.tsx";
import { Sidebar } from "#/components/sidebar.tsx";
import { SplitPane } from "#/components/split-pane.tsx";
import { SyncDrawers } from "#/components/sync-flow.tsx";
import { SplitSlotContext } from "#/context/split-slot.ts";
import { useStatusScopeHandlers } from "#/context/status-context.ts";
import { CARD } from "#/lib/page-layout.ts";
import { usePageMotion } from "#/lib/page-transition.ts";
import { useAnalysisResults } from "#/lib/queries.ts";
import { usePageSearchKey } from "#/lib/use-page-search-key.ts";
import { cn } from "#/lib/utils.ts";

/** Sidebar, the page's card and the cards beside it, and the player; the status bar sits below. */
export function Shell({ children }: { children: ReactNode }) {
	const mainScope = useStatusScopeHandlers("main");
	useAnalysisResults();
	usePageSearchKey();
	// The page's whole card moves as a page arrives, outline and all.
	const pageRef = useRef<HTMLDivElement>(null);
	usePageMotion(pageRef);
	const [splitSlot, setSplitSlot] = useState<HTMLElement | null>(null);
	return (
		<SplitSlotContext.Provider value={splitSlot}>
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex min-h-0 flex-1">
					<Sidebar />
					{/* The page, a page's own second pane and the side panel: each a card on the canvas. */}
					{/* Clips the cards as they slide in, so they rise from the canvas's edge. */}
					<div className="flex min-w-0 flex-1 gap-2 overflow-hidden py-2 pr-2">
						<div
							ref={pageRef}
							className={cn(CARD, "relative min-w-0 flex-1 overflow-hidden")}
							{...mainScope}
						>
							<div className="@container/main h-full overflow-y-auto">{children}</div>
							<SyncDrawers />
						</div>
						<div ref={setSplitSlot} className="contents" />
						<SplitPane />
					</div>
				</div>
				<PlayerBar />
				<CommandPalette />
			</div>
		</SplitSlotContext.Provider>
	);
}
