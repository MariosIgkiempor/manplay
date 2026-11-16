import type { ReactNode } from "react";
import { AnalysisDrawer } from "#/components/analysis-drawer.tsx";
import { DuplicatesDrawer } from "#/components/duplicates.tsx";
import { IssuesDrawer } from "#/components/issues-drawer.tsx";
import { MissingDrawer } from "#/components/missing-files.tsx";
import { PlayerBar } from "#/components/player-bar.tsx";
import { Sidebar } from "#/components/sidebar.tsx";
import { SplitPane } from "#/components/split-pane.tsx";
import { SyncDrawers } from "#/components/sync-flow.tsx";
import { useStatusScopeHandlers } from "#/context/status-context.ts";

/** Sidebar, page, side panel and player; the status bar sits below all of them. */
export function Shell({
	children,
	missingOpen,
	issuesOpen,
	duplicatesOpen,
	setMissingOpen,
	setIssuesOpen,
	setDuplicatesOpen,
}: {
	children: ReactNode;
	missingOpen: boolean;
	issuesOpen: boolean;
	duplicatesOpen: boolean;
	setMissingOpen: (open: boolean) => void;
	setIssuesOpen: (open: boolean) => void;
	setDuplicatesOpen: (open: boolean) => void;
}) {
	const mainScope = useStatusScopeHandlers("main");
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex min-h-0 flex-1">
				<Sidebar />
				<div className="relative min-w-0 flex-1 overflow-hidden" {...mainScope}>
					<div className="@container/main h-full overflow-y-auto">{children}</div>
					<MissingDrawer open={missingOpen} onClose={() => setMissingOpen(false)} />
					<IssuesDrawer open={issuesOpen} onClose={() => setIssuesOpen(false)} />
					<DuplicatesDrawer open={duplicatesOpen} onClose={() => setDuplicatesOpen(false)} />
					<AnalysisDrawer />
					<SyncDrawers />
				</div>
				<SplitPane />
			</div>
			<PlayerBar />
		</div>
	);
}
