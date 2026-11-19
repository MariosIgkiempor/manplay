import { Menu } from "@base-ui/react/menu";
import { Check, Ellipsis } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "#/components/ui/button.tsx";
import { menuItem, popup } from "#/lib/menu-styles.ts";
import { cn } from "#/lib/utils.ts";

/** One row of a header's `⋯` menu. With `checked` it is an on/off option. */
export interface HeaderMenuItem {
	label: string;
	icon?: ReactNode;
	onSelect: () => void;
	destructive?: boolean;
	disabled?: boolean;
	checked?: boolean;
	/** Hover text, e.g. why it is disabled. */
	hint?: string;
}

/** A row, a line between groups, or nothing (so callers can write `cond && {...}`). */
export type HeaderMenuEntry = HeaderMenuItem | "separator" | false | null | undefined;

/** The entries to draw: a line only between two groups of rows. */
function shown(entries: readonly HeaderMenuEntry[]): (HeaderMenuItem | "separator")[] {
	const out: (HeaderMenuItem | "separator")[] = [];
	for (const e of entries) {
		if (e === "separator") {
			if (out.length > 0 && out.at(-1) !== "separator") {
				out.push(e);
			}
		} else if (e) {
			out.push(e);
		}
	}
	if (out.at(-1) === "separator") {
		out.pop();
	}
	return out;
}

/**
 * The `⋯` button at the end of a page header's buttons: everything but the page's main action.
 * Renders nothing when no entry is shown.
 */
export function HeaderMenu({
	entries,
	label = "More actions",
	size = "default",
}: {
	entries: readonly HeaderMenuEntry[];
	label?: string;
	size?: "default" | "sm";
}) {
	const rows = shown(entries);
	if (rows.length === 0) {
		return null;
	}
	return (
		<Menu.Root>
			<Menu.Trigger
				render={
					<Button
						variant="outline"
						size={size === "sm" ? "icon-sm" : "icon"}
						aria-label={label}
						title={label}
					/>
				}
			>
				<Ellipsis />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner sideOffset={6} align="end" className="z-50">
					<Menu.Popup className={popup}>
						{rows.map((row, n) =>
							row === "separator" ? (
								<Menu.Separator
									// biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity of their own
									key={`sep-${n}`}
									className="-mx-1 my-1 h-px bg-border"
								/>
							) : row.checked === undefined ? (
								<Menu.Item
									key={row.label}
									title={row.hint}
									disabled={row.disabled ?? false}
									onClick={row.onSelect}
									className={cn(menuItem, row.destructive && "text-destructive")}
								>
									{row.icon}
									{row.label}
								</Menu.Item>
							) : (
								<Menu.CheckboxItem
									key={row.label}
									title={row.hint}
									disabled={row.disabled ?? false}
									checked={row.checked}
									onCheckedChange={row.onSelect}
									className={menuItem}
								>
									<Menu.CheckboxItemIndicator keepMounted className="data-[unchecked]:invisible">
										<Check />
									</Menu.CheckboxItemIndicator>
									{row.label}
								</Menu.CheckboxItem>
							),
						)}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
