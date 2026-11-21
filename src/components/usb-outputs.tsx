import { Check } from "lucide-react";
import { Hint } from "#/components/ui/hint.tsx";
import type { UsbOutputs } from "#/lib/api.ts";
import { USB_OUTPUTS } from "#/lib/usb-outputs.ts";
import { cn } from "#/lib/utils.ts";

/**
 * The formats the export writes, each for the players that read it: a row of pills that switch
 * on and off, each explaining itself on hover. Remembered for the drive with the export.
 */
export function UsbOutputsPicker({
	outputs,
	onChange,
}: {
	outputs: UsbOutputs;
	onChange: (outputs: UsbOutputs) => void;
}) {
	return (
		<fieldset className="flex flex-wrap items-center gap-1.5">
			<legend className="sr-only">Formats to write</legend>
			{USB_OUTPUTS.map((option) => {
				const on = outputs[option.key];
				return (
					<Hint key={option.key} label={`${option.title}. ${option.detail}`} side="bottom">
						<button
							type="button"
							role="switch"
							aria-checked={on}
							aria-label={option.title}
							onClick={() => onChange({ ...outputs, [option.key]: !on })}
							className={cn(
								"flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
								on
									? "border-primary/40 bg-primary/15 text-foreground"
									: "text-muted-foreground hover:bg-muted",
							)}
						>
							{on ? (
								<Check className="size-3.5 text-primary" />
							) : (
								<option.icon className="size-3.5" />
							)}
							{option.name}
						</button>
					</Hint>
				);
			})}
		</fieldset>
	);
}
