import { Tabs, TabsIndicator, TabsList, TabsTab } from "@ui-sdk/react/tabs";
import { Disc3, ListMusic, Mic2 } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import type { LibraryView } from "#/lib/api.ts";
import { cn } from "#/lib/utils.ts";

export type View = LibraryView;

/**
 * The app's one tab style: labels on a rule, the chosen one underlined in the accent colour.
 * For switching a page, panel or drawer between views; `count` adds a badge. Arrow keys, Home and
 * End move between tabs (UI SDK Tabs); the underline slides to the chosen tab. Tabs that do not
 * fit scroll sideways, and the chosen one is scrolled into view.
 */
export function Segmented<T extends string>({
	value,
	onChange,
	label,
	items,
	compact = true,
	ruled = true,
	className,
}: {
	value: T;
	onChange: (v: T) => void;
	label: string;
	items: readonly { value: T; label: string; icon?: ReactNode; count?: number }[];
	/** Drop the words, keeping the icons, when the page is narrow (on by default). */
	compact?: boolean;
	/** Draw a rule under the tabs; off where they sit on a header's bottom edge, which is the rule. */
	ruled?: boolean;
	className?: string;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const list = listRef.current;
		if (!list) {
			return;
		}
		// Not passive, so the page does not scroll as well.
		list.addEventListener("wheel", scrollSidewaysOnWheel, { passive: false });
		return () => list.removeEventListener("wheel", scrollSidewaysOnWheel);
	}, []);
	return (
		<Tabs<T>
			// Its own layout box, so the list's negative margin adds to a parent's instead of merging.
			className="flow-root min-w-0 max-w-full"
			value={value}
			onValueChange={(next) => {
				if (next !== null) {
					onChange(next);
				}
			}}
		>
			<TabsList
				aria-label={label}
				className={cn(
					// The underline hangs 1px below the tabs, over the rule; the padding keeps it inside the
					// scroller, which would clip it.
					"no-scrollbar relative flex min-w-0 gap-1 overflow-x-auto overflow-y-hidden pb-px",
					ruled ? "shadow-[inset_0_-1px_0_var(--color-border)]" : "-mb-px",
					className,
				)}
				ref={listRef}
			>
				{items.map((item) => (
					<TabsTab
						key={item.value}
						value={item.value}
						data-hint={item.label}
						className={cn(
							"flex shrink-0 items-center gap-2 whitespace-nowrap px-3 py-2 font-medium text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring/60 data-selected:text-foreground [&_svg]:size-4 [&_svg]:shrink-0",
						)}
					>
						{item.icon}
						{/* Icons only once the page is too narrow for the words and a search beside them (42rem). */}
						<span className={cn(item.icon && compact && "@max-2xl/main:sr-only")}>
							{item.label}
						</span>
						{item.count !== undefined && item.count > 0 && (
							<span className="min-w-5 rounded-full bg-primary/15 px-1.5 text-primary text-xs tabular-nums">
								{item.count}
							</span>
						)}
					</TabsTab>
				))}
				<TabsIndicator className="absolute bottom-0 left-0 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) rounded-full bg-primary transition-[translate,width] duration-200 ease-out motion-reduce:transition-none" />
			</TabsList>
		</Tabs>
	);
}

/** A mouse wheel only scrolls up and down; turn that into sideways scrolling on a tab row. */
function scrollSidewaysOnWheel(event: WheelEvent) {
	const list = event.currentTarget;
	if (!(list instanceof HTMLElement)) {
		return;
	}
	const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
	if (sideways || list.scrollWidth <= list.clientWidth) {
		return;
	}
	event.preventDefault();
	list.scrollLeft += event.deltaY;
}

export function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
	return (
		<Segmented
			value={view}
			onChange={onChange}
			label="Library view"
			compact
			// Sits on the page header's bottom edge, which is its rule.
			ruled={false}
			items={[
				{ value: "albums", label: "Albums", icon: <Disc3 /> },
				{ value: "songs", label: "Songs", icon: <ListMusic /> },
				{ value: "artists", label: "Artists", icon: <Mic2 /> },
			]}
		/>
	);
}
