import { type ReactNode, useState } from "react";
import { AppShortcuts } from "#/components/app-shortcuts.tsx";
import { CommandPalette } from "#/components/command-palette.tsx";
import { ConfirmHost } from "#/components/confirm-host.tsx";
import { DetailCard } from "#/components/detail-card.tsx";
import { FilePickerHost } from "#/components/file-picker.tsx";
import { HintLayer } from "#/components/hint-layer.tsx";
import { HistorySwipe } from "#/components/history-swipe.tsx";
import { PlayerBar } from "#/components/player-bar.tsx";
import { PlayingPicker } from "#/components/playing-picker.tsx";
import { Sidebar } from "#/components/sidebar.tsx";
import { SplitPane } from "#/components/split-pane.tsx";
import { SyncRequests } from "#/components/sync-flow.tsx";
import { TextFieldMenu } from "#/components/text-field-menu.tsx";
import { SplitSlotContext } from "#/context/split-slot.ts";
import { useStatusScopeHandlers } from "#/context/status-context.ts";
import { GROW_LAYER_ATTRIBUTE } from "#/lib/grow-card.ts";
import { CARD } from "#/lib/page-layout.ts";
import { PAGE_MOTION_ATTRIBUTE, usePageDirection } from "#/lib/page-transition.ts";
import { useAnalysisResults } from "#/lib/queries.ts";
import { useListEntryKeys } from "#/lib/use-list-entry-keys.ts";
import { usePageSearchKey } from "#/lib/use-page-search-key.ts";
import { cn } from "#/lib/utils.ts";

/** Sidebar, the page's card and the cards beside it, and the player; the status bar sits below. */
export function Shell({ children }: { children: ReactNode }) {
	const mainScope = useStatusScopeHandlers("main");
	useAnalysisResults();
	usePageSearchKey();
	useListEntryKeys();
	usePageDirection();
	const [splitSlot, setSplitSlot] = useState<HTMLElement | null>(null);
	return (
		<SplitSlotContext.Provider value={splitSlot}>
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex min-h-0 flex-1">
					<Sidebar />
					{/* The page, a page's own second pane and the side panel: each a card on the canvas. */}
					{/* Clips the cards as they slide in, so they rise from the canvas's edge. */}
					<div className="relative flex min-w-0 flex-1 gap-2 overflow-hidden py-2 pr-2">
						{/* The whole card moves as the page changes, outline and all. */}
						<div
							className={cn(
								CARD,
								"relative min-w-0 flex-1 overflow-hidden [view-transition-name:page]",
							)}
							{...{ [PAGE_MOTION_ATTRIBUTE]: "page" }}
							{...mainScope}
						>
							{/* The scrollbar's lane is kept on every page, so the page's right edge never shifts. */}
							{/* A card grown out of something on the page is laid out here and scrolls with it. */}
							<div
								className="@container/main relative h-full overflow-y-auto [scrollbar-gutter:stable]"
								{...{ [GROW_LAYER_ATTRIBUTE]: "" }}
							>
								{children}
							</div>
							<SyncRequests />
						</div>
						<div ref={setSplitSlot} className="contents" />
						<SplitPane />
						<DetailCard />
					</div>
				</div>
				<PlayerBar />
				<CommandPalette />
				<PlayingPicker />
				<AppShortcuts />
				<HistorySwipe />
				<FilePickerHost />
				<ConfirmHost />
				<HintLayer />
				<TextFieldMenu />
			</div>
		</SplitSlotContext.Provider>
	);
}
