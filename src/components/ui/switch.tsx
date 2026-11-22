import { Switch as SwitchPrimitive, SwitchThumb } from "@ui-sdk/react/switch";
import { cn } from "#/lib/utils.ts";

/** On/off toggle. Behaviour (keyboard, ARIA, form value) comes from UI SDK; the look is ours. */
export function Switch({
	checked,
	onChange,
	label,
	disabled = false,
	id,
}: {
	checked: boolean;
	onChange: (on: boolean) => void;
	label: string;
	disabled?: boolean;
	id?: string;
}) {
	return (
		<SwitchPrimitive
			{...(id === undefined ? {} : { id })}
			checked={checked}
			onCheckedChange={(on) => onChange(on)}
			aria-label={label}
			disabled={disabled}
			className={cn(
				"relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-white/10 bg-white/10 transition-colors",
				"outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
				"data-checked:border-primary/60 data-checked:bg-primary",
				"data-disabled:cursor-default data-disabled:opacity-50",
			)}
		>
			<SwitchThumb
				className={cn(
					"size-3.5 translate-x-0.5 rounded-full bg-foreground/85 shadow-sm transition-transform motion-reduce:transition-none",
					"data-checked:translate-x-[1.125rem] data-checked:bg-primary-foreground",
				)}
			/>
		</SwitchPrimitive>
	);
}
