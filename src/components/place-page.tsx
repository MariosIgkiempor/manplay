import { History, Settings2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { PlaceTab } from "#/components/destination-header.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
import { PAGE_BODY } from "#/lib/page-layout.ts";
import { cn } from "#/lib/utils.ts";

/**
 * A source's or destination's page: its header across the top, and what is under it filling the
 * rest. By default the rest scrolls inside the page's width; `fill` hands it all the room, for
 * screens with their own scrolling and pinned footer (a drive's library browser). `scrollAll`
 * scrolls the header away with the rest, for screens that pin their own toolbar and footer (a
 * sync review).
 */
export function PlaceFrame({
	header,
	children,
	fill = false,
	scrollAll = false,
}: {
	header: ReactNode;
	children: ReactNode;
	fill?: boolean;
	scrollAll?: boolean;
}) {
	if (scrollAll) {
		return (
			<main className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain">
				{header}
				<div className="flex flex-1 flex-col">{children}</div>
			</main>
		);
	}
	return (
		<main className="flex h-full min-h-0 flex-col">
			{header}
			{fill ? (
				<div className="min-h-0 flex-1">{children}</div>
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className={cn("mx-auto w-full max-w-5xl space-y-5", PAGE_BODY)}>{children}</div>
				</div>
			)}
		</main>
	);
}

/** A page's own first tab, before History and Settings, e.g. a source's "Import". */
export interface MainTab {
	label: string;
	icon: ReactNode;
	content: ReactNode;
}

/**
 * Body of a source or destination page under its header: its own `main` tab when it has one, then
 * History and Settings. A switched-off source shows them faded and out of reach until it is
 * switched back on.
 */
export function PlacePage({
	header,
	main,
	history,
	settings,
	enabled = true,
}: {
	/** The page's header, given the tabs to put on its bottom edge. */
	header: (tabs: ReactNode) => ReactNode;
	main?: MainTab;
	history: ReactNode;
	settings: ReactNode;
	enabled?: boolean;
}) {
	const [tab, setTab] = useState<PlaceTab | "main">(main ? "main" : "history");
	const content = { main: main?.content, history, settings }[tab];
	return (
		<PlaceFrame
			header={header(
				<Segmented
					className="border-b-0"
					value={tab}
					onChange={setTab}
					label="Page view"
					items={[
						...(main ? [{ value: "main" as const, label: main.label, icon: main.icon }] : []),
						{ value: "history", label: "History", icon: <History /> },
						{ value: "settings", label: "Settings", icon: <Settings2 /> },
					]}
				/>,
			)}
		>
			<div className={cn(!enabled && "opacity-50")} inert={!enabled}>
				{content}
			</div>
		</PlaceFrame>
	);
}
