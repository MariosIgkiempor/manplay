import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { popupContainer } from "#/components/ui/popup.tsx";

/**
 * A short hover and focus hint for an icon or figure whose meaning is not written next to it.
 * Shows quickly, unlike the browser's `title`.
 */
export function Hint({
	label,
	children,
	side = "top",
}: {
	label: ReactNode;
	/** One element that takes a ref, such as a span or button. */
	children: ReactElement;
	side?: "top" | "bottom" | "left" | "right";
}) {
	return (
		<Tooltip delay={150} closeDelay={0}>
			<TooltipTrigger render={children} />
			<TooltipContent
				side={side}
				sideOffset={6}
				container={popupContainer()}
				className="max-w-64 rounded-md border bg-popover px-2 py-1 text-popover-foreground text-xs shadow-md transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
			>
				{label}
			</TooltipContent>
		</Tooltip>
	);
}
