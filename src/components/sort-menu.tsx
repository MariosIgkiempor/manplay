import { Menu } from "@base-ui/react/menu";
import {
	Activity,
	ArrowDownWideNarrow,
	ArrowUpNarrowWide,
	CalendarDays,
	CalendarPlus,
	Check,
	Clock,
	Disc3,
	KeyRound,
	ListMusic,
	ListOrdered,
	Mic2,
	Type,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ListSort, SortOption } from "#/lib/sorting.ts";
import { cn } from "#/lib/utils.ts";

/** An icon for each way of sorting, matching the icons the values have elsewhere. */
const ICONS: Record<string, ReactNode> = {
	list: <ListOrdered />,
	title: <Type />,
	name: <Mic2 />,
	artist: <Mic2 />,
	album: <Disc3 />,
	added: <CalendarPlus />,
	year: <CalendarDays />,
	bpm: <Activity />,
	key: <KeyRound />,
	duration: <Clock />,
	songs: <ListMusic />,
	albums: <Disc3 />,
};

const item =
	"flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted [&_svg]:size-4 [&_svg]:shrink-0";

/** What a list is sorted by, as a button that opens the choices and the direction. */
export function SortMenu<K extends string>({
	options,
	value,
	onChange,
	segment = false,
	className,
}: {
	options: readonly SortOption<K>[];
	value: ListSort<K>;
	onChange: (sort: ListSort<K>) => void;
	/** Shown as one segment of a page header's button group, sized and outlined like its buttons. */
	segment?: boolean;
	className?: string | undefined;
}) {
	const current = options.find((o) => o.key === value.key) ?? options[0];
	if (!current) {
		return null;
	}
	const direction = current.directions[value.desc ? 1 : 0];
	const Arrow = value.desc ? ArrowDownWideNarrow : ArrowUpNarrowWide;
	return (
		<Menu.Root>
			<Menu.Trigger
				{...(segment ? { "data-slot": "button", "data-variant": "outline" } : {})}
				data-hint={`Sorted by ${current.label.toLowerCase()}, ${direction.toLowerCase()}`}
				className={cn(
					"flex h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[popup-open]:bg-muted data-[popup-open]:text-foreground [&_svg]:size-3.5",
					className,
				)}
			>
				<Arrow />
				{current.label}
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner sideOffset={4} align="end" className="z-50">
					<Menu.Popup className="w-60 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
						<Menu.RadioGroup
							value={value.key}
							onValueChange={(key: K) => {
								const option = options.find((o) => o.key === key);
								onChange({ key, desc: option?.desc ?? false });
							}}
						>
							{options.map((o) => (
								<Menu.RadioItem key={o.key} value={o.key} className={item} closeOnClick>
									<span className="text-muted-foreground">{ICONS[o.key]}</span>
									<span className="flex-1">{o.label}</span>
									<Menu.RadioItemIndicator className="text-primary">
										<Check />
									</Menu.RadioItemIndicator>
								</Menu.RadioItem>
							))}
						</Menu.RadioGroup>
						{/* Direction, worded for the chosen sort; stays open so both can be set at once. */}
						<Menu.RadioGroup
							value={value.desc ? "desc" : "asc"}
							onValueChange={(d: string) => onChange({ key: value.key, desc: d === "desc" })}
							className="mt-1 grid grid-cols-2 gap-1 border-t px-1 pt-2 pb-1"
						>
							{(["asc", "desc"] as const).map((d, i) => {
								const Icon = d === "desc" ? ArrowDownWideNarrow : ArrowUpNarrowWide;
								return (
									<Menu.RadioItem
										key={d}
										value={d}
										closeOnClick={false}
										className={cn(
											"flex cursor-default items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-xs outline-none data-[highlighted]:bg-muted [&_svg]:size-3.5 [&_svg]:shrink-0",
											(d === "desc") === value.desc
												? "border-primary/40 bg-primary/10 text-foreground"
												: "border-transparent text-muted-foreground",
										)}
									>
										<Icon />
										<span className="truncate">{current.directions[i]}</span>
									</Menu.RadioItem>
								);
							})}
						</Menu.RadioGroup>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
