import { GripVertical, X } from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useState } from "react";
import { joinNames, splitNames } from "#/lib/names.ts";
import { cn } from "#/lib/utils.ts";

export interface ComboOption {
	value: string;
	count?: number;
}

const MAX_SHOWN = 8;

/**
 * Searchable pick list over values already in the library. Free text is allowed. With `multi`,
 * each pick becomes a chip and the value is stored as `A; B` (see `names.ts`).
 */
export function TagCombobox({
	id,
	value,
	options,
	multi,
	placeholder,
	touched,
	onChange,
}: {
	id: string;
	value: string;
	options: readonly ComboOption[];
	multi: boolean;
	placeholder: string;
	touched: boolean;
	onChange: (value: string) => void;
}) {
	const listId = useId();
	const [text, setText] = useState("");
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const chips = useMemo(() => (multi ? splitNames(value) : []), [multi, value]);

	const matches = useMemo(() => {
		const chosen = new Set(chips.map((c) => c.toLowerCase()));
		const typed = text.trim().toLowerCase();
		return options
			.filter((o) => !chosen.has(o.value.toLowerCase()))
			.filter((o) => typed === "" || o.value.toLowerCase().includes(typed))
			.slice(0, MAX_SHOWN);
	}, [options, chips, text]);
	const typedNew = text.trim();
	const canAdd =
		typedNew !== "" && !options.some((o) => o.value.toLowerCase() === typedNew.toLowerCase());
	const rows: ComboOption[] = canAdd ? [...matches, { value: typedNew }] : matches;

	const commit = (picked: string) => {
		const name = picked.trim();
		if (name === "") {
			return;
		}
		if (multi) {
			if (!chips.some((c) => c.toLowerCase() === name.toLowerCase())) {
				onChange(joinNames([...chips, name]));
			}
		} else {
			onChange(name);
		}
		setText("");
		setActive(0);
		setOpen(multi);
	};
	const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
	/** Moves the name at `from` to position `to`; the first name is the primary one. */
	const reorder = (from: number, to: number) => {
		if (from === to || to < 0 || to >= chips.length) {
			return;
		}
		const next = [...chips];
		const [moved] = next.splice(from, 1);
		if (moved !== undefined) {
			next.splice(to, 0, moved);
			onChange(joinNames(next));
		}
	};
	const removeChip = (name: string) => onChange(joinNames(chips.filter((c) => c !== name)));

	const move = (step: number) => {
		setOpen(true);
		setActive((a) => (rows.length === 0 ? 0 : (a + step + rows.length) % rows.length));
	};
	const confirm = (ev: KeyboardEvent) => {
		const next = (open ? rows[active]?.value : undefined) ?? typedNew;
		if (next !== "" && (multi || open)) {
			ev.preventDefault();
			ev.stopPropagation();
			commit(next);
		}
	};
	const edgeKey = (ev: KeyboardEvent) => {
		if (ev.key === "Backspace" && multi && text === "" && chips.length > 0) {
			removeChip(chips[chips.length - 1] ?? "");
		} else if (ev.key === "Escape" && open) {
			ev.stopPropagation();
			setOpen(false);
		}
	};
	const onKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
		const arrow = { ArrowDown: 1, ArrowUp: -1 }[ev.key];
		if (arrow !== undefined) {
			ev.preventDefault();
			move(arrow);
		} else if (ev.key === "Enter" || (multi && (ev.key === ";" || ev.key === ","))) {
			confirm(ev);
		} else {
			edgeKey(ev);
		}
	};

	return (
		<div className="relative">
			<div
				className={cn(
					"flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-1.5 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
					touched && "border-primary/60 bg-primary/5 dark:bg-primary/10",
				)}
			>
				{chips.map((c, i) => (
					<Chip
						key={c}
						name={c}
						dragging={drag?.from === i}
						dropBefore={drag !== null && drag.over === i && drag.from !== i}
						onDragStart={() => setDrag({ from: i, over: i })}
						onDragOver={() => setDrag((d) => (d ? { ...d, over: i } : d))}
						onDrop={() => {
							if (drag) {
								reorder(drag.from, i);
							}
							setDrag(null);
						}}
						onDragEnd={() => setDrag(null)}
						onNudge={(step) => reorder(i, i + step)}
						onRemove={() => removeChip(c)}
					/>
				))}
				<input
					id={id}
					role="combobox"
					aria-expanded={open}
					aria-controls={listId}
					aria-autocomplete="list"
					autoComplete="off"
					value={multi ? text : text || value}
					placeholder={chips.length === 0 ? placeholder : ""}
					onChange={(e) => {
						setText(e.target.value);
						setActive(0);
						setOpen(true);
						if (!multi) {
							onChange(e.target.value);
						}
					}}
					onFocus={() => setOpen(true)}
					onBlur={() => {
						// Typed text that was never picked still counts, as a name.
						if (multi && typedNew !== "") {
							commit(typedNew);
						}
						setText("");
						setOpen(false);
					}}
					onKeyDown={onKeyDown}
					className="h-6 min-w-16 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
				/>
			</div>
			{open && rows.length > 0 && (
				<div
					id={listId}
					role="listbox"
					className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
				>
					{rows.map((o, i) => (
						<div
							key={`${o.value}-${o.count === undefined ? "new" : "known"}`}
							role="option"
							tabIndex={-1}
							aria-selected={i === active}
							// Mouse down, not click: the input must not lose focus first.
							onMouseDown={(e) => {
								e.preventDefault();
								commit(o.value);
							}}
							onMouseEnter={() => setActive(i)}
							className={cn(
								"flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1 text-sm",
								i === active && "bg-muted",
							)}
						>
							<span className="truncate">
								{o.count === undefined ? `Add “${o.value}”` : o.value}
							</span>
							{o.count !== undefined && (
								<span className="shrink-0 text-muted-foreground text-xs">{o.count}</span>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function Chip({
	name,
	dragging,
	dropBefore,
	onDragStart,
	onDragOver,
	onDrop,
	onDragEnd,
	onNudge,
	onRemove,
}: {
	name: string;
	dragging: boolean;
	dropBefore: boolean;
	onDragStart: () => void;
	onDragOver: () => void;
	onDrop: () => void;
	onDragEnd: () => void;
	onNudge: (step: number) => void;
	onRemove: () => void;
}) {
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: draggable chip; Alt+arrows reorder from the keyboard
		<span
			draggable
			// Focusable so Alt+←/→ can reorder without a mouse.
			// biome-ignore lint/a11y/noNoninteractiveTabindex: reorderable chip
			tabIndex={0}
			title="Drag, or press Alt and an arrow key, to reorder"
			onDragStart={(e) => {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", name);
				onDragStart();
			}}
			onDragOver={(e) => {
				e.preventDefault();
				onDragOver();
			}}
			onDrop={(e) => {
				e.preventDefault();
				onDrop();
			}}
			onDragEnd={onDragEnd}
			onKeyDown={(e) => {
				if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
					e.preventDefault();
					onNudge(e.key === "ArrowLeft" ? -1 : 1);
				}
			}}
			className={cn(
				"flex max-w-full cursor-grab items-center gap-0.5 rounded-md bg-secondary py-0.5 pr-0.5 pl-0.5 text-secondary-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
				dragging && "opacity-40",
				dropBefore && "shadow-[-2px_0_0_0_var(--color-primary)]",
			)}
		>
			<GripVertical className="size-3 shrink-0 text-muted-foreground/60" />
			<span className="truncate">{name}</span>
			<button
				type="button"
				aria-label={`Remove ${name}`}
				onClick={onRemove}
				className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
			>
				<X className="size-3" />
			</button>
		</span>
	);
}
