import type { ExportSelection } from "#/lib/api.ts";
import { TAG_SEP } from "#/lib/tag-tree.ts";

export const plural = (n: number, one: string, many = `${one}s`) =>
	`${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The playlist name a tag gets in rekordbox and on a drive. */
export const tagPlaylistName = (tag: string) => tag.split(TAG_SEP).join(" › ");

export const EMPTY_SELECTION: ExportSelection = {
	playlists: [],
	tags: [],
	smart: [],
	usbMode: "add",
};
