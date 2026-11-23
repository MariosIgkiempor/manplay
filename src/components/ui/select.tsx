import {
	SelectContent,
	SelectItem,
	SelectItemIndicator,
	SelectItemText,
	SelectList,
	Select as SelectPrimitive,
	SelectTrigger,
	SelectValue,
} from "@ui-sdk/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import { keepListKeys, popupContainer } from "#/components/ui/popup.tsx";
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
		<SelectPrimitive
			value={value}
			items={options.map((o) => ({ value: o.value, label: o.label }))}
			modal
			container={popupContainer()}
			onValueChange={(next: string | null) => {
				if (next !== null) {
					onChange(next);
				}
			}}
		>
			<SelectTrigger
				{...(id === undefined ? {} : { id })}
				aria-label={label}
				className={cn(pickerTrigger, className)}
			>
				<span className="truncate">
					<SelectValue />
				</span>
				<ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
			</SelectTrigger>
			<SelectContent
				sideOffset={4}
				align="start"
				alignItemWithTrigger={false}
				onKeyDown={keepListKeys}
				className={pickerPopup}
			>
				<SelectList className="max-h-72 overflow-y-auto">
					{options.map((o) => (
						<SelectItem
							key={o.value}
							value={o.value}
							label={o.label}
							data-hint={o.hint}
							className={pickerItem}
						>
							<SelectItemText className="flex-1 truncate">{o.label}</SelectItemText>
							<SelectItemIndicator className="text-primary">
								<Check className="size-3.5" />
							</SelectItemIndicator>
						</SelectItem>
					))}
				</SelectList>
			</SelectContent>
		</SelectPrimitive>
	);
}
