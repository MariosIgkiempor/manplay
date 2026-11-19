import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { PropertyRow } from "#/components/property-row.tsx";
import { type FieldDiff, fieldDiff, type TagPart, tagDiffs } from "#/lib/tag-change.ts";
import { labelOf, type TagChange } from "#/lib/tag-preview.ts";
import { cn } from "#/lib/utils.ts";

/** Names of the changed tags, as short as fits: `Genre, BPM, Key +2`. */
function summary(changes: readonly TagChange[]): string {
	const names = changes.map((c) => labelOf(c.field));
	const shown = names.slice(0, 3).join(", ");
	return names.length > 3 ? `${shown} +${names.length - 3}` : shown;
}

const LOOK: Record<TagPart["kind"], string> = {
	kept: "bg-muted text-muted-foreground",
	added: "bg-success/15 font-medium text-success",
	removed: "bg-destructive/10 text-destructive line-through decoration-destructive/50",
	renamed: "bg-warning/15",
};

const SPOKEN: Record<TagPart["kind"], string> = {
	kept: "kept",
	added: "added",
	removed: "removed",
	renamed: "renamed",
};

/**
 * One value of a changed tag: green when added, red and struck when removed, orange with
 * old → new when renamed, plain when it stays.
 */
export function TagPartPill({ part }: { part: TagPart }) {
	return (
		<span
			className={cn(
				"inline-block max-w-full break-words rounded-md px-1.5 py-0.5 text-xs leading-snug",
				LOOK[part.kind],
			)}
		>
			<span className="sr-only">{SPOKEN[part.kind]}: </span>
			{part.kind === "renamed" ? (
				<>
					<span className="text-muted-foreground line-through decoration-muted-foreground/50">
						{part.from}
					</span>
					<span aria-hidden="true" className="mx-1 text-muted-foreground">
						→
					</span>
					<span className="sr-only"> to </span>
					<span className="font-medium text-warning">{part.to}</span>
				</>
			) : (
				part.value
			)}
		</span>
	);
}

const partKey = (p: TagPart) => (p.kind === "renamed" ? `r:${p.to}` : `${p.kind}:${p.value}`);

/** A tag's pills in a wrapping row. */
function Parts({ parts }: { parts: readonly TagPart[] }) {
	return (
		<span className="flex min-w-0 flex-wrap items-baseline gap-1">
			{parts.map((p) => (
				<TagPartPill key={partKey(p)} part={p} />
			))}
		</span>
	);
}

/** Changed tags, one line each: the tag's name, then the pills of its values. */
export function FieldDiffs({ diffs }: { diffs: readonly FieldDiff[] }) {
	if (diffs.length === 0) {
		return null;
	}
	return (
		<span className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1">
			{diffs.map((d) => (
				<span key={d.field} className="col-span-2 grid grid-cols-subgrid items-baseline">
					<span className="text-muted-foreground text-xs">{labelOf(d.field)}</span>
					<Parts parts={d.parts} />
				</span>
			))}
		</span>
	);
}

/** Old values of a field and how many songs had each. One song's change has one, count 1. */
export interface Was {
	value: string | null;
	count: number;
}

const MAX_OLD = 3;

/** One changed field in the metadata editor's layout: its name, then a pill per old value. */
export function TagRow({
	field,
	was,
	to,
}: {
	field: string;
	was: readonly Was[];
	to: string | null;
}) {
	const groups = was.flatMap((w) => {
		const diff = fieldDiff(field, w.value, to);
		return diff ? [{ parts: diff.parts, count: w.count, key: w.value ?? "" }] : [];
	});
	return (
		<PropertyRow
			className="grid-cols-[7rem_minmax(0,1fr)]"
			label={<span className="truncate font-medium text-primary text-xs">{labelOf(field)}</span>}
		>
			<div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 py-0.5">
				{groups.slice(0, MAX_OLD).map(({ parts, count, key }) => (
					<span key={key} className="inline-flex flex-wrap items-baseline gap-1">
						<Parts parts={parts} />
						{was.length > 1 && <span className="text-muted-foreground text-xs">×{count}</span>}
					</span>
				))}
				{groups.length > MAX_OLD && (
					<span className="text-muted-foreground text-xs">+{groups.length - MAX_OLD}</span>
				)}
			</div>
		</PropertyRow>
	);
}

/**
 * Changed tags as pills, one line per tag. With `keep` set it is a push over the destination's
 * own tags: the pills say what the destination gets when yours replaces it (`keep` true), and
 * are dimmed when the destination keeps its copy.
 */
export function TagDiff({
	changes,
	keep,
}: {
	changes: readonly TagChange[];
	keep?: boolean | undefined;
}) {
	const diffs = tagDiffs(changes);
	if (diffs.length === 0) {
		return null;
	}
	return (
		<span className="block space-y-1">
			{keep === false && <span className="block text-muted-foreground text-xs">Remote kept</span>}
			<span className={cn("block", keep === false && "opacity-50")}>
				<FieldDiffs diffs={diffs} />
			</span>
		</span>
	);
}

/** The pills, always open, for use inside a row whose label ticks a checkbox. */
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

/** The changed tags' names, which open into pills when pressed. */
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
