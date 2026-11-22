import { ArrowRight, ChevronRight, PowerOff } from "lucide-react";
import type { ReactNode } from "react";
import { type Brand, BrandIcon } from "#/components/brand-icon.tsx";
import { type MenuEntry, RowMenu } from "#/components/menu.tsx";
import { StatusIcon } from "#/components/status-icon.tsx";
import { cn } from "#/lib/utils.ts";

/**
 * Icon, name and where; a bar for how full it is; what happened last; one action. The action's
 * column has a width of its own, so the columns before it line up from row to row whatever each
 * row's button says.
 */
const GRID = "grid-cols-[2rem_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(8rem,auto)_1rem]";

/** How much of something a place holds: the library for a sync, space for a drive. */
export function PlaceFill({
	value,
	total,
	label,
}: {
	value: number;
	total: number;
	label: string;
}) {
	const percent = total === 0 ? 0 : Math.min(100, (value / total) * 100);
	return (
		<div className="min-w-0 space-y-1.5">
			<div className="truncate text-muted-foreground text-xs tabular-nums">{label}</div>
			{/* The label above says the same in words. */}
			<div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-muted">
				<div
					className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
					style={{ width: `${percent}%` }}
				/>
			</div>
		</div>
	);
}

export interface PlaceRowProps {
	brand: Brand;
	name: string;
	/** Next to the name, e.g. what kind of destination it is. */
	badge?: ReactNode;
	where: ReactNode;
	/** Hover text for `where`, e.g. the full path. */
	whereTitle?: string | undefined;
	fill: ReactNode;
	status: ReactNode;
	action: ReactNode;
	/** Goes to the destination's page. */
	open: () => void;
	menu: readonly MenuEntry[];
}

/** One source or destination. The row opens its page; the action works without opening it. */
export function PlaceRow({
	brand,
	name,
	badge,
	where,
	whereTitle,
	fill,
	status,
	action,
	open,
	menu,
}: PlaceRowProps) {
	const go = open;
	return (
		<RowMenu
			label={name}
			items={[{ label: "Open", icon: <ArrowRight />, onSelect: go }, "separator", ...menu]}
		>
			<div
				className={cn(
					"group grid min-h-16 items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/40",
					GRID,
				)}
			>
				<BrandIcon brand={brand} className="size-8" />
				<button
					type="button"
					onClick={go}
					className="min-w-0 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
				>
					<span className="flex items-center gap-2">
						<span className="truncate font-medium text-sm">{name}</span>
						{badge}
					</span>
					<span className="block truncate text-muted-foreground text-xs" title={whereTitle}>
						{where}
					</span>
				</button>
				{fill}
				<div className="min-w-0 truncate text-muted-foreground text-xs">{status}</div>
				{/* Right-clicks on the action are its own, not the row's. */}
				<fieldset
					aria-label={`${name} actions`}
					className="flex min-w-0 justify-end"
					onContextMenu={(e) => e.stopPropagation()}
				>
					{action}
				</fieldset>
				<button
					type="button"
					aria-label={`Open ${name}`}
					onClick={go}
					className="text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
				>
					<ChevronRight className="size-4" />
				</button>
			</div>
		</RowMenu>
	);
}

/** Beside a source's name while it is switched off. */
export function OffBadge() {
	return (
		<StatusIcon
			icon={<PowerOff />}
			label="Off"
			detail="Switched off: it doesn't look for new music. Turn it on from its menu or page."
		/>
	);
}
