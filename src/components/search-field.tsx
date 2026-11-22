import { Search, X } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { SEARCH_FIELD } from "#/lib/search-field.ts";
import { cn } from "#/lib/utils.ts";

/** The magnifier at the start of a search field, in the accent colour while a query is on. */
export function SearchGlyph({ active }: { active: boolean }) {
	return (
		<Search
			className={cn("size-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground/70")}
		/>
	);
}

/** A plain search field: magnifier, text, and a clear button once something is typed. */
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
	const active = value !== "";
	return (
		<div className={cn("flex h-8 min-w-0 items-center gap-1", className)}>
			<label className={cn(SEARCH_FIELD, "h-full flex-1")}>
				<SearchGlyph active={active} />
				<input
					ref={inputRef}
					data-page-search
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={placeholder}
					aria-label={label ?? placeholder}
					spellCheck={false}
					className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
				/>
				{active && (
					<button
						type="button"
						aria-label="Clear search"
						title="Clear search"
						className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
						onClick={() => onChange("")}
					>
						<X className="size-3.5" />
					</button>
				)}
			</label>
			{trailing}
		</div>
	);
}
