import { type ComponentProps, type ReactNode, useLayoutEffect, useRef } from "react";
import { Bubble, HintCard } from "#/components/ui/bubble.tsx";
import { Button } from "#/components/ui/button.tsx";
import { popMotion } from "#/lib/motion.ts";
import { useTwoPress } from "#/lib/two-press.ts";
import { cn } from "#/lib/utils.ts";

type ButtonProps = ComponentProps<typeof Button>;
type ButtonSize = NonNullable<ButtonProps["size"]>;

/** What every armed button says; what it is about to do heads the card beside it. */
export const ARMED_TEXT = "Are you sure?";

/** An icon-only button has no room for the question, so armed it takes the text size beside it. */
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
 * Eases `element` from its last width to its new one whenever `state` changes, so a button that
 * changes its words grows or shrinks into them instead of jumping.
 */
function useWidthMorph(element: HTMLElement | null, state: unknown) {
	const lastWidth = useRef<number | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `state` is what changes the width
	useLayoutEffect(() => {
		if (!element) {
			return;
		}
		const to = element.offsetWidth;
		const from = lastWidth.current;
		lastWidth.current = to;
		const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (from === null || from === to || still) {
			return;
		}
		const morph = element.animate([{ width: `${from}px` }, { width: `${to}px` }], popMotion());
		return () => morph.cancel();
	}, [element, state]);
}

/** The armed button's name: the question, and what it is about, which no longer shows on it. */
function armedNaming(confirmLabel: ReactNode) {
	return {
		"data-hint": undefined,
		"aria-label": typeof confirmLabel === "string" ? `${confirmLabel}: ${ARMED_TEXT}` : ARMED_TEXT,
	};
}

/** Beside the armed button: what it is about to do, and what that does. */
function ArmedCard({
	anchor,
	title,
	consequence,
}: {
	anchor: HTMLElement;
	title: ReactNode;
	consequence: ReactNode;
}) {
	const explained = consequence !== undefined && consequence !== null;
	return (
		<Bubble
			anchor={anchor}
			role="status"
			framed={explained}
			className={cn("max-w-80", !explained && "px-2.5 py-1.5 font-medium text-sm")}
		>
			<HintCard title={title} wide>
				{explained && consequence}
			</HintCard>
		</Bubble>
	);
}

/**
 * A button for an action worth a second thought, in place of a confirmation dialog. The first
 * press arms it: it changes colour and grows into "Are you sure?", and a card beside it says what
 * the action is (`confirmLabel`) and what it does (`consequence`). The second press does the
 * action. Pressing anywhere else, Escape or waiting puts it back.
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
	/** The action in a few words, heading the card while armed and naming the armed button. */
	confirmLabel: ReactNode;
	/** What the action does, in the card under `confirmLabel`; an `EffectList` reads best. */
	consequence?: ReactNode;
	destructive?: boolean;
	onConfirm: () => void;
}) {
	const { armed, press, element, setElement } = useTwoPress(onConfirm);
	useWidthMorph(element, armed);
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
					"overflow-hidden motion-reduce:transition-none",
					armed && ARMED_COLOUR[destructive ? "destructive" : "plain"],
				)}
				{...(armed ? armedNaming(confirmLabel) : {})}
				onClick={press}
			>
				<span
					key={armed ? "armed" : "rest"}
					className="fade-in-0 slide-in-from-bottom-2 inline-flex animate-in items-center gap-[inherit] duration-200 motion-reduce:animate-none"
				>
					{armed ? ARMED_TEXT : children}
				</span>
			</Button>
			{armed && element && (
				<ArmedCard anchor={element} title={confirmLabel} consequence={consequence} />
			)}
		</>
	);
}
