import { Autocomplete } from "@base-ui/react/autocomplete";
import type { ComponentProps } from "react";
import { cn } from "#/lib/utils.ts";

type NativeInputProps = Omit<
	ComponentProps<"input">,
	"value" | "onChange" | "list" | "defaultValue"
>;

/**
 * A text input that offers suggestions in the app's own popup while typing. Any text is allowed:
 * the suggestions only help. Replaces `<input list>` with a native `<datalist>`; every other
 * input prop (refs, key and blur handlers, aria labels, classes) goes to the input unchanged.
 */
export function SuggestInput({
	value,
	onValueChange,
	suggestions,
	className,
	...inputProps
}: NativeInputProps & {
	value: string;
	onValueChange: (value: string) => void;
	suggestions: readonly string[];
}) {
	return (
		<Autocomplete.Root
			items={suggestions}
			value={value}
			onValueChange={(next) => onValueChange(next)}
		>
			<Autocomplete.Input className={className} {...inputProps} />
			<Autocomplete.Portal>
				<Autocomplete.Positioner sideOffset={4} align="start" className="z-50 outline-none">
					<Autocomplete.Popup
						// The popup is a React child of its field, which may sit in a clickable row.
						onClick={(e) => e.stopPropagation()}
						onDoubleClick={(e) => e.stopPropagation()}
						onContextMenu={(e) => e.stopPropagation()}
						className="max-w-(--available-width) min-w-(--anchor-width) rounded-lg border bg-popover text-popover-foreground shadow-md has-[[data-empty]]:hidden"
					>
						<Autocomplete.List className="max-h-56 overflow-y-auto p-1 outline-none">
							{(suggestion: string) => (
								<Autocomplete.Item
									key={suggestion}
									value={suggestion}
									className={cn(
										"flex cursor-pointer items-center rounded-md px-2 py-1 text-sm outline-none",
										"data-[highlighted]:bg-muted",
									)}
								>
									<span className="truncate">{suggestion}</span>
								</Autocomplete.Item>
							)}
						</Autocomplete.List>
					</Autocomplete.Popup>
				</Autocomplete.Positioner>
			</Autocomplete.Portal>
		</Autocomplete.Root>
	);
}
