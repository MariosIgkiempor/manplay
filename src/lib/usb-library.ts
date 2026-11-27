import type { Track, UsbPlaylist, UsbTrack } from "#/lib/api.ts";
import { normalizeKey } from "#/lib/musical-key.ts";

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

/** `id` and every playlist and folder inside it. */
export function within(playlists: readonly UsbPlaylist[], id: number): Set<number> {
	const out = new Set([id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const p of playlists) {
			if (out.has(p.parentId) && !out.has(p.id)) {
				out.add(p.id);
				grew = true;
			}
		}
	}
	return out;
}

/** Where `id` can move: the top level (0) and every folder outside it, minus where it is now. */
export function moveTargets(
	playlists: readonly UsbPlaylist[],
	id: number,
): { id: number; name: string; depth: number }[] {
	const self = playlists.find((p) => p.id === id);
	const inside = within(playlists, id);
	const folders = playlistTree(playlists)
		.filter(({ playlist: p }) => p.isFolder && !inside.has(p.id))
		.map(({ playlist: p, depth }) => ({ id: p.id, name: p.name, depth }));
	return [{ id: 0, name: "Top level", depth: 0 }, ...folders].filter(
		(t) => t.id !== self?.parentId,
	);
}

/** `base`, or `base 2`, `base 3`… whichever no sibling in `parentId` uses yet. */
export function freeName(
	playlists: readonly UsbPlaylist[],
	parentId: number,
	base: string,
): string {
	const taken = new Set(
		playlists.filter((p) => p.parentId === parentId).map((p) => p.name.toLowerCase()),
	);
	let name = base;
	for (let n = 2; taken.has(name.toLowerCase()); n++) {
		name = `${base} ${n}`;
	}
	return name;
}

const orNull = (n: number) => (n > 0 ? n : null);

function asTrack(u: UsbTrack, mount: string, known: Track | undefined): Track {
	return {
		id: known?.id ?? -u.id,
		path: `${mount}${u.path}`,
		artist: u.artist || known?.artist || "",
		album: u.album || known?.album || "",
		title: u.title || u.path.split("/").pop() || "",
		size: u.fileSize,
		tags: known?.tags ?? [],
		syncedCount: 0,
		durationMs: orNull(u.durationSecs * 1000),
		bitrate: orNull(u.bitrate),
		sampleRate: orNull(u.sampleRate),
		bpm: orNull(u.tempo / 100),
		key: u.key === "" ? null : (normalizeKey(u.key) ?? u.key),
		analyzed: u.analyzePath !== "",
		fields: known?.fields ?? {},
		edited: known?.edited ?? { bpm: false, key: false, grid: false },
		fileState: "here",
	};
}

/**
 * Songs on a drive as library-style tracks, playable straight off the drive. A song that is the
 * same file as one in the library (same size) borrows that track's id, so it shows its artwork,
 * tags and menu; any other gets a negative id that matches nothing in the library.
 */
export function usbAsTracks(
	songs: readonly UsbTrack[],
	mount: string,
	library: readonly Track[],
): Track[] {
	const bySize = new Map(library.map((t) => [t.size, t]));
	return songs.map((u) => asTrack(u, mount, u.fileSize > 0 ? bySize.get(u.fileSize) : undefined));
}
