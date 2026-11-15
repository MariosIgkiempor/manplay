import { History, Settings2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { PlaceTab } from "#/components/destination-header.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
import { cn } from "#/lib/utils.ts";

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
		<div className="space-y-5 pb-6">
			{header(
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
			<div className={cn(!enabled && "opacity-50")} inert={!enabled}>
				{tab === "history" ? history : settings}
			</div>
		</div>
	);
}
