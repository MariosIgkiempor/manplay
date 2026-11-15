import { type KeyboardEvent, type SyntheticEvent, useEffect, useId, useRef, useState } from "react";
import { cn } from "#/lib/utils.ts";

const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * A text field that replaces a value in place. Enter or leaving the field saves, Escape cancels.
 * Keys and clicks stay inside, so the list around it does not play, select or navigate.
 */
export function InlineInput({
	initial,
	label,
	onCommit,
	onCancel,
	parse = (v) => v.trim(),
	suggestions,
	className,
	inputMode,
}: {
	initial: string;
	label: string;
	/** Called with the parsed value when it differs from `initial`. */
	onCommit: (value: string) => void;
	onCancel: () => void;
	/** Cleans the typed text; `null` marks it invalid and keeps the field open. */
	parse?: ((raw: string) => string | null) | undefined;
	suggestions?: readonly string[] | undefined;
	className?: string | undefined;
	inputMode?: "numeric" | "text" | undefined;
}) {
	const listId = useId();
	const [text, setText] = useState(initial);
	const [invalid, setInvalid] = useState(false);
	const done = useRef(false);
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => input.current?.select(), []);

	const commit = () => {
		if (done.current) {
			return;
		}
		const value = parse(text);
		if (value === null) {
			setInvalid(true);
			input.current?.focus();
			return;
		}
		done.current = true;
		if (value === initial.trim()) {
			onCancel();
		} else {
			onCommit(value);
		}
	};
	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		e.stopPropagation();
		if (e.key === "Enter") {
			e.preventDefault();
			commit();
		} else if (e.key === "Escape") {
			e.preventDefault();
			done.current = true;
			onCancel();
		}
	};
	return (
		<>
			<input
				ref={input}
				// biome-ignore lint/a11y/noAutofocus: the field appears because the user asked to edit
				autoFocus
				value={text}
				aria-label={label}
				aria-invalid={invalid || undefined}
				inputMode={inputMode}
				list={suggestions ? listId : undefined}
				onChange={(e) => {
					setText(e.target.value);
					setInvalid(false);
				}}
				onKeyDown={onKeyDown}
				onBlur={commit}
				onClick={stop}
				onDoubleClick={stop}
				onMouseDown={stop}
				onContextMenu={stop}
				className={cn(
					"h-7 w-full min-w-0 rounded-md border border-ring bg-background px-1.5 text-sm outline-none ring-3 ring-ring/25",
					"aria-invalid:border-destructive aria-invalid:ring-destructive/25",
					className,
				)}
			/>
			{suggestions && (
				<datalist id={listId}>
					{suggestions.map((s) => (
						<option key={s} value={s} />
					))}
				</datalist>
			)}
		</>
	);
}

/**
 * A value that turns into a field when clicked. Shows `placeholder` faintly while empty, so
 * empty cells still read as editable.
 */
export function InlineEdit({
	value,
	label,
	onCommit,
	parse,
	suggestions,
	placeholder = "–",
	className,
	inputMode,
	hint,
}: {
	value: string;
	label: string;
	/** Hover text; defaults to "Edit <label>". */
	hint?: string;
	onCommit: (value: string) => void;
	parse?: ((raw: string) => string | null) | undefined;
	suggestions?: readonly string[] | undefined;
	placeholder?: string;
	className?: string | undefined;
	inputMode?: "numeric" | "text" | undefined;
}) {
	const [editing, setEditing] = useState(false);
	if (editing) {
		return (
			<InlineInput
				initial={value}
				label={label}
				parse={parse}
				suggestions={suggestions}
				inputMode={inputMode}
				className={className}
				onCancel={() => setEditing(false)}
				onCommit={(v) => {
					setEditing(false);
					onCommit(v);
				}}
			/>
		);
	}
	return (
		<button
			type="button"
			title={hint ?? `Edit ${label.toLowerCase()}`}
			aria-label={`${label}: ${value || "not set"}. Edit`}
			onClick={(e) => {
				e.stopPropagation();
				setEditing(true);
			}}
			onDoubleClick={stop}
			// Enter and Space edit this value; they must not also play or select the row.
			onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.stopPropagation()}
			className={cn(
				"-mx-1.5 h-7 w-[calc(100%+0.75rem)] truncate rounded-md px-1.5 text-left tabular-nums outline-none",
				"hover:bg-foreground/5 hover:ring-1 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring/60",
				value === "" && "text-muted-foreground/50",
				className,
			)}
		>
			{value === "" ? placeholder : value}
		</button>
	);
}
