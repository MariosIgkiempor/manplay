import { ContextMenu } from "@base-ui/react/context-menu";
import { ChevronRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { menuItem, popup } from "#/lib/menu-styles.ts";
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
		<ContextMenu.SubmenuRoot>
			<ContextMenu.SubmenuTrigger
				className={cn(menuItem, "w-full")}
				disabled={entry.disabled ?? false}
			>
				{entry.icon}
				{entry.label}
				<ChevronRight className="ml-auto text-muted-foreground" />
			</ContextMenu.SubmenuTrigger>
			<ContextMenu.Portal>
				<ContextMenu.Positioner className="z-50" sideOffset={4}>
					<ContextMenu.Popup className={cn(popup, "max-h-80 overflow-y-auto")}>
						<MenuItems items={entry.items} />
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.SubmenuRoot>
	);
}

/** What the menu acts on, above its items. */
export function MenuLabel({ children }: { children: ReactNode }) {
	return (
		<div className="max-w-64 truncate px-2 py-1 text-muted-foreground text-xs">{children}</div>
	);
}

export function MenuSeparator() {
	return <ContextMenu.Separator className="-mx-1 my-1 h-px bg-border" />;
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
			<ContextMenu.Item
				key={item.label}
				className={cn(menuItem, item.destructive && "text-destructive")}
				disabled={item.disabled ?? false}
				onClick={item.onSelect}
			>
				{item.icon}
				{item.label}
				{item.shortcut && (
					<span className="ml-auto pl-4 text-muted-foreground text-xs">{item.shortcut}</span>
				)}
			</ContextMenu.Item>
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
		<ContextMenu.Root>
			<ContextMenu.Trigger className={className} render={render}>
				{children}
			</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Positioner className="z-50">
					{/* Focus stays where the chosen item put it, e.g. in a rename field it opened. */}
					<ContextMenu.Popup className={popup} finalFocus={false}>
						{label && <MenuLabel>{label}</MenuLabel>}
						<MenuItems items={items} />
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}
