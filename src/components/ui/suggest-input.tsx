import {
	Autocomplete,
	AutocompleteContent,
	AutocompleteEmpty,
	AutocompleteInput,
	AutocompleteItem,
	AutocompleteList,
} from "@ui-sdk/react/autocomplete";
import { type ComponentProps, useState } from "react";
import { popupContainer } from "#/components/ui/popup.tsx";
import { cn } from "#/lib/utils.ts";

type NativeInputProps = Omit<
	ComponentProps<"input">,
	"value" | "onChange" | "list" | "defaultValue" | "children" | "readOnly" | "className" | "style"
> & { className?: string | undefined };

const SUGGESTION_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End"]);

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
	onKeyDown,
	...inputProps
}: NativeInputProps & {
	value: string;
	onValueChange: (value: string) => void;
	suggestions: readonly string[];
}) {
	const [open, setOpen] = useState(false);
	return (
		<Autocomplete
			value={value}
			modal={false}
			container={popupContainer()}
			onOpenChange={(next, details) => {
				if (!details.canceled) {
					setOpen(next);
				}
			}}
			onValueChange={(next) => onValueChange(next)}
		>
			<AutocompleteInput
				{...(className === undefined ? {} : { className })}
				{...inputProps}
				onKeyDown={(event) => {
					onKeyDown?.(event);
					// While suggestions show, the keys that move through them stay with the field.
					if (open && SUGGESTION_KEYS.has(event.key)) {
						event.stopPropagation();
					}
					// Escape closes the suggestions; pressed again with them closed, it empties the field.
					if (event.key === "Escape" && !open && !event.defaultPrevented && value !== "") {
						onValueChange("");
					}
				}}
			/>
			<AutocompleteContent
				sideOffset={4}
				align="start"
				// The popup is a React child of its field, which may sit in a clickable row.
				onClick={(e) => e.stopPropagation()}
				onDoubleClick={(e) => e.stopPropagation()}
				onContextMenu={(e) => e.stopPropagation()}
				className="card-surface max-w-(--available-width) min-w-(--anchor-width) p-0 has-[[data-empty]]:hidden"
			>
				<AutocompleteEmpty />
				<AutocompleteList className="max-h-56 overflow-y-auto p-1 outline-none">
					{suggestions.map((suggestion) => (
						<AutocompleteItem
							key={suggestion}
							value={suggestion}
							className={cn(
								"flex cursor-pointer items-center rounded-md px-2 py-1 text-sm outline-none",
								"data-[highlighted]:bg-muted",
							)}
						>
							<span className="truncate">{suggestion}</span>
						</AutocompleteItem>
					))}
				</AutocompleteList>
			</AutocompleteContent>
		</Autocomplete>
	);
}
