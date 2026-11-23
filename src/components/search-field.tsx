import { Search, X } from "lucide-react";
import { type FocusEvent, type ReactNode, type Ref, type RefObject, useRef, useState } from "react";
import { escapeSearch, SEARCH_FIELD, searchInputClass } from "#/lib/search-field.ts";
import { useShortcutLabel } from "#/lib/use-shortcuts.ts";
import { cn } from "#/lib/utils.ts";

/** The magnifier at the start of a search field, in the accent colour while a query is on. */
export function SearchGlyph({ active }: { active: boolean }) {
	return (
		<Search
			className={cn("size-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground/70")}
		/>
	);
}

/** A key written as a small cap, e.g. the shortcut that opens a search. */
export function KeyCap({ children }: { children: ReactNode }) {
	return (
		<kbd className="shrink-0 rounded border px-1.5 font-sans text-[11px] text-muted-foreground/70">
			{children}
		</kbd>
	);
}

/**
 * The frame every page search shares. Folded, it is a magnifier and the key that opens it; a
 * press on it, or the key, grows it inline into the field. It folds again once it loses focus
 * with nothing typed.
 */
export function SearchShell({
	active,
	inputRef,
	label,
	trailing,
	className,
	fieldClassName,
	children,
}: {
	/** Whether a query is on: the field then stays open without focus. */
	active: boolean;
	inputRef: RefObject<HTMLInputElement | null>;
	/** What is searched, for the folded button's name. */
	label: string;
	/** Controls after the field, e.g. a sort menu. */
	trailing?: ReactNode;
	className?: string;
	/** Classes for the field itself, e.g. `relative` for a list hung below it. */
	fieldClassName?: string;
	/** The field's insides: given whether it is open, so the input can shrink to nothing. */
	children: (open: boolean) => ReactNode;
}) {
	const [focused, setFocused] = useState(false);
	const foldButton = useRef<HTMLButtonElement>(null);
	// How wide it was folded: it grows from there rather than shrinking first.
	const [foldedWidth, setFoldedWidth] = useState<number | undefined>(undefined);
	const shortcut = useShortcutLabel("pageSearch");
	const open = focused || active;
	const onBlur = (e: FocusEvent) => {
		if (!e.currentTarget.contains(e.relatedTarget)) {
			setFocused(false);
		}
	};
	return (
		<div className={cn("flex h-8 min-w-0 flex-1 items-center gap-1", className)}>
			<search
				className={cn(
					SEARCH_FIELD,
					"ml-auto h-full min-w-0 transition-[flex-grow] duration-200 ease-out motion-reduce:transition-none",
					open ? "grow basis-0" : "shrink-0 grow-0 px-0",
					fieldClassName,
				)}
				style={open ? { minWidth: foldedWidth } : undefined}
				data-search-open={open || undefined}
				// The folded button gives way to the field on a press, not on focus, so tabbing past it
				// leaves the field folded.
				onFocus={(e) => {
					if ((e.target as EventTarget) === foldButton.current) {
						return;
					}
					if (!open) {
						setFoldedWidth(e.currentTarget.offsetWidth);
					}
					setFocused(true);
				}}
				onBlur={onBlur}
			>
				{open ? (
					<SearchGlyph active={active} />
				) : (
					<button
						ref={foldButton}
						type="button"
						aria-label={shortcut ? `${label} (${shortcut})` : label}
						data-hint={shortcut ? `${label} (${shortcut})` : label}
						className="flex h-full items-center gap-1.5 rounded-md px-2 text-muted-foreground hover:bg-muted hover:text-foreground"
						onClick={() => inputRef.current?.focus()}
					>
						<Search className="size-3.5 shrink-0" />
						{shortcut && <KeyCap>{shortcut}</KeyCap>}
					</button>
				)}
				{children(open)}
			</search>
			{trailing}
		</div>
	);
}

/** A plain page search: a folded magnifier that grows into the field, with a clear button. */
export function SearchField({
	value,
	onChange,
	placeholder,
	label,
	inputRef,
	trailing,
	className,
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder: string;
	/** Accessible name, when the placeholder alone would not say what is searched. */
	label?: string;
	inputRef?: Ref<HTMLInputElement>;
	/** Controls after the field, e.g. a sort menu. */
	trailing?: ReactNode;
	className?: string;
}) {
	const own = useRef<HTMLInputElement>(null);
	const active = value !== "";
	const name = label ?? placeholder;
	return (
		<SearchShell
			active={active}
			inputRef={own}
			label={name}
			trailing={trailing}
			{...(className === undefined ? {} : { className })}
		>
			{(open) => (
				<>
					<input
						ref={(node) => {
							own.current = node;
							if (typeof inputRef === "function") {
								inputRef(node);
							} else if (inputRef) {
								inputRef.current = node;
							}
						}}
						data-page-search
						value={value}
						tabIndex={open ? 0 : -1}
						onChange={(e) => onChange(e.target.value)}
						onKeyDown={(e) => escapeSearch(e, value, () => onChange(""))}
						placeholder={placeholder}
						aria-label={name}
						spellCheck={false}
						className={searchInputClass(open)}
					/>
					{active && (
						<button
							type="button"
							aria-label="Clear search"
							data-hint="Clear search"
							className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
							onClick={() => {
								onChange("");
								own.current?.focus();
							}}
						>
							<X className="size-3.5" />
						</button>
					)}
				</>
			)}
		</SearchShell>
	);
}
