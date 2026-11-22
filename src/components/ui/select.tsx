import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import { pickerItem, pickerPopup, pickerTrigger } from "#/lib/menu-styles.ts";
import { cn } from "#/lib/utils.ts";

export interface SelectOption {
	value: string;
	label: string;
	/** Hover hint on the option, for detail that does not fit its label. */
	hint?: string;
}

/**
 * Picks one value out of a list of text options; the app's own replacement for a native
 * `<select>`, drawn like `Picker` but without icons. Give `id` to wire a `<label htmlFor>`.
 */
export function Select({
	id,
	value,
	options,
	onChange,
	label,
	className,
}: {
	id?: string;
	value: string;
	options: readonly SelectOption[];
	onChange: (value: string) => void;
	/** Accessible name, when no `<label htmlFor>` names the control. */
	label?: string;
	className?: string;
}) {
	return (
		<SelectPrimitive.Root
			id={id}
			value={value}
			items={options}
			onValueChange={(next) => typeof next === "string" && onChange(next)}
		>
			<SelectPrimitive.Trigger aria-label={label} className={cn(pickerTrigger, className)}>
				<span className="truncate">
					<SelectPrimitive.Value />
				</span>
				<ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
			</SelectPrimitive.Trigger>
			<SelectPrimitive.Portal>
				<SelectPrimitive.Positioner
					sideOffset={4}
					align="start"
					alignItemWithTrigger={false}
					className="z-50"
				>
					<SelectPrimitive.Popup className={pickerPopup}>
						<SelectPrimitive.List className="max-h-72 overflow-y-auto">
							{options.map((o) => (
								<SelectPrimitive.Item
									key={o.value}
									value={o.value}
									data-hint={o.hint}
									className={pickerItem}
								>
									<SelectPrimitive.ItemText className="flex-1 truncate">
										{o.label}
									</SelectPrimitive.ItemText>
									<SelectPrimitive.ItemIndicator className="text-primary">
										<Check className="size-3.5" />
									</SelectPrimitive.ItemIndicator>
								</SelectPrimitive.Item>
							))}
						</SelectPrimitive.List>
					</SelectPrimitive.Popup>
				</SelectPrimitive.Positioner>
			</SelectPrimitive.Portal>
		</SelectPrimitive.Root>
	);
}
