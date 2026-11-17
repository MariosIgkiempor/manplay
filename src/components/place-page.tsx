import { History, Settings2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { PlaceTab } from "#/components/destination-header.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
import { cn } from "#/lib/utils.ts";

/**
 * A source's or destination's page: its header across the top, and what is under it filling the
 * rest. By default the rest scrolls inside the page's width; `fill` hands it all the room, for
 * screens with their own scrolling and pinned footer (a sync review, a drive's library browser).
 */
export function PlaceFrame({
	header,
	children,
	fill = false,
}: {
	header: ReactNode;
	children: ReactNode;
	fill?: boolean;
}) {
	return (
		<main className="flex h-full min-h-0 flex-col">
			{header}
			{fill ? (
				<div className="min-h-0 flex-1">{children}</div>
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto w-full max-w-5xl space-y-5 px-6 pt-6 pb-10">{children}</div>
				</div>
			)}
		</main>
	);
}

/**
 * Body of a source or destination page under its header: History and Settings tabs. A switched-off
 * source shows both faded and out of reach until it is switched back on.
 */
export function PlacePage({
	header,
	history,
	settings,
	enabled = true,
}: {
	/** The page's header, given the tabs to put on its bottom edge. */
	header: (tabs: ReactNode) => ReactNode;
	history: ReactNode;
	settings: ReactNode;
	enabled?: boolean;
}) {
	const [tab, setTab] = useState<PlaceTab>("history");
	return (
		<PlaceFrame
			header={header(
				<Segmented
					className="border-b-0"
					value={tab}
					onChange={setTab}
					label="Page view"
					items={[
						{ value: "history", label: "History", icon: <History /> },
						{ value: "settings", label: "Settings", icon: <Settings2 /> },
					]}
				/>,
			)}
		>
			<div className={cn(!enabled && "opacity-50")} inert={!enabled}>
				{tab === "history" ? history : settings}
			</div>
		</PlaceFrame>
	);
}
