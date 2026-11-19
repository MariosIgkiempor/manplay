import type { FieldMerge, Resolution, Side } from "#/lib/api.ts";
import { splitNames } from "#/lib/names.ts";
import { isMulti, type TagChange } from "#/lib/tag-preview.ts";

/** A tag's value; `null` and blank text both mean the tag is empty. */
export type TagValue = string | null;

/** How one tag changes: it gains a value, loses its value, or swaps one value for another. */
export type TagChangeKind = "added" | "removed" | "changed";

const isEmpty = (v: TagValue): v is null | "" => v === null || v.trim() === "";

/** How `from` becomes `to`, or null when nothing changes. */
export function classifyTagChange(from: TagValue, to: TagValue): TagChangeKind | null {
	const had = !isEmpty(from);
	const has = !isEmpty(to);
	if (had && has) {
		return from === to ? null : "changed";
	}
	if (has) {
		return "added";
	}
	return had ? "removed" : null;
}

/**
 * One value of a changed tag, as a pill: kept as it was, added (green), removed (red), or
 * renamed from one value to another (orange).
 */
export type TagPart =
	| { kind: "kept"; value: string }
	| { kind: "added"; value: string }
	| { kind: "removed"; value: string }
	| { kind: "renamed"; from: string; to: string };

/** A changed tag: its field and the pills of its values, in the new order, removed ones last. */
export interface FieldDiff {
	field: string;
	parts: TagPart[];
}

/** The values a tag holds: each name of a list tag (`A; B`), else the whole value. */
const valuesOf = (field: string, v: TagValue): string[] => {
	if (isEmpty(v)) {
		return [];
	}
	return isMulti(field) ? splitNames(v) : [v.trim()];
};

/**
 * The pills for one changed tag, or null when it does not change. Values only in the new tag
 * are added and values only in the old one removed; one removed for one added is a rename. A
 * change that adds and removes nothing (a reorder, spacing) is a rename of the whole value.
 */
export function fieldDiff(field: string, from: TagValue, to: TagValue): FieldDiff | null {
	if (classifyTagChange(from, to) === null) {
		return null;
	}
	const before = valuesOf(field, from);
	const after = valuesOf(field, to);
	const had = new Set(before);
	const has = new Set(after);
	const added = after.filter((v) => !had.has(v));
	const removed = before.filter((v) => !has.has(v));
	if (added.length === 0 && removed.length === 0) {
		return { field, parts: [{ kind: "renamed", from: from ?? "", to: to ?? "" }] };
	}
	const [renamedFrom] = removed;
	if (added.length === 1 && removed.length === 1 && renamedFrom !== undefined) {
		return {
			field,
			parts: after.map(
				(v): TagPart =>
					had.has(v) ? { kind: "kept", value: v } : { kind: "renamed", from: renamedFrom, to: v },
			),
		};
	}
	return {
		field,
		parts: [
			...after.map((v): TagPart => ({ kind: had.has(v) ? "kept" : "added", value: v })),
			...removed.map((v): TagPart => ({ kind: "removed", value: v })),
		],
	};
}

/** One diff per tag that really changes, in the order given. */
export function tagDiffs(changes: readonly TagChange[]): FieldDiff[] {
	return changes.flatMap((c) => fieldDiff(c.field, c.from, c.to) ?? []);
}

/** The value a merge keeps for a field: the side that wins, or null while the user must choose. */
export function mergedSide(f: FieldMerge, choice: Resolution | undefined): Side | null {
	return f.side ?? choice?.fields[f.field] ?? null;
}

/**
 * What a merge does to each settled field, measured from the last synced value: the merged file
 * goes to both sides. Fields still waiting for a choice are left out.
 */
export function mergeDiffs(
	fields: readonly FieldMerge[],
	choice: Resolution | undefined,
): FieldDiff[] {
	return fields.flatMap((f) => {
		const side = mergedSide(f, choice);
		if (side === null) {
			return [];
		}
		return fieldDiff(f.field, f.base, side === "mine" ? f.mine : f.theirs) ?? [];
	});
}
