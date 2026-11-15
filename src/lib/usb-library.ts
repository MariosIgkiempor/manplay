import type { UsbPlaylist } from "#/lib/api.ts";

export interface TreeRow {
	playlist: UsbPlaylist;
	depth: number;
}

/** Playlists in the order the player lists them, folders followed by their contents. */
export function playlistTree(playlists: readonly UsbPlaylist[]): TreeRow[] {
	const children = new Map<number, UsbPlaylist[]>();
	for (const p of playlists) {
		const list = children.get(p.parentId) ?? [];
		list.push(p);
		children.set(p.parentId, list);
	}
	const rows: TreeRow[] = [];
	const seen = new Set<number>();
	const walk = (parent: number, depth: number) => {
		const list = [...(children.get(parent) ?? [])].sort(
			(a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
		);
		for (const p of list) {
			if (seen.has(p.id)) {
				continue;
			}
			seen.add(p.id);
			rows.push({ playlist: p, depth });
			walk(p.id, depth + 1);
		}
	};
	walk(0, 0);
	return rows;
}
