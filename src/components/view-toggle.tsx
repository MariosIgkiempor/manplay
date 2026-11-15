import { Disc3, ListMusic, Mic2 } from "lucide-react";
import type { ReactNode } from "react";
import type { LibraryView } from "#/lib/api.ts";
import { cn } from "#/lib/utils.ts";

export type View = LibraryView;

/**
 * The app's one tab style: labels on a rule, the chosen one underlined in the accent colour.
 * For switching a page, panel or drawer between views; `count` adds a badge.
 */
export function Segmented<T extends string>({
	value,
	onChange,
	label,
	items,
	compact = false,
	className,
}: {
	value: T;
	onChange: (v: T) => void;
	label: string;
	items: readonly { value: T; label: string; icon?: ReactNode; count?: number }[];
	/** Drop the words, keeping the icons, when the page is narrow. */
	compact?: boolean;
	className?: string;
}) {
	return (
		<div
			role="tablist"
			aria-label={label}
			className={cn("flex shrink-0 gap-1 border-b", className)}
		>
			{items.map((item) => (
				<button
					key={item.value}
					type="button"
					role="tab"
					aria-selected={value === item.value}
					title={item.label}
					onClick={() => onChange(item.value)}
					className={cn(
						"-mb-px flex min-w-0 items-center gap-2 border-b-2 px-3 py-2 font-medium text-sm outline-none transition-colors focus-visible:rounded-t-md focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-4 [&_svg]:shrink-0",
						value === item.value
							? "border-primary text-foreground"
							: "border-transparent text-muted-foreground hover:text-foreground",
					)}
				>
					{item.icon}
					{/* Icons only once the page is too narrow for the words (under 28rem). */}
					<span className={cn("truncate", item.icon && compact && "@max-md/main:sr-only")}>
						{item.label}
					</span>
					{item.count !== undefined && item.count > 0 && (
						<span className="min-w-5 rounded-full bg-primary/15 px-1.5 text-primary text-xs tabular-nums">
							{item.count}
						</span>
					)}
				</button>
			))}
		</div>
	);
}

export function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
	return (
		<Segmented
			value={view}
			onChange={onChange}
			label="Library view"
			compact
			// Sits on the page header's bottom edge, which is its rule.
			className="border-b-0"
			items={[
				{ value: "albums", label: "Albums", icon: <Disc3 /> },
				{ value: "songs", label: "Songs", icon: <ListMusic /> },
				{ value: "artists", label: "Artists", icon: <Mic2 /> },
			]}
		/>
	);
}
