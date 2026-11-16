import { Menu } from "@base-ui/react/menu";
import { Check, ChevronsUpDown, type LucideIcon } from "lucide-react";
import { cn } from "#/lib/utils.ts";

export interface PickerOption<T extends string> {
	value: T;
	label: string;
	icon: LucideIcon;
}

const item =
	"flex cursor-default items-center gap-2 rounded-md py-1.5 pr-2 pl-2 text-sm outline-none data-[highlighted]:bg-muted";

/**
 * Picks one of a few options, each with an icon; drawn like the app's inputs so it sits in a row
 * of them. Used where a native select would look foreign.
 */
export function Picker<T extends string>({
	label,
	value,
	options,
	onChange,
	className,
}: {
	label: string;
	value: T;
	options: readonly PickerOption<T>[];
	onChange: (value: T) => void;
	className?: string;
}) {
	const current = options.find((o) => o.value === value) ?? options[0];
	const Icon = current?.icon;
	return (
		<Menu.Root>
			<Menu.Trigger
				aria-label={label}
				className={cn(
					"flex h-8 items-center gap-1.5 rounded-lg border border-input bg-transparent pr-2 pl-2.5 text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-[popup-open]:bg-muted/50 dark:bg-input/30",
					className,
				)}
			>
				{Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
				<span className="truncate">{current?.label}</span>
				<ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner sideOffset={4} align="start" className="z-50">
					<Menu.Popup className="min-w-(--anchor-width) rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
						<Menu.RadioGroup value={value} onValueChange={(v: string) => onChange(v as T)}>
							{options.map((o) => (
								<Menu.RadioItem key={o.value} value={o.value} className={item} closeOnClick>
									<o.icon className="size-3.5 shrink-0 text-muted-foreground" />
									<span className="flex-1">{o.label}</span>
									<Menu.RadioItemIndicator className="text-primary">
										<Check className="size-3.5" />
									</Menu.RadioItemIndicator>
								</Menu.RadioItem>
							))}
						</Menu.RadioGroup>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
