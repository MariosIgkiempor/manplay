import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

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
		<Tooltip.Root>
			<Tooltip.Trigger delay={150} closeDelay={0} render={children} />
			<Tooltip.Portal>
				<Tooltip.Positioner side={side} sideOffset={6} className="z-50">
					<Tooltip.Popup className="max-w-64 rounded-md border bg-popover px-2 py-1 text-popover-foreground text-xs shadow-md transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
						{label}
					</Tooltip.Popup>
				</Tooltip.Positioner>
			</Tooltip.Portal>
		</Tooltip.Root>
	);
}
