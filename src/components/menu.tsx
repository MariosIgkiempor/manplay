import {
	MenuContextTrigger,
	MenuItem,
	MenuSeparator as MenuSeparatorPart,
	MenuSub,
	MenuSubContent,
	MenuSubTrigger,
} from "@ui-sdk/react/menu";
import { ChevronRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { ContextMenuPopup, MenuRoot } from "#/components/ui/popup.tsx";
import { menuItem, popup, submenuTrigger } from "#/lib/menu-styles.ts";
import { keyLabel } from "#/lib/platform.ts";
import { cn } from "#/lib/utils.ts";

export interface MenuAction {
	label: string;
	icon?: ReactNode;
	onSelect: () => void;
	/** Shown faintly on the right, e.g. "F2". */
	shortcut?: string;
	destructive?: boolean;
	disabled?: boolean;
}

/** A row that opens more rows, e.g. "Move to". */
export interface MenuSubmenu {
	label: string;
	icon?: ReactNode;
	items: readonly MenuEntry[];
	disabled?: boolean;
}

/** A menu row, a line between groups, or nothing (so callers can write `cond && {...}`). */
export type MenuEntry = MenuAction | MenuSubmenu | "separator" | false | null | undefined;

type Shown = MenuAction | MenuSubmenu | "separator";

function Submenu({ entry }: { entry: MenuSubmenu }) {
	return (
		<MenuSub>
			<MenuSubTrigger className={cn(submenuTrigger, "w-full")} disabled={entry.disabled ?? false}>
				{entry.icon}
				{entry.label}
				<ChevronRight className="ml-auto text-muted-foreground" />
			</MenuSubTrigger>
			<MenuSubContent
				align="start"
				sideOffset={4}
				alignOffset={0}
				className={cn(popup, "max-h-80 overflow-y-auto")}
			>
				<MenuItems items={entry.items} />
			</MenuSubContent>
		</MenuSub>
	);
}

/** What the menu acts on, above its items. */
export function MenuLabel({ children }: { children: ReactNode }) {
	return (
		<div className="max-w-64 truncate px-2 py-1 text-muted-foreground text-xs">{children}</div>
	);
}

export function MenuSeparator() {
	return <MenuSeparatorPart className="-mx-1 my-1 h-px bg-border" />;
}

export function MenuItems({ items }: { items: readonly MenuEntry[] }) {
	const shown = items.filter((i): i is Shown => Boolean(i));
	return shown.map((item, n) => {
		if (item === "separator") {
			// Leading, trailing and doubled lines would only add noise.
			const prev = shown[n - 1];
			const next = shown[n + 1];
			return prev && prev !== "separator" && next && next !== "separator" ? (
				// biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity of their own
				<MenuSeparator key={`sep-${n}`} />
			) : null;
		}
		if ("items" in item) {
			return <Submenu key={item.label} entry={item} />;
		}
		return (
			<MenuItem
				key={item.label}
				className={cn(menuItem, item.destructive && "text-destructive")}
				disabled={item.disabled ?? false}
				onSelect={() => item.onSelect()}
			>
				{item.icon}
				{item.label}
				{item.shortcut && (
					<span className="ml-auto pl-4 text-muted-foreground text-xs">
						{keyLabel(item.shortcut)}
					</span>
				)}
			</MenuItem>
		);
	});
}

/** Right-click `children` for `items`. */
export function RowMenu({
	label,
	items,
	children,
	className,
	render,
}: {
	label?: ReactNode;
	items: readonly MenuEntry[];
	children: ReactNode;
	className?: string;
	/** The element the trigger renders as instead of a `div`, e.g. a `<tr />` in a table. */
	render?: ReactElement;
}) {
	return (
		<MenuRoot>
			<MenuContextTrigger
				{...(className === undefined ? {} : { className })}
				{...(render === undefined ? {} : { render })}
			>
				{children}
			</MenuContextTrigger>
			{/* Focus stays where the chosen item put it, e.g. in a rename field it opened. */}
			<ContextMenuPopup className={popup} finalFocus="none">
				{label && <MenuLabel>{label}</MenuLabel>}
				<MenuItems items={items} />
			</ContextMenuPopup>
		</MenuRoot>
	);
}
