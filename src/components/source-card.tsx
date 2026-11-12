import type { ReactNode } from "react";
import { type Brand, BrandIcon } from "#/components/brand-icon.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { cn } from "#/lib/utils.ts";

interface Props {
	brand: Brand;
	title: string;
	/** Line under the title: what is set up. */
	subtitle: string;
	enabled: boolean;
	onToggle: (on: boolean) => void;
	/** Last-run line at the bottom left. */
	status: ReactNode;
	/** Primary action at the bottom right; hidden while the service is off. */
	action: ReactNode;
	/** Extra content between header and footer (e.g. progress). */
	children?: ReactNode;
	onOpen: () => void;
}

/** Summary of one service. Every import and export service looks and opens the same way. */
export function SourceCard({
	brand,
	title,
	subtitle,
	enabled,
	onToggle,
	status,
	action,
	children,
	onOpen,
}: Props) {
	return (
		<div className="space-y-4 rounded-xl border bg-card p-5 shadow-xs">
			<div className="flex items-start justify-between gap-3">
				<button
					type="button"
					onClick={onOpen}
					aria-label={`Open ${title} details`}
					className={cn(
						"flex min-w-0 flex-1 items-center gap-3 rounded-md text-left hover:opacity-80",
						!enabled && "opacity-50",
					)}
				>
					<BrandIcon brand={brand} />
					<span className="min-w-0">
						<span className="block truncate font-medium">{title}</span>
						<span className="block truncate text-muted-foreground text-sm" title={subtitle}>
							{subtitle}
						</span>
					</span>
				</button>
				<Switch checked={enabled} onChange={onToggle} label={`Enable ${title}`} />
			</div>
			{enabled && children}
			<div className="flex min-h-8 items-center justify-between gap-2 text-xs">
				<span className="min-w-0 truncate text-muted-foreground">{enabled ? status : "Off"}</span>
				{enabled && <span className="shrink-0">{action}</span>}
			</div>
		</div>
	);
}
