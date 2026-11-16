import { Check, ChevronRight } from "lucide-react";
import { useState } from "react";
import { PropertyRow } from "#/components/property-row.tsx";
import { diffNames, isMulti, labelOf, type TagChange } from "#/lib/tag-preview.ts";
import { cn } from "#/lib/utils.ts";

/** Plain text in the editor's value column, without the field chrome. */
const FIELD = "flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 py-0.5 text-sm";
const CHIP = "rounded-md px-1.5 py-0.5 text-xs";

/** Names of the changed tags, as short as fits: `Genre, BPM, Key +2`. */
function summary(changes: readonly TagChange[]): string {
	const names = changes.map((c) => labelOf(c.field));
	const shown = names.slice(0, 3).join(", ");
	return names.length > 3 ? `${shown} +${names.length - 3}` : shown;
}

/** Old values of a field and how many songs had each. One song's change has one, count 1. */
export interface Was {
	value: string | null;
	count: number;
}

const MAX_OLD = 3;

/** A field's value with the change marked in it: list names as chips, otherwise old then new. */
function Value({ field, was, to }: { field: string; was: readonly Was[]; to: string | null }) {
	const single = was.length === 1 ? was[0] : undefined;
	const names = single && isMulti(field) ? diffNames(single.value, to) : [];
	// Chips only show names coming and going. Same names in another order or case read as text.
	if (names.some((d) => d.state !== "kept")) {
		return names.map((d) => (
			<span
				key={`${d.state}-${d.name}`}
				className={cn(
					CHIP,
					d.state === "kept" && "bg-secondary text-secondary-foreground",
					d.state === "added" && "bg-success/15 text-success",
					d.state === "removed" && "bg-destructive/10 text-destructive line-through",
				)}
			>
				{d.name}
			</span>
		));
	}
	return (
		<>
			{was.slice(0, MAX_OLD).map(
				(w) =>
					w.value !== null && (
						<span key={w.value} className="text-muted-foreground">
							<span className="line-through decoration-muted-foreground/60">{w.value}</span>
							{was.length > 1 && <span className="text-xs"> ×{w.count}</span>}
						</span>
					),
			)}
			{was.length > MAX_OLD && (
				<span className="text-muted-foreground text-xs">+{was.length - MAX_OLD}</span>
			)}
			{to === null ? (
				<span className="text-muted-foreground italic">Cleared</span>
			) : (
				<span>{to}</span>
			)}
		</>
	);
}

/** One changed field in the metadata editor's layout: its name, then the value with the change. */
export function TagRow({
	field,
	was,
	to,
}: {
	field: string;
	was: readonly Was[];
	to: string | null;
}) {
	return (
		<PropertyRow
			className="grid-cols-[7rem_minmax(0,1fr)]"
			label={<span className="truncate font-medium text-primary text-xs">{labelOf(field)}</span>}
		>
			<div className={FIELD}>
				<Value field={field} was={was} to={to} />
			</div>
		</PropertyRow>
	);
}

/** One value of a push conflict. The column that stays is tinted and plain, the other muted and struck. */
function Cell({ value, kept, last }: { value: string | null; kept: boolean; last: boolean }) {
	return (
		<span
			className={cn(
				"min-w-0 break-words px-2.5 py-0.5",
				kept ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground",
				kept && last && "rounded-b-md",
				!kept && value !== null && "line-through decoration-muted-foreground/50",
			)}
		>
			{value ?? <span className="italic">empty</span>}
		</span>
	);
}

/** A column head of the conflict grid; the side that stays carries a check. */
function Head({ who, kept }: { who: "Yours" | "Remote"; kept: boolean }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 px-2.5 py-1 text-xs",
				kept ? "rounded-t-md bg-primary/10 font-medium text-primary" : "text-muted-foreground",
			)}
		>
			{kept && <Check className="size-3" />}
			{who}
			{kept && <span className="sr-only"> (kept)</span>}
		</span>
	);
}

/**
 * Changed tags laid out like the metadata editor: only the changed fields, one row each.
 * With `keep` set it is a push conflict: the destination's value against yours, and the one that
 * will be kept is marked (`keep` true: yours replaces the destination's).
 */
export function TagDiff({
	changes,
	keep,
}: {
	changes: readonly TagChange[];
	keep?: boolean | undefined;
}) {
	if (keep === undefined) {
		return (
			<div className="space-y-1">
				{changes.map((c) => (
					<TagRow key={c.field} field={c.field} was={[{ value: c.from, count: 1 }]} to={c.to} />
				))}
			</div>
		);
	}
	return (
		<div className="grid grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)] items-baseline text-sm">
			<span />
			<Head who="Yours" kept={keep} />
			<Head who="Remote" kept={!keep} />
			{changes.map((c, i) => (
				<div key={c.field} className="col-span-3 grid grid-cols-subgrid items-baseline">
					<span className="truncate text-muted-foreground text-xs">{labelOf(c.field)}</span>
					<Cell value={c.to} kept={keep} last={i === changes.length - 1} />
					<Cell value={c.from} kept={!keep} last={i === changes.length - 1} />
				</div>
			))}
		</div>
	);
}

/** The diff, always open, for use inside a row whose label ticks a checkbox. */
export function TagDiffInline({
	changes,
	keep,
}: {
	changes: readonly TagChange[];
	keep?: boolean | undefined;
}) {
	return (
		// Diff rows are labels for their checkbox: clicks in here must not tick it.
		// biome-ignore lint/a11y/noStaticElementInteractions: only stops the click reaching the label
		// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard never reaches the label through here
		<span className="mt-1 block cursor-default" onClick={(e) => e.preventDefault()}>
			<TagDiff changes={changes} keep={keep} />
		</span>
	);
}

/** The changed tags' names, which open into the editor-style diff when pressed. */
export function TagChanges({
	changes,
	keep,
}: {
	changes: readonly TagChange[];
	keep?: boolean | undefined;
}) {
	const [open, setOpen] = useState(false);
	if (changes.length === 0) {
		return null;
	}
	return (
		// Diff rows are labels for their checkbox: clicks in here must not tick it.
		// biome-ignore lint/a11y/noStaticElementInteractions: only stops the click reaching the label
		// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard never reaches the label through here
		<span className="block cursor-default" onClick={(e) => e.preventDefault()}>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="-mx-1 inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md px-1 text-muted-foreground text-xs outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
			>
				<ChevronRight
					className={cn(
						"size-3 shrink-0 transition-transform motion-reduce:transition-none",
						open && "rotate-90",
					)}
				/>
				<span className="truncate">{summary(changes)}</span>
			</button>
			{open && (
				<span className="mt-1.5 block">
					<TagDiff changes={changes} keep={keep} />
				</span>
			)}
		</span>
	);
}
