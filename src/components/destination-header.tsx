import { Folder } from "lucide-react";
import type { ReactNode } from "react";
import { type Brand, BrandIcon } from "#/components/brand-icon.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { PlaceCrumb } from "#/components/place-crumb.tsx";
import { PAGE_ART } from "#/lib/page-layout.ts";
import type { PlaceKey, PlaceSection } from "#/lib/places.ts";
import { cn } from "#/lib/utils.ts";

/**
 * Top of an import folder's or export destination's page: the shared header with the brand's
 * mark, after an `Export ▾` crumb that jumps between siblings.
 */
export function DestinationHeader({
	section,
	place,
	brand,
	title,
	titleHint,
	meta,
	extra,
	actions,
	toggle,
	tabs,
}: {
	section: PlaceSection;
	place: PlaceKey;
	brand: Brand;
	title: string;
	/** Hover text for the title, e.g. the full path. */
	titleHint?: string | undefined;
	/** Figures in one row (space, songs synced, file system). */
	meta?: ReactNode;
	/** Anything under the buttons, e.g. format pills. */
	extra?: ReactNode;
	actions?: ReactNode;
	/** An on/off switch at the top right, for sources that can be paused. */
	toggle?: ReactNode;
	/** Tabs on the header's bottom edge. */
	tabs?: ReactNode;
}) {
	return (
		<PageHeader
			art={<BrandIcon brand={brand} className={PAGE_ART} />}
			kind={<PlaceCrumb section={section} current={place} />}
			badge={toggle}
			title={title}
			titleHint={titleHint}
			meta={meta}
			actions={actions}
			tabs={tabs}
		>
			{extra}
		</PageHeader>
	);
}

/** Thin bar of how much of something is used or done, beside the words for it. */
export function UsageBar({
	value,
	total,
	children,
	warnAbove,
	tone = "neutral",
}: {
	value: number;
	total: number;
	children: ReactNode;
	/** Turns the bar amber above this share (0 to 1), e.g. a nearly full drive. */
	warnAbove?: number;
	/** "progress" fills in the accent colour, for things done rather than space taken. */
	tone?: "neutral" | "progress";
}) {
	const share = total > 0 ? Math.min(1, value / total) : 0;
	const warn = warnAbove !== undefined && share > warnAbove;
	let fill = "bg-muted-foreground/60";
	if (warn) {
		fill = "bg-warning";
	} else if (tone === "progress") {
		fill = "bg-primary";
	}
	return (
		<span className="flex items-center gap-2">
			<span aria-hidden="true" className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
				<span
					className={cn(
						"block h-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
						fill,
					)}
					style={{ width: `${share * 100}%` }}
				/>
			</span>
			{children}
		</span>
	);
}

/** A setting's name with an icon and a line on what it does, for a settings row. */
export function SettingLabel({
	icon,
	title,
	hint,
}: {
	icon: ReactNode;
	title: string;
	hint: ReactNode;
}) {
	return (
		<span className="flex items-start gap-3">
			<span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span>
			<span className="space-y-0.5">
				<span className="block">{title}</span>
				<span className="block max-w-sm text-muted-foreground text-xs">{hint}</span>
			</span>
		</span>
	);
}

/** Tabs every source and destination page has: what happened, and how it is set up. */
export type PlaceTab = "history" | "settings";

/** Where a place is on disk or in a share, as one truncated figure; nothing without a path. */
export function FolderFigure({ path }: { path: string | null }) {
	if (path === null) {
		return null;
	}
	return (
		<span className="flex min-w-0 items-center gap-1" data-hint={path}>
			<Folder className="size-3.5 shrink-0" />
			<span className="truncate">{path}</span>
		</span>
	);
}
