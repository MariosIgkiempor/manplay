import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { AutoRefresh } from "#/components/auto-refresh.tsx";
import { DetailPanel } from "#/components/detail-panel.tsx";
import { PlayerBar } from "#/components/player-bar.tsx";
import { Sidebar } from "#/components/sidebar.tsx";
import { StatusSlotContext } from "#/context/detail-context.ts";
import { DetailProvider } from "#/context/detail-provider.tsx";
import { PlayerProvider } from "#/context/player-provider.tsx";
import { SyncProgressProvider } from "#/context/sync-progress-provider.tsx";
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
	return (
		<html lang="en" className="dark">
			<head>
				<HeadContent />
			</head>
			<body className="overflow-hidden">
				<QueryClientProvider client={queryClient}>
					<PlayerProvider>
						<SyncProgressProvider>
							<DetailProvider>
								<AutoRefresh />
								<div className="flex h-screen flex-col">
									<div className="flex min-h-0 flex-1">
										<Sidebar />
										<div className="relative min-w-0 flex-1 overflow-hidden">
											<StatusSlotContext.Provider value={statusSlot}>
												<div className="h-full overflow-y-auto">{children}</div>
											</StatusSlotContext.Provider>
											<div ref={setStatusSlot} className="absolute inset-x-0 bottom-0 z-10" />
											<DetailPanel />
										</div>
									</div>
									<PlayerBar />
								</div>
							</DetailProvider>
						</SyncProgressProvider>
					</PlayerProvider>
				</QueryClientProvider>
				<Scripts />
			</body>
		</html>
	);
}
