import { ArrowRight, History, Settings2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type Brand, BrandIcon } from "#/components/brand-icon.tsx";
import type { PlaceTab } from "#/components/destination-header.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
import { PAGE_BODY } from "#/lib/page-layout.ts";
import { cn } from "#/lib/utils.ts";

/**
 * A source's or destination's page: its header across the top and what is under it, scrolling
 * together, so the header folds away to its tabs as on every page. By default the rest sits in the
 * page's width; `flush` hands it the whole width, for screens with their own layout and pinned bars
 * (a drive's library browser, a sync review), which pin below the header's tabs
 * (`--pinned-header`).
 */
export function PlaceFrame({
	header,
	children,
	flush = false,
}: {
	header: ReactNode;
	children: ReactNode;
	flush?: boolean;
}) {
	return (
		<main className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain">
			{header}
			{flush ? (
				<div className="flex flex-1 flex-col">{children}</div>
			) : (
				<div className={cn("w-full max-w-5xl space-y-5", PAGE_BODY)}>{children}</div>
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

/**
 * One source's or destination's settings among every one's, on the Import or Export page: its
 * mark and name, a way to its own page, and its settings under them.
 */
export function PlaceSettingsGroup({
	brand,
	title,
	detail,
	toggle,
	onOpen,
	children,
}: {
	brand: Brand;
	title: string;
	/** Where it is, quietly after the name. */
	detail?: string | undefined;
	/** Its on/off switch, for a source that has one. */
	toggle?: ReactNode;
	onOpen: () => void;
	children: ReactNode;
}) {
	return (
		<section aria-label={title} className="space-y-3">
			<div className="flex items-center gap-3">
				<BrandIcon brand={brand} className="size-7 shrink-0 rounded-md" />
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-medium text-[0.9375rem]">{title}</h2>
					{detail && <p className="truncate text-muted-foreground text-xs">{detail}</p>}
				</div>
				{toggle}
				<Button variant="ghost" size="sm" onClick={onOpen}>
					Open <ArrowRight />
				</Button>
			</div>
			{children}
		</section>
	);
}

export type OverviewTab = "list" | "history" | "settings";

/** The Import and Export pages' tabs: every source (or destination), then all their history and settings. */
export function OverviewTabs({
	tab,
	onChange,
	list,
}: {
	tab: OverviewTab;
	onChange: (tab: OverviewTab) => void;
	/** The first tab, the list itself. */
	list: { label: string; icon: ReactNode };
}) {
	return (
		<Segmented
			className="border-b-0"
			value={tab}
			onChange={onChange}
			label="Page view"
			items={[
				{ value: "list", label: list.label, icon: list.icon },
				{ value: "history", label: "History", icon: <History /> },
				{ value: "settings", label: "Settings", icon: <Settings2 /> },
			]}
		/>
	);
}
