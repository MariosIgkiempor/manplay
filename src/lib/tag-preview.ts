import { splitNames } from "#/lib/names.ts";
import { TAG_GROUPS } from "#/lib/tag-fields.ts";

export interface TagChange {
	field: string;
	from: string | null;
	to: string | null;
}

export interface FileChanges {
	path: string;
	changes: TagChange[];
}

export interface FieldSummary {
	field: string;
	label: string;
	/** Songs where this tag changes. */
	songs: number;
	/** New value (`null` clears the tag). */
	to: string | null;
	/** Old values and how many songs had each, most common first. */
	was: { value: string | null; count: number }[];
}

const LABELS = new Map(TAG_GROUPS.flatMap((g) => g.fields.map((f) => [f.id, f.label] as const)));

const MULTI = new Set(TAG_GROUPS.flatMap((g) => g.fields.filter((f) => f.multi).map((f) => f.id)));

/** Whether the tag holds a list of names (`A; B`). */
export const isMulti = (field: string): boolean => MULTI.has(field);

export const labelOf = (field: string): string => LABELS.get(field) ?? field;

/** One row per changed tag: what it becomes, in how many songs, and what it was before. */
export function summarize(files: readonly FileChanges[]): FieldSummary[] {
	const byField = new Map<string, FieldSummary>();
	for (const file of files) {
		for (const c of file.changes) {
			let row = byField.get(c.field);
			if (!row) {
				row = { field: c.field, label: labelOf(c.field), songs: 0, to: c.to, was: [] };
				byField.set(c.field, row);
			}
			row.songs += 1;
			const old = row.was.find((w) => w.value === c.from);
			if (old) {
				old.count += 1;
			} else {
				row.was.push({ value: c.from, count: 1 });
			}
		}
	}
	const order = [...LABELS.keys()];
	return [...byField.values()]
		.map((r) => ({ ...r, was: r.was.sort((a, b) => b.count - a.count) }))
		.sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field));
}

export interface NameDiff {
	name: string;
	state: "kept" | "added" | "removed";
}

/** Name-by-name difference of two lists, in the new order with removed names after. */
export function diffNames(from: string | null, to: string | null): NameDiff[] {
	const before = splitNames(from ?? "");
	const after = splitNames(to ?? "");
	const had = new Set(before.map((n) => n.toLowerCase()));
	const has = new Set(after.map((n) => n.toLowerCase()));
	return [
		...after.map(
			(name): NameDiff => ({ name, state: had.has(name.toLowerCase()) ? "kept" : "added" }),
		),
		...before
			.filter((n) => !has.has(n.toLowerCase()))
			.map((name): NameDiff => ({ name, state: "removed" })),
	];
}

/** Same names in a different order: only a reorder. */
export function isReorder(from: string | null, to: string | null): boolean {
	const a = splitNames(from ?? "");
	const b = splitNames(to ?? "");
	return (
		a.length === b.length &&
		a.join("\u0000") !== b.join("\u0000") &&
		[...a].sort().join("\u0000") === [...b].sort().join("\u0000")
	);
}
