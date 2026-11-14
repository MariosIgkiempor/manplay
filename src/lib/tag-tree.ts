import type { Tag, Track } from "#/lib/api.ts";

/** Library tags are paths: `Genre/Electronic/House` sits under `Genre/Electronic` and `Genre`. */
export const TAG_SEP = "/";

/** True when `tag` is `ancestor` itself or anywhere below it (case-insensitive). */
export function tagWithin(tag: string, ancestor: string): boolean {
	const t = tag.toLowerCase();
	const a = ancestor.toLowerCase();
	return t === a || t.startsWith(`${a}${TAG_SEP}`);
}

/** True when the track carries `name` or any tag below it. */
export function trackHasTag(track: Track, name: string): boolean {
	return track.tags.some((t) => tagWithin(t, name));
}

/** The last level of a tag path: `Genre/House` → `House`. */
export function tagLeaf(name: string): string {
	return name.slice(name.lastIndexOf(TAG_SEP) + 1);
}

export interface TagNode {
	/** Full path. */
	name: string;
	/** Last level only. */
	label: string;
	/** Songs tagged here or below. */
	trackCount: number;
	children: TagNode[];
}

/** Nests a flat tag list by path. A parent missing from the list still gets a node. */
export function buildTagTree(tags: readonly Tag[]): TagNode[] {
	const byKey = new Map<string, TagNode>();
	const roots: TagNode[] = [];
	const nodeFor = (path: string): TagNode => {
		const key = path.toLowerCase();
		let node = byKey.get(key);
		if (!node) {
			node = { name: path, label: tagLeaf(path), trackCount: 0, children: [] };
			byKey.set(key, node);
			const cut = path.lastIndexOf(TAG_SEP);
			(cut < 0 ? roots : nodeFor(path.slice(0, cut)).children).push(node);
		}
		return node;
	};
	for (const t of tags) {
		const node = nodeFor(t.name);
		node.name = t.name;
		node.label = tagLeaf(t.name);
		node.trackCount = t.trackCount;
	}
	const sort = (nodes: TagNode[]) => {
		nodes.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
		for (const n of nodes) {
			sort(n.children);
		}
	};
	sort(roots);
	return roots;
}

/** The tree in display order (parents before their children), every level expanded. */
export function flattenTagTree(tags: readonly Tag[]): { node: TagNode; depth: number }[] {
	const out: { node: TagNode; depth: number }[] = [];
	const walk = (nodes: TagNode[], depth: number) => {
		for (const node of nodes) {
			out.push({ node, depth });
			walk(node.children, depth + 1);
		}
	};
	walk(buildTagTree(tags), 0);
	return out;
}
