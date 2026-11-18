import { GripVertical, X } from "lucide-react";
import * as React from "react";
import {
	type ClipboardEvent,
	type KeyboardEvent,
	type RefObject,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
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
	className,
}: {
	id: string;
	value: string;
	options: readonly ComboOption[];
	multi: boolean;
	placeholder: string;
	touched: boolean;
	onChange: (value: string) => void;
	className?: string;
}) {
	const listId = useId();
	const [text, setText] = useState("");
	const [open, setOpen] = useState(false);
	// Single-value fields start with nothing highlighted, so Enter keeps what was typed.
	const idle = multi ? 0 : -1;
	const [active, setActive] = useState(idle);
	// Cmd+A on an empty name list "selects" every name, so copy, cut and paste act on all of them.
	const [allSelected, setAllSelected] = useState(false);
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
		setActive(idle);
		setOpen(multi);
	};
	/** `to` is the gap the chip would land in: 0 before the first name, `chips.length` after the last. */
	const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
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
	/** Dropping into the gap just before or after the chip's own slot changes nothing. */
	const landsInPlace = drag !== null && (drag.to === drag.from || drag.to === drag.from + 1);
	const rowRef = useRef<HTMLDivElement>(null);
	useSlide(rowRef, chips.join("\u0000"));
	const dropDrag = () => {
		if (drag && !landsInPlace) {
			reorder(drag.from, drag.to > drag.from ? drag.to - 1 : drag.to);
		}
		setDrag(null);
	};
	const removeChip = (name: string) => onChange(joinNames(chips.filter((c) => c !== name)));

	/** Cmd+C / Cmd+X with no text selected copy every name (`A; B`), as typed into the field. */
	const onCopy = (ev: ClipboardEvent<HTMLInputElement>, cut: boolean) => {
		const input = ev.currentTarget;
		const hasSelection = input.selectionStart !== input.selectionEnd;
		if (!multi || hasSelection || chips.length === 0) {
			return;
		}
		ev.preventDefault();
		ev.clipboardData.setData("text/plain", value);
		if (cut) {
			setAllSelected(false);
			onChange("");
		}
	};
	/** Pasted names (split on `;` and new lines) join the list; after Cmd+A they replace it. */
	const onPaste = (ev: ClipboardEvent<HTMLInputElement>) => {
		const pasted = ev.clipboardData.getData("text/plain");
		if (!multi || (!allSelected && !/[;\n]/.test(pasted))) {
			return; // a plain word pastes into the text box as usual
		}
		ev.preventDefault();
		const names = splitNames(pasted.replace(/\r?\n/g, ";"));
		const base = allSelected ? [] : chips;
		const merged = [...base];
		for (const n of names) {
			if (!merged.some((m) => m.toLowerCase() === n.toLowerCase())) {
				merged.push(n);
			}
		}
		setAllSelected(false);
		onChange(joinNames(merged));
	};

	const move = (step: number) => {
		setOpen(true);
		setActive((a) => {
			if (rows.length === 0) {
				return idle;
			}
			if (a < 0) {
				return step > 0 ? 0 : rows.length - 1;
			}
			return (a + step + rows.length) % rows.length;
		});
	};
	const confirm = (ev: KeyboardEvent) => {
		const highlighted = open ? rows[active]?.value : undefined;
		if (!multi && highlighted === undefined) {
			setOpen(false);
			return;
		}
		const next = highlighted ?? typedNew;
		if (next !== "" && (multi || open)) {
			ev.preventDefault();
			ev.stopPropagation();
			commit(next);
		}
	};
	/** Keys that act on the whole name list (Cmd+A, then Backspace). True when handled. */
	const listKey = (ev: KeyboardEvent) => {
		if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "a" && multi && text === "") {
			ev.preventDefault();
			setAllSelected(chips.length > 0);
			return true;
		}
		if (allSelected && (ev.key === "Backspace" || ev.key === "Delete")) {
			ev.preventDefault();
			setAllSelected(false);
			onChange("");
			return true;
		}
		return false;
	};
	const edgeKey = (ev: KeyboardEvent) => {
		if (listKey(ev)) {
			return;
		}
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
		} else if (
			// Cmd+Enter is left alone: it saves the editor.
			(ev.key === "Enter" && !ev.metaKey && !ev.ctrlKey) ||
			(multi && (ev.key === ";" || ev.key === ","))
		) {
			confirm(ev);
		} else {
			edgeKey(ev);
		}
	};

	return (
		<div className="relative">
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for chip reordering */}
			<div
				ref={rowRef}
				onDragOver={(e) => drag && e.preventDefault()}
				onDrop={(e) => {
					e.preventDefault();
					dropDrag();
				}}
				className={cn(
					"flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-1.5 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
					className,
					touched && "border-primary/60 bg-primary/5 dark:bg-primary/10",
				)}
			>
				{chips.map((c, at) => (
					<React.Fragment key={c}>
						{drag && !landsInPlace && drag.to === at && <DropGhost name={chips[drag.from] ?? ""} />}
						<Chip
							name={c}
							selected={allSelected}
							origin={drag?.from === at}
							onDragStart={() =>
								// After the browser has taken its drag image of the untouched chip.
								setTimeout(() => setDrag({ from: at, to: at }), 0)
							}
							onDragOver={(after) =>
								setDrag((d) => {
									const to = at + (after ? 1 : 0);
									return d && d.to !== to ? { ...d, to } : d;
								})
							}
							onDrop={dropDrag}
							onDragEnd={() => setDrag(null)}
							onNudge={(step) => reorder(at, at + step)}
							onRemove={() => removeChip(c)}
						/>
					</React.Fragment>
				))}
				{drag && !landsInPlace && drag.to === chips.length && (
					<DropGhost name={chips[drag.from] ?? ""} />
				)}
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
						setActive(idle);
						setAllSelected(false);
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
						setAllSelected(false);
						setOpen(false);
					}}
					onKeyDown={onKeyDown}
					onCopy={(e) => onCopy(e, false)}
					onCut={(e) => onCopy(e, true)}
					onPaste={onPaste}
					className="h-6 min-w-6 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
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

