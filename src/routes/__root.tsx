import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Shell } from "#/components/app-shell.tsx";
import { AutoRefresh } from "#/components/auto-refresh.tsx";
import { FolderLibraryWatch } from "#/components/shared-library.tsx";
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
import { themeBootScript } from "#/lib/theme.ts";
import { useAppliedTheme } from "#/lib/use-theme.ts";
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
		scripts: [{ children: themeBootScript() }],
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
	const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
	const [saveSlot, setSaveSlot] = useState<HTMLElement | null>(null);
	useAppliedTheme();
	return (
		// The theme class and colour are set by the head's boot script before the first paint, and
		// kept by `useAppliedTheme`, so React leaves them alone.
		<html lang="en" suppressHydrationWarning>
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
													<FolderLibraryWatch />
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
