import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Shell } from "#/components/app-shell.tsx";
import { AutoRefresh } from "#/components/auto-refresh.tsx";
import { DuplicatesIndicator } from "#/components/duplicates.tsx";
import { IssuesIndicator } from "#/components/issues-drawer.tsx";
import { MissingIndicator } from "#/components/missing-files.tsx";
import { StatusBarHost, StatusScopeProvider } from "#/components/status-bar.tsx";
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
	const [missingOpen, setMissingOpen] = useState(false);
	const [duplicatesOpen, setDuplicatesOpen] = useState(false);
	const [issuesOpen, setIssuesOpen] = useState(false);
	return (
		<html lang="en" className="dark">
			<head>
				<HeadContent />
			</head>
			<body className="flex h-screen flex-col overflow-hidden">
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
													<Shell
														missingOpen={missingOpen}
														issuesOpen={issuesOpen}
														duplicatesOpen={duplicatesOpen}
														setMissingOpen={setMissingOpen}
														setIssuesOpen={setIssuesOpen}
														setDuplicatesOpen={setDuplicatesOpen}
													>
														{children}
													</Shell>
													<StatusBarHost
														setSlot={setStatusSlot}
														setSaveSlot={setSaveSlot}
														notices={
															<>
																<IssuesIndicator onClick={() => setIssuesOpen(true)} />
																<DuplicatesIndicator onClick={() => setDuplicatesOpen(true)} />
																<MissingIndicator onClick={() => setMissingOpen(true)} />
															</>
														}
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
