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
	usbSerato: false,
};

/** One thing a destination can be sent: a playlist, a smart playlist, or a tag as a playlist. */
export type SelectionItem =
	| { kind: "playlist"; id: number }
	| { kind: "smart"; id: number }
	| { kind: "tag"; name: string };

export function selectionIncludes(selection: ExportSelection, item: SelectionItem): boolean {
	switch (item.kind) {
		case "playlist":
			return selection.playlists.includes(item.id);
		case "smart":
			return selection.smart.includes(item.id);
		case "tag":
			return selection.tags.includes(item.name);
	}
}

/** The selection with the item added, or taken out when it was there. */
export function toggleSelection(selection: ExportSelection, item: SelectionItem): ExportSelection {
	const on = selectionIncludes(selection, item);
	const flip = <T>(list: readonly T[], value: T) =>
		on ? list.filter((v) => v !== value) : [...list, value];
	switch (item.kind) {
		case "playlist":
			return { ...selection, playlists: flip(selection.playlists, item.id) };
		case "smart":
			return { ...selection, smart: flip(selection.smart, item.id) };
		case "tag":
			return { ...selection, tags: flip(selection.tags, item.name) };
	}
}
