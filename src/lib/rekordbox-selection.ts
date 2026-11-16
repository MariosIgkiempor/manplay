import type { TagNode } from "#/lib/tag-tree.ts";

/** A tag and every tag below it, as written in the library. */
export function subtreeNames(node: TagNode): string[] {
	return [node.name, ...node.children.flatMap(subtreeNames)];
}

export type TagCheck = "on" | "off" | "some";

/** "on" when the tag and everything below it is selected, "some" when only part of it is. */
export function tagCheck(selected: readonly string[], node: TagNode): TagCheck {
	const have = new Set(selected.map((t) => t.toLowerCase()));
	const names = subtreeNames(node).map((n) => n.toLowerCase());
	const hits = names.filter((n) => have.has(n)).length;
	if (hits === names.length) {
		return "on";
	}
	return hits === 0 ? "off" : "some";
}

/** Checks or unchecks a tag together with every tag below it. */
export function setTagTree(selected: readonly string[], node: TagNode, on: boolean): string[] {
	const names = subtreeNames(node);
	const drop = new Set(names.map((n) => n.toLowerCase()));
	const rest = selected.filter((t) => !drop.has(t.toLowerCase()));
	return on ? [...rest, ...names] : rest;
}