/** Where a dragged name would land. */
function DropGhost({ name }: { name: string }) {
	// Same parts as a chip, hidden, so the ghost is exactly as wide.
	return (
		<span
			aria-hidden="true"
			className="flex max-w-full items-center gap-0.5 rounded-md bg-emerald-500/10 py-0.5 pr-0.5 pl-0.5 text-emerald-500 text-xs outline-1 -outline-offset-1 outline-emerald-500/70 outline-dashed"
		>
			<GripVertical className="size-3 shrink-0 opacity-0" />
			<span className="truncate">{name}</span>
			<span className="p-0.5">
				<X className="size-3 opacity-0" />
			</span>
		</span>
	);
}

function Chip({
	name,
	selected,
	origin,
	onDragStart,
	onDragOver,
	onDrop,
	onDragEnd,
	onNudge,
	onRemove,
}: {
	name: string;
	selected: boolean;
	/** The chip being dragged: its slot shows a red ghost until it is dropped. */
	origin: boolean;
	onDragStart: () => void;
	/** `after`: the pointer is over the chip's right half. */
	onDragOver: (after: boolean) => void;
	onDrop: () => void;
	onDragEnd: () => void;
	onNudge: (step: number) => void;
	onRemove: () => void;
}) {
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: draggable chip; Alt+arrows reorder from the keyboard
		<span
			draggable
			data-chip={name}
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
				const box = e.currentTarget.getBoundingClientRect();
				onDragOver(e.clientX > box.left + box.width / 2);
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
				selected && "bg-primary text-primary-foreground",
				// Where the chip came from; dropping back on it cancels the move.
				origin &&
					"bg-destructive/10 outline-1 -outline-offset-1 outline-destructive/70 outline-dashed *:invisible",
			)}
		>
			<GripVertical className="size-3 shrink-0 text-muted-foreground/60" />
			<span className="truncate">{name}</span>
			<button
				type="button"
				aria-label={`Remove ${name}`}
				onClick={onRemove}
				className="rounded-md p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
			>
				<X className="size-3" />
			</button>
		</span>
	);
}

/** Animates one element from where it was (`was`) to where it is now. */
function slideFrom(el: HTMLElement, was: DOMRect | undefined, now: DOMRect) {
	if (!was || (was.left === now.left && was.top === now.top)) {
		return;
	}
	const from = `translate(${was.left - now.left}px, ${was.top - now.top}px)`;
	el.animate([{ transform: from }, { transform: "translate(0, 0)" }], {
		duration: 200,
		easing: "cubic-bezier(0.2, 0, 0, 1)",
	});
}

/**
 * Slides chips to their new place whenever the order changes (FLIP): compare each chip's box
 * with the last render and animate it from the old position.
 */
function useSlide(ref: RefObject<HTMLDivElement | null>, orderKey: string) {
	const last = useRef(new Map<string, DOMRect>());
	// biome-ignore lint/correctness/useExhaustiveDependencies: orderKey is the trigger
	useLayoutEffect(() => {
		const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const now = new Map<string, DOMRect>();
		for (const el of ref.current?.querySelectorAll<HTMLElement>("[data-chip]") ?? []) {
			const key = el.getAttribute("data-chip") ?? "";
			const box = el.getBoundingClientRect();
			now.set(key, box);
			if (!calm) {
				slideFrom(el, last.current.get(key), box);
			}
		}
		last.current = now;
	}, [ref, orderKey]);
}
