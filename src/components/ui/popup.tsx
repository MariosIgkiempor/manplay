import { Menu, MenuContent, type MenuProps } from "@ui-sdk/react/menu";
import { PopoverContent } from "@ui-sdk/react/popover";
import { type ComponentProps, type KeyboardEvent, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Where every popup renders: on the body, outside the trigger's own markup, so a popup takes no
 * text styles from where its trigger sits and never lands inside a table row or a button.
 */
export function popupContainer(): HTMLElement | null {
	return typeof document === "undefined" ? null : document.body;
}

/**
 * Covers the page while a menu is open, so nothing behind the menu shows a hover state or takes a
 * press: a press on the cover only closes the menu. The button that opened the menu stays
 * uncovered, so it keeps its hover look and a second press on it closes the menu.
 */
function MenuCover({ trigger }: { trigger: Element | null }) {
	const [clip, setClip] = useState<string | undefined>(undefined);
	useLayoutEffect(() => {
		if (!trigger) {
			return;
		}
		const box = trigger.getBoundingClientRect();
		const corners = [
			[box.left, box.top],
			[box.right, box.top],
			[box.right, box.bottom],
			[box.left, box.bottom],
			[box.left, box.top],
		]
			.map(([x, y]) => `${x}px ${y}px`)
			.join(", ");
		setClip(`polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${corners})`);
	}, [trigger]);
	return (
		<div
			role="presentation"
			className="fixed inset-0 z-50"
			style={clip === undefined ? undefined : { clipPath: clip }}
		/>
	);
}

/**
 * A menu opened from a button or a right-click. Modal by default: while it is open the page
 * behind it shows no hover states, and a press outside only closes it.
 */
export function MenuRoot({
	modal = true,
	open,
	onOpenChange,
	...props
}: Omit<MenuProps, "modal"> & { modal?: boolean }) {
	const [opened, setOpened] = useState(false);
	const [trigger, setTrigger] = useState<Element | null>(null);
	const shown = open ?? opened;
	const body = popupContainer();
	return (
		<>
			<Menu
				// UI SDK's fully modal menu leaves usable every part of the page that holds a live
				// region, and makes the cover inert too, so the cover does that job instead.
				modal={modal ? "pointer" : false}
				{...(open === undefined ? {} : { open })}
				onOpenChange={(next, details) => {
					onOpenChange?.(next, details);
					if (details.canceled) {
						return;
					}
					setOpened(next);
					if (next) {
						const target = details.event?.target;
						// A menu button announces its menu; a right-click area does not, and stays covered.
						setTrigger(target instanceof Element ? target.closest('[aria-haspopup="menu"]') : null);
					}
				}}
				{...props}
			/>
			{modal && shown && body && createPortal(<MenuCover trigger={trigger} />, body)}
		</>
	);
}

/** Keys a list popup moves through or closes with; anything else may still reach the page. */
const LIST_KEYS = new Set([
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"Escape",
]);

/**
 * Keeps a list popup's own keys (arrows, Home, End, Escape and typed letters, which jump to an
 * item) from reaching the page behind it, so the page's shortcuts do not act on them as well.
 */
export function keepListKeys(event: KeyboardEvent) {
	const typed = event.key.length === 1 && event.key !== " ";
	const chord = event.metaKey || event.ctrlKey || event.altKey;
	if (LIST_KEYS.has(event.key) || (typed && !chord)) {
		event.stopPropagation();
	}
}

/** A menu's list of items, drawn on the body. */
export function MenuPopup({ onKeyDown, ...props }: ComponentProps<typeof MenuContent>) {
	return (
		<MenuContent
			container={popupContainer()}
			onKeyDown={(event) => {
				onKeyDown?.(event);
				keepListKeys(event);
			}}
			{...props}
		/>
	);
}

/**
 * A right-click menu's list of items, drawn on the body. It opens just right of the pointer, its
 * first item level with it.
 */
export function ContextMenuPopup(props: ComponentProps<typeof MenuContent>) {
	return <MenuPopup side="bottom" align="start" sideOffset={-5} alignOffset={2} {...props} />;
}

/** A popover's panel, drawn on the body. Escape closes it and goes no further. */
export function PopoverPopup({ onKeyDown, ...props }: ComponentProps<typeof PopoverContent>) {
	return (
		<PopoverContent
			container={popupContainer()}
			onKeyDown={(event) => {
				onKeyDown?.(event);
				if (event.key === "Escape") {
					event.stopPropagation();
				}
			}}
			{...props}
		/>
	);
}
