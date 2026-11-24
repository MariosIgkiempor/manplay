import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import {
	HINT_FRAME,
	HINT_SURFACE,
	HintCard,
	hintHasDetail,
	TextHint,
} from "#/components/ui/bubble.tsx";
import { popupContainer } from "#/components/ui/popup.tsx";
import { cn } from "#/lib/utils.ts";

/**
 * A hover and focus hint for an icon or figure whose meaning is not written next to it, where a
 * `data-hint` will not do (the hint has parts, or must follow its own element). It looks as every
 * hint does: `label` alone is a few words in a small well; with `detail` it is a title over a
 * well, in a frame.
 */
export function Hint({
	label,
	detail,
	children,
	side = "top",
}: {
	/** A few words, or a sentence that is laid out as a written hint is. */
	label: ReactNode;
	/** What else there is to know, under the label. */
	detail?: ReactNode;
	/** One element that takes a ref, such as a span or button. */
	children: ReactElement;
	side?: "top" | "bottom" | "left" | "right";
}) {
	const written = typeof label === "string" && detail === undefined ? label : null;
	const framed = written === null ? detail !== undefined : hintHasDetail(written);
	return (
		<Tooltip delay={150} closeDelay={0}>
			<TooltipTrigger render={children} />
			<TooltipContent
				side={side}
				sideOffset={6}
				container={popupContainer()}
				className={cn(
					framed ? HINT_FRAME : HINT_SURFACE,
					"transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
				)}
			>
				{written === null ? (
					<HintCard title={label}>{detail}</HintCard>
				) : (
					<TextHint text={written} />
				)}
			</TooltipContent>
		</Tooltip>
	);
}
