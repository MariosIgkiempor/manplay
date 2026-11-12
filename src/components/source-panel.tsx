import type { ReactNode } from "react";
import { type Brand, BrandIcon } from "#/components/brand-icon.tsx";
import { HistoryList } from "#/components/history-list.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import type { HistoryEntry } from "#/lib/history.ts";
import { cn } from "#/lib/utils.ts";

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-2">
			<h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
				{children}
			</h3>
			{action}
		</div>
	);
}

/**
 * Drawer layout shared by every service: header with its on/off switch, then settings and either
 * its own history (`entries`) or custom `children` such as a list of machines.
 */
export function SourcePanel({
	brand,
	title,
	subtitle,
	enabled,
	onToggle,
	settings,
	entries,
	empty,
	children,
}: {
	brand: Brand;
	title: string;
	subtitle: string;
	enabled: boolean;
	onToggle: (on: boolean) => void;
	settings?: ReactNode;
	entries?: readonly HistoryEntry[];
	empty?: string;
	children?: ReactNode;
}) {
	return (
		<div className="space-y-8 pb-8">
			<div className="flex items-start gap-3">
				<BrandIcon brand={brand} className="size-10" />
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold text-2xl tracking-tight">{title}</h2>
					<p className="text-muted-foreground text-sm">{subtitle}</p>
				</div>
				<Switch checked={enabled} onChange={onToggle} label={`Enable ${title}`} />
			</div>
			<div className={cn("space-y-8", !enabled && "opacity-50")} inert={!enabled}>
				{settings && (
					<section className="space-y-4">
						<SectionTitle>Settings</SectionTitle>
						{settings}
					</section>
				)}
				{children}
				{entries && (
					<section className="space-y-2">
						<SectionTitle>History</SectionTitle>
						<HistoryList entries={entries} empty={empty ?? "Nothing yet."} />
					</section>
				)}
			</div>
		</div>
	);
}
