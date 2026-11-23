import { MenuItemIndicator, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@ui-sdk/react/menu";
import { Check, ChevronsUpDown, type LucideIcon } from "lucide-react";
import { MenuPopup, MenuRoot } from "#/components/ui/popup.tsx";
import { pickerItem, pickerPopup, pickerTrigger } from "#/lib/menu-styles.ts";
import { cn } from "#/lib/utils.ts";

export interface PickerOption<T extends string> {
	value: T;
	label: string;
	icon: LucideIcon;
}

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
		<MenuRoot>
			<MenuTrigger aria-label={label} className={cn(pickerTrigger, className)}>
				{Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
				<span className="truncate">{current?.label}</span>
				<ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
			</MenuTrigger>
			<MenuPopup sideOffset={4} align="start" className={pickerPopup}>
				<MenuRadioGroup value={value} onValueChange={(v: string) => onChange(v as T)}>
					{options.map((o) => (
						<MenuRadioItem key={o.value} value={o.value} className={pickerItem} closeOnSelect>
							<o.icon className="size-3.5 shrink-0 text-muted-foreground" />
							<span className="flex-1">{o.label}</span>
							<MenuItemIndicator className="text-primary">
								<Check className="size-3.5" />
							</MenuItemIndicator>
						</MenuRadioItem>
					))}
				</MenuRadioGroup>
			</MenuPopup>
		</MenuRoot>
	);
}
