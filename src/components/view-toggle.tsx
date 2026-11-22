import { Tabs, TabsIndicator, TabsList, TabsTab } from "@ui-sdk/react/tabs";
import { Disc3, ListMusic, Mic2 } from "lucide-react";
import type { ReactNode } from "react";
import type { LibraryView } from "#/lib/api.ts";
import { cn } from "#/lib/utils.ts";

export type View = LibraryView;

/**
 * The app's one tab style: labels on a rule, the chosen one underlined in the accent colour.
 * For switching a page, panel or drawer between views; `count` adds a badge. Arrow keys, Home and
 * End move between tabs (UI SDK Tabs); the underline slides to the chosen tab.
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
		<Tabs<T>
			value={value}
			onValueChange={(next) => {
				if (next !== null) {
					onChange(next);
				}
			}}
		>
			<TabsList
				aria-label={label}
				className={cn("relative flex shrink-0 gap-1 border-b", className)}
			>
				{items.map((item) => (
					<TabsTab
						key={item.value}
						value={item.value}
						data-hint={item.label}
						className={cn(
							"flex min-w-0 items-center gap-2 px-3 py-2 font-medium text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring/60 data-selected:text-foreground [&_svg]:size-4 [&_svg]:shrink-0",
						)}
					>
						{item.icon}
						{/* Icons only once the page is too narrow for the words and a search beside them (42rem). */}
						<span className={cn("truncate", item.icon && compact && "@max-2xl/main:sr-only")}>
							{item.label}
						</span>
						{item.count !== undefined && item.count > 0 && (
							<span className="min-w-5 rounded-full bg-primary/15 px-1.5 text-primary text-xs tabular-nums">
								{item.count}
							</span>
						)}
					</TabsTab>
				))}
				<TabsIndicator className="absolute bottom-[-1px] left-0 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) rounded-full bg-primary transition-[translate,width] duration-200 ease-out motion-reduce:transition-none" />
			</TabsList>
		</Tabs>
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
