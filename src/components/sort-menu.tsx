import { Menu } from "@base-ui/react/menu";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Check } from "lucide-react";
import { menuItem, popup } from "#/lib/menu-styles.ts";
import type { ListSort, SortOption } from "#/lib/sorting.ts";
import { cn } from "#/lib/utils.ts";

const groupLabel = "px-2 pt-1.5 pb-1 text-muted-foreground text-xs";

/** What a list is sorted by, as a button that opens the choices and the direction. */
export function SortMenu<K extends string>({
	options,
	value,
	onChange,
	className,
}: {
	options: readonly SortOption<K>[];
	value: ListSort<K>;
	onChange: (sort: ListSort<K>) => void;
	className?: string;
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
				title={`Sorted by ${current.label.toLowerCase()}, ${direction.toLowerCase()}`}
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
					<Menu.Popup className={popup}>
						<Menu.Group>
							<Menu.GroupLabel className={groupLabel}>Sort by</Menu.GroupLabel>
							<Menu.RadioGroup
								value={value.key}
								onValueChange={(key: K) => {
									const option = options.find((o) => o.key === key);
									onChange({ key, desc: option?.desc ?? false });
								}}
							>
								{options.map((o) => (
									<Menu.RadioItem key={o.key} value={o.key} className={menuItem} closeOnClick>
										<Indicator />
										{o.label}
									</Menu.RadioItem>
								))}
							</Menu.RadioGroup>
						</Menu.Group>
						<Menu.Separator className="-mx-1 my-1 h-px bg-border" />
						<Menu.RadioGroup
							value={value.desc ? "desc" : "asc"}
							onValueChange={(d: string) => onChange({ key: value.key, desc: d === "desc" })}
						>
							<Menu.RadioItem value="asc" className={menuItem} closeOnClick>
								<Indicator />
								{current.directions[0]}
							</Menu.RadioItem>
							<Menu.RadioItem value="desc" className={menuItem} closeOnClick>
								<Indicator />
								{current.directions[1]}
							</Menu.RadioItem>
						</Menu.RadioGroup>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

function Indicator() {
	return (
		<span className="flex size-4 items-center justify-center">
			<Menu.RadioItemIndicator>
				<Check />
			</Menu.RadioItemIndicator>
		</span>
	);
}
