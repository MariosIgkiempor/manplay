import { ContextMenu } from "@base-ui/react/context-menu";
import { Check, ChevronRight, Plus } from "lucide-react";
import { type ComponentType, useRef, useState } from "react";

const popup =
	"z-50 min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground text-sm shadow-lg outline-none";
const menuItem =
	"flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-muted";

export interface SearchItem {
	name: string;
	count: number;
	/** Already applied to everything the menu acts on. */
	checked: boolean;
}

interface Props {
	label: string;
	icon: ComponentType<{ className?: string }>;
	items: readonly SearchItem[];
	placeholder: string;
	emptyHint: string;
	/** Called with an existing item's name, or a new name to create. The menu stays open. */
	onPick: (name: string, isNew: boolean) => void;
}

/**
 * Context-menu submenu with a search box: type to filter existing items or create a new one.
 * Picking never closes the menu, so several items can be applied in a row.
 */
export function SearchSubmenu({ label, icon: Icon, items, placeholder, emptyHint, onPick }: Props) {
	const [query, setQuery] = useState("");
	// Names picked during this menu session show a check straight away.
	const [done, setDone] = useState<ReadonlySet<string>>(new Set());
	const input = useRef<HTMLInputElement>(null);

	const q = query.trim();
	const lower = q.toLowerCase();
	const matches = items.filter((t) => t.name.toLowerCase().includes(lower));
	const exact = items.find((t) => t.name.toLowerCase() === lower);

	const pick = (name: string, isNew: boolean) => {
		setDone((prev) => new Set(prev).add(name.toLowerCase()));
		onPick(name, isNew);
		setQuery("");
		input.current?.focus();
	};
	const onEnter = () => {
		const target = exact ?? matches[0];
		if (target) {
			pick(target.name, false);
		} else if (q !== "") {
			pick(q, true);
		}
	};

	return (
		<ContextMenu.SubmenuRoot
			onOpenChange={(open) => {
				if (open) {
					requestAnimationFrame(() => input.current?.focus());
				} else {
					setQuery("");
					setDone(new Set());
				}
			}}
		>
			<ContextMenu.SubmenuTrigger className={`${menuItem} w-full justify-between`}>
				<span className="flex items-center gap-2">
					<Icon className="size-4" /> {label}
				</span>
				<ChevronRight className="size-4" />
			</ContextMenu.SubmenuTrigger>
			<ContextMenu.Portal>
				<ContextMenu.Positioner className="z-50" sideOffset={4}>
					<ContextMenu.Popup className={`${popup} w-56`}>
						<input
							ref={input}
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => {
								// Typing must not trigger the menu's own typeahead / navigation.
								if (e.key !== "Escape" && e.key !== "ArrowDown" && e.key !== "ArrowUp") {
									e.stopPropagation();
								}
								if (e.key === "Enter") {
									e.preventDefault();
									onEnter();
								}
							}}
							placeholder={placeholder}
							aria-label={placeholder}
							className="mb-1 h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:border-ring"
						/>
						<div className="max-h-64 overflow-y-auto">
							{matches.map((t) => (
								<ContextMenu.Item
									key={t.name}
									className={menuItem}
									closeOnClick={false}
									onClick={() => pick(t.name, false)}
								>
									<span className="flex size-4 items-center justify-center">
										{(t.checked || done.has(t.name.toLowerCase())) && (
											<Check className="size-4 text-primary" />
										)}
									</span>
									<span className="flex-1 truncate">{t.name}</span>
									<span className="text-muted-foreground text-xs">{t.count}</span>
								</ContextMenu.Item>
							))}
							{q !== "" && !exact && (
								<ContextMenu.Item
									className={menuItem}
									closeOnClick={false}
									onClick={() => pick(q, true)}
								>
									<Plus className="size-4 text-primary" />
									<span className="truncate">Create “{q}”</span>
								</ContextMenu.Item>
							)}
							{items.length === 0 && q === "" && (
								<div className="px-2 py-1.5 text-muted-foreground">{emptyHint}</div>
							)}
						</div>
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.SubmenuRoot>
	);
}
