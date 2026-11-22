import type { ComponentProps, ReactNode } from "react";
import { Bubble } from "#/components/ui/bubble.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useTwoPress } from "#/lib/two-press.ts";
import { cn } from "#/lib/utils.ts";

type ButtonProps = ComponentProps<typeof Button>;
type ButtonSize = NonNullable<ButtonProps["size"]>;

/** An icon-only button has no room for the confirm label, so armed it takes the text size beside it. */
const ARMED_SIZE: Partial<Record<ButtonSize, ButtonSize>> = {
	icon: "default",
	"icon-xs": "xs",
	"icon-sm": "sm",
	"icon-lg": "lg",
};

function armedSize(size: ButtonProps["size"]): ButtonProps["size"] {
	return (size && ARMED_SIZE[size]) ?? size;
}

/** Armed colours outrank whatever the button wears at rest (a tint, a red outline, red text). */
const ARMED_COLOUR = {
	destructive:
		"border-transparent! bg-destructive! text-white! ring-3 ring-destructive/30 hover:bg-destructive/90!",
	plain:
		"border-transparent! bg-primary! text-primary-foreground! ring-3 ring-primary/30 hover:bg-primary/85!",
};

/**
 * A button for an action worth a second thought, in place of a confirmation dialog. The first
 * press arms it: it changes colour, its label becomes `confirmLabel`, and `consequence` shows
 * beside it. The second press does the action. Pressing anywhere else, Escape or waiting puts it
 * back.
 */
export function ConfirmButton({
	confirmLabel,
	consequence,
	destructive = false,
	onConfirm,
	children,
	className,
	size = "default",
	style,
	...props
}: Omit<ButtonProps, "onClick"> & {
	/** What the button says once armed: the action in a word or two. */
	confirmLabel: ReactNode;
	/** What the action does, shown beside the armed button. */
	consequence?: ReactNode;
	destructive?: boolean;
	onConfirm: () => void;
}) {
	const { armed, press, element, setElement } = useTwoPress(onConfirm);
	return (
		<>
			<Button
				{...props}
				ref={setElement}
				size={armed ? armedSize(size) : size}
				data-armed={armed || undefined}
				// Never narrower armed than at rest, so it does not slip from under the pointer.
				style={armed && element ? { ...style, minWidth: element.offsetWidth } : style}
				className={cn(
					className,
					"motion-reduce:transition-none",
					armed && ARMED_COLOUR[destructive ? "destructive" : "plain"],
				)}
				{...(armed ? { "data-hint": undefined } : {})}
				onClick={press}
			>
				<span
					key={armed ? "armed" : "rest"}
					className={cn(
						"inline-flex items-center gap-[inherit]",
						armed &&
							"fade-in-0 slide-in-from-bottom-1 animate-in duration-150 motion-reduce:animate-none",
					)}
				>
					{armed ? confirmLabel : children}
				</span>
			</Button>
			{armed && element && consequence && (
				<Bubble anchor={element} role="status" className="max-w-72 px-2.5 py-1.5">
					{consequence}
				</Bubble>
			)}
		</>
	);
}
