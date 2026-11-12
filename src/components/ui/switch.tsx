import { cn } from "#/lib/utils.ts";

/** On/off toggle. */
export function Switch({
	checked,
	onChange,
	label,
	disabled,
}: {
	checked: boolean;
	onChange: (on: boolean) => void;
	label: string;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50",
				checked ? "bg-primary" : "bg-muted-foreground/30",
			)}
		>
			<span
				className={cn(
					"size-4 rounded-full bg-background shadow-sm transition-transform",
					checked ? "translate-x-[1.125rem]" : "translate-x-0.5",
				)}
			/>
		</button>
	);
}
