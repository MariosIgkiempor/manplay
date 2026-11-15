import { Disc3, ListMusic, Mic2 } from "lucide-react";
import type { ReactNode } from "react";
import type { LibraryView } from "#/lib/api.ts";
import { cn } from "#/lib/utils.ts";

export type View = LibraryView;

/** A row of mutually exclusive choices as one pill, for switching a page or panel between views. */
export function Segmented<T extends string>({
	value,
	onChange,
	label,
	items,
	compact = false,
}: {
	value: T;
	onChange: (v: T) => void;
	label: string;
	items: readonly { value: T; label: string; icon?: ReactNode }[];
	/** Drop the words, keeping the icons, when the page is narrow. */
	compact?: boolean;
}) {
	return (
		<div role="tablist" aria-label={label} className="flex rounded-lg bg-muted p-0.5">
			{items.map((item) => (
				<button
					key={item.value}
					type="button"
					role="tab"
					aria-selected={value === item.value}
					title={item.label}
					onClick={() => onChange(item.value)}
					className={cn(
						"flex items-center gap-1.5 rounded-md px-3 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-4",
						value === item.value ? "bg-background shadow" : "text-muted-foreground",
					)}
				>
					{item.icon}
					{/* Icons only once the page is narrow, e.g. beside the split. */}
					<span className={cn(item.icon && compact && "@max-2xl/main:sr-only")}>{item.label}</span>
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
			items={[
				{ value: "albums", label: "Albums", icon: <Disc3 /> },
				{ value: "songs", label: "Songs", icon: <ListMusic /> },
				{ value: "artists", label: "Artists", icon: <Mic2 /> },
			]}
		/>
	);
}
