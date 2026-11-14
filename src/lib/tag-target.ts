import type { TagTarget } from "#/components/tag-editor.tsx";
import { albumKey } from "#/lib/albums.ts";
import type { Track } from "#/lib/api.ts";

/** `a/b/Song.mp3` → `Song.mp3`. */
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What the tag editor edits for library songs: one song as itself, songs of one album as that
 * album, anything else as a selection. `null` for no songs.
 */
export function tagTargetFor(tracks: readonly Track[]): TagTarget | null {
	const [first] = tracks;
	if (!first) {
		return null;
	}
	if (tracks.length === 1) {
		return { path: first.path, name: fileName(first.path), isDir: false };
	}
	const key = albumKey(first.artist, first.album);
	const oneAlbum = first.album !== "" && tracks.every((t) => albumKey(t.artist, t.album) === key);
	return {
		path: first.path,
		paths: tracks.map((t) => t.path),
		isDir: true,
		name: oneAlbum ? first.album : plural(tracks.length, "song", "songs"),
		kind: oneAlbum ? "Album" : "Selection",
	};
}
