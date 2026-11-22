import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Shell } from "#/components/app-shell.tsx";
import { AutoRefresh } from "#/components/auto-refresh.tsx";
import { StatusBarHost, StatusScopeProvider } from "#/components/status-bar.tsx";
import { StatusNotices } from "#/components/status-notices.tsx";
import { SyncScanEvents } from "#/components/sync-scan-events.tsx";
import { StatusSlotContext } from "#/context/detail-context.ts";
import { DetailProvider } from "#/context/detail-provider.tsx";
import { PlayerProvider } from "#/context/player-provider.tsx";
import { SaveSlotContext } from "#/context/status-context.ts";
import { SyncActionsProvider } from "#/context/sync-actions-provider.tsx";
import { SyncProgressProvider } from "#/context/sync-progress-provider.tsx";
import { UndoProvider } from "#/context/undo-provider.tsx";
import appCss from "../styles.css?url";

const queryClient = new QueryClient();

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "manplay" },
		],
		links: [{ rel: "stylesheet", href: appCss }],
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
	const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
	const [saveSlot, setSaveSlot] = useState<HTMLElement | null>(null);
	return (
		// The page's colour before the stylesheet has loaded, so a launch does not flash white.
		<html lang="en" className="dark" style={{ backgroundColor: "#0b0d10" }}>
			<head>
				<HeadContent />
			</head>
			<body className="flex h-screen flex-col overflow-hidden bg-canvas">
				<QueryClientProvider client={queryClient}>
					<PlayerProvider>
						<SyncProgressProvider>
							<UndoProvider>
								<DetailProvider>
									<SyncActionsProvider>
										<StatusScopeProvider>
											<StatusSlotContext.Provider value={statusSlot}>
												<SaveSlotContext.Provider value={saveSlot}>
													<AutoRefresh />
													<SyncScanEvents />
													<Shell>{children}</Shell>
													<StatusBarHost
														setSlot={setStatusSlot}
														setSaveSlot={setSaveSlot}
														notices={<StatusNotices />}
													/>
												</SaveSlotContext.Provider>
											</StatusSlotContext.Provider>
										</StatusScopeProvider>
									</SyncActionsProvider>
								</DetailProvider>
							</UndoProvider>
						</SyncProgressProvider>
					</PlayerProvider>
				</QueryClientProvider>
				<Scripts />
			</body>
		</html>
	);
}
