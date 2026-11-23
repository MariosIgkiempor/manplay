import { MenuItem, MenuSub, MenuSubContent, MenuSubTrigger } from "@ui-sdk/react/menu";
import { Check, ChevronRight, Plus } from "lucide-react";
import { type ComponentType, useCallback, useRef, useState } from "react";
import { menuItem, popup, submenuTrigger } from "#/lib/menu-styles.ts";

export interface SearchItem {
	name: string;
	count: number;
	/** Already applied to everything the menu acts on. */
	checked: boolean;
	/** Nesting level; shown indented with `label` while nothing is typed. */
	depth?: number;
	/** Short name for the nested view (defaults to `name`). */
	label?: string;
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
	// The submenu's content mounts as it opens; the field takes focus a frame later. Stable, so a
	// re-render does not pull focus back from an item the arrow keys moved to.
	const focusOnMount = useCallback((element: HTMLInputElement | null) => {
		input.current = element;
		if (element) {
			requestAnimationFrame(() => element.focus());
		}
	}, []);

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
		<MenuSub
			onOpenChange={(open) => {
				if (!open) {
					setQuery("");
					setDone(new Set());
				}
			}}
		>
			<MenuSubTrigger className={`${submenuTrigger} w-full justify-between`}>
				<span className="flex items-center gap-2">
					<Icon className="size-4" /> {label}
				</span>
				<ChevronRight className="size-4" />
			</MenuSubTrigger>
			<MenuSubContent align="start" sideOffset={4} alignOffset={0} className={`${popup} w-56`}>
				<input
					ref={focusOnMount}
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
						<MenuItem
							key={t.name}
							className={menuItem}
							closeOnSelect={false}
							onSelect={() => pick(t.name, false)}
						>
							<span className="flex size-4 items-center justify-center">
								{(t.checked || done.has(t.name.toLowerCase())) && (
									<Check className="size-4 text-primary" />
								)}
							</span>
							<span
								className="flex-1 truncate"
								data-hint={t.name}
								style={q === "" && t.depth ? { paddingLeft: `${t.depth * 12}px` } : undefined}
							>
								{q === "" ? (t.label ?? t.name) : t.name}
							</span>
							<span className="text-muted-foreground text-xs">{t.count}</span>
						</MenuItem>
					))}
					{q !== "" && !exact && (
						<MenuItem className={menuItem} closeOnSelect={false} onSelect={() => pick(q, true)}>
							<Plus className="size-4 text-primary" />
							<span className="truncate">Create “{q}”</span>
						</MenuItem>
					)}
					{items.length === 0 && q === "" && (
						<div className="px-2 py-1.5 text-muted-foreground">{emptyHint}</div>
					)}
				</div>
			</MenuSubContent>
		</MenuSub>
	);
}
